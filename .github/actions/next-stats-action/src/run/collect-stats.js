const path = require('path')
const net = require('net')
const fs = require('fs/promises')
const getPort = require('get-port')
const fetch = require('node-fetch')
const glob = require('../util/glob')
const gzipSize = require('gzip-size')
const logger = require('../util/logger')
const { spawn } = require('../util/exec')
const { parse: urlParse } = require('url')
const benchmarkUrl = require('./benchmark-url')
const { statsAppDir, diffingDir, benchTitle } = require('../constants')

// Check if a port is accepting TCP connections
function checkPort(port, timeout = 100) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeout)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, 'localhost')
  })
}

// Wait for port to start accepting TCP connections
async function waitForPort(port, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) {
      return Date.now() - start
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

// Wait for HTTP server to respond
async function waitForHttp(port, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { timeout: 2000 })
      if (res.ok) {
        return Date.now() - start
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

// Run a single dev server boot benchmark
async function benchmarkDevBoot(appDevCommand, curDir, port, cleanBuild) {
  // Clean .next directory for cold start
  if (cleanBuild) {
    const nextDir = path.join(curDir, '.next')
    await fs.rm(nextDir, { recursive: true, force: true })
  }

  const startTime = Date.now()
  const devChild = spawn(appDevCommand, {
    cwd: curDir,
    env: {
      PORT: port,
    },
    stdio: 'pipe',
  })

  let exited = false
  devChild.on('exit', () => {
    exited = true
  })

  // Capture output for debugging
  devChild.stdout.on('data', (data) => process.stdout.write(data))
  devChild.stderr.on('data', (data) => process.stderr.write(data))

  // Measure time to port listening (TCP level)
  const listenTime = await waitForPort(port, 60000)

  // Measure time to HTTP ready
  let readyTime = null
  if (listenTime !== null && !exited) {
    readyTime = await waitForHttp(port, 60000)
  }

  devChild.kill()

  return {
    listenTime,
    readyTime,
  }
}

async function defaultGetRequiredFiles(nextAppDir, fileName) {
  return [fileName]
}

module.exports = async function collectStats(
  runConfig = {},
  statsConfig = {},
  fromDiff = false
) {
  const stats = {
    [benchTitle]: {},
  }
  const orderedStats = {
    [benchTitle]: {},
  }
  const curDir = fromDiff ? diffingDir : statsAppDir

  const hasPagesToFetch =
    Array.isArray(runConfig.pagesToFetch) && runConfig.pagesToFetch.length > 0

  const hasPagesToBench =
    Array.isArray(runConfig.pagesToBench) && runConfig.pagesToBench.length > 0

  // Run production start benchmark FIRST (before dev benchmark which cleans .next)
  if (
    !fromDiff &&
    statsConfig.appStartCommand &&
    (hasPagesToFetch || hasPagesToBench)
  ) {
    const port = await getPort()
    const startTime = Date.now()
    const child = spawn(statsConfig.appStartCommand, {
      cwd: curDir,
      env: {
        PORT: port,
      },
      stdio: 'pipe',
    })
    let exitCode = null
    let logStderr = true

    let serverReadyResolve
    let serverReadyResolved = false
    const serverReadyPromise = new Promise((resolve) => {
      serverReadyResolve = resolve
    })

    child.stdout.on('data', (data) => {
      if (data.toString().includes('- Local:') && !serverReadyResolved) {
        serverReadyResolved = true
        serverReadyResolve()
      }
      process.stdout.write(data)
    })
    child.stderr.on('data', (data) => logStderr && process.stderr.write(data))

    child.on('exit', (code) => {
      if (!serverReadyResolved) {
        serverReadyResolve()
        serverReadyResolved = true
      }
      exitCode = code
    })

    await serverReadyPromise
    if (!orderedStats['General']) {
      orderedStats['General'] = {}
    }
    orderedStats['General']['nextStartReadyDuration (ms)'] =
      Date.now() - startTime

    if (exitCode !== null) {
      throw new Error(
        `Failed to run \`${statsConfig.appStartCommand}\` process exited with code ${exitCode}`
      )
    }

    if (hasPagesToFetch) {
      const fetchedPagesDir = path.join(curDir, 'fetched-pages')
      await fs.mkdir(fetchedPagesDir, { recursive: true })

      for (let url of runConfig.pagesToFetch) {
        url = url.replace('$PORT', port)
        const { pathname } = urlParse(url)
        try {
          const res = await fetch(url)
          if (!res.ok) {
            throw new Error(`Failed to fetch ${url} got status: ${res.status}`)
          }
          const responseText = (await res.text()).trim()

          let fileName = pathname === '/' ? '/index' : pathname
          if (fileName.endsWith('/')) fileName = fileName.slice(0, -1)
          logger(
            `Writing file to ${path.join(fetchedPagesDir, `${fileName}.html`)}`
          )

          await fs.writeFile(
            path.join(fetchedPagesDir, `${fileName}.html`),
            responseText,
            'utf8'
          )
        } catch (err) {
          logger.error(err)
        }
      }
    }

    if (hasPagesToBench) {
      // disable stderr so we don't clobber logs while benchmarking
      // any pages that create logs
      logStderr = false

      for (let url of runConfig.pagesToBench) {
        url = url.replace('$PORT', port)
        logger(`Benchmarking ${url}`)

        const results = await benchmarkUrl(url, runConfig.benchOptions)
        logger(`Finished benchmarking ${url}`)

        const { pathname: key } = urlParse(url)
        stats[benchTitle][`${key} failed reqs`] = results.failedRequests
        stats[benchTitle][`${key} total time (seconds)`] = results.totalTime

        stats[benchTitle][`${key} avg req/sec`] = results.avgReqPerSec
      }
    }
    child.kill()
  }

  // Measure dev server boot time if configured (full matrix: cold/warm x listen/ready)
  // NOTE: This runs AFTER the production start benchmark because it cleans the .next directory
  if (!fromDiff && statsConfig.appDevCommand && statsConfig.measureDevBoot) {
    const devPort = await getPort()

    if (!orderedStats['General']) {
      orderedStats['General'] = {}
    }

    // 1. Cold start benchmark (clean .next directory)
    logger('=== Cold Start Benchmark ===')
    const coldResult = await benchmarkDevBoot(
      statsConfig.appDevCommand,
      curDir,
      devPort,
      true // clean build
    )

    if (coldResult.listenTime !== null) {
      orderedStats['General']['nextDevColdListenDuration (ms)'] =
        coldResult.listenTime
    }
    if (coldResult.readyTime !== null) {
      orderedStats['General']['nextDevColdReadyDuration (ms)'] =
        coldResult.readyTime
    }

    // 2. Warm up bytecode cache by running server for ~10 seconds
    if (coldResult.readyTime !== null) {
      logger('=== Warming up bytecode cache (10s) ===')
      const warmupChild = spawn(statsConfig.appDevCommand, {
        cwd: curDir,
        env: {
          PORT: devPort,
        },
        stdio: 'pipe',
      })

      // Wait for server to be ready
      await waitForHttp(devPort, 60000)

      // Let it run for 10 seconds to warm bytecode cache
      await new Promise((r) => setTimeout(r, 10000))

      warmupChild.kill()

      // Small delay to ensure clean shutdown
      await new Promise((r) => setTimeout(r, 500))

      // 3. Warm start benchmark (keep .next directory)
      logger('=== Warm Start Benchmark ===')
      const warmResult = await benchmarkDevBoot(
        statsConfig.appDevCommand,
        curDir,
        devPort,
        false // keep build
      )

      if (warmResult.listenTime !== null) {
        orderedStats['General']['nextDevWarmListenDuration (ms)'] =
          warmResult.listenTime
      }
      if (warmResult.readyTime !== null) {
        orderedStats['General']['nextDevWarmReadyDuration (ms)'] =
          warmResult.readyTime
      }
    }

    logger('=== Dev Boot Benchmark Complete ===')
  }

  for (const fileGroup of runConfig.filesToTrack) {
    const {
      getRequiredFiles = defaultGetRequiredFiles,
      name,
      globs,
    } = fileGroup
    const groupStats = {}
    const curFiles = new Set()

    for (const pattern of globs) {
      const results = await glob(pattern, { cwd: curDir, nodir: true })
      results.forEach((result) => curFiles.add(result))
    }

    for (const file of curFiles) {
      const fileKey = path.basename(file)
      try {
        let parsedSizeSum = 0
        let gzipSizeSum = 0
        for (const requiredFile of await getRequiredFiles(curDir, file)) {
          const absPath = path.join(curDir, requiredFile)
          const fileInfo = await fs.stat(absPath)
          parsedSizeSum += fileInfo.size
          gzipSizeSum += await gzipSize.file(absPath)
        }
        groupStats[fileKey] = parsedSizeSum
        groupStats[`${fileKey} gzip`] = gzipSizeSum
      } catch (err) {
        logger.error('Failed to get file stats', err)
      }
    }
    stats[name] = groupStats
  }

  for (const fileGroup of runConfig.filesToTrack) {
    const { name } = fileGroup
    orderedStats[name] = stats[name]
  }

  if (stats[benchTitle]) {
    orderedStats[benchTitle] = stats[benchTitle]
  }
  return orderedStats
}
