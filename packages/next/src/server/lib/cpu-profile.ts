const privateCpuProfileName = process.env.__NEXT_PRIVATE_CPU_PROFILE
const isCpuProfileEnabled = process.env.NEXT_CPU_PROF || privateCpuProfileName
const cpuProfileDir = process.env.NEXT_CPU_PROF_DIR

let session: import('inspector').Session | null = null
let profileSaved = false

if (isCpuProfileEnabled) {
  const { Session } = require('inspector') as typeof import('inspector')

  session = new Session()
  session.connect()

  session.post('Profiler.enable')
  session.post('Profiler.start')

  // Save profile on signals (for dev server)
  process.on('SIGINT', () => {
    saveCpuProfile().then(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    saveCpuProfile().then(() => process.exit(143))
  })
}

/**
 * Save the CPU profile to disk.
 * Call this before process.exit() to ensure the profile is saved.
 */
export function saveCpuProfile(): Promise<void> {
  if (!session || profileSaved || !isCpuProfileEnabled) {
    return Promise.resolve()
  }
  profileSaved = true

  return new Promise((resolve) => {
    session!.post('Profiler.stop', (error, param) => {
      if (error) {
        console.error('Cannot generate CPU profiling:', error)
        resolve()
        return
      }

      const fs = require('fs') as typeof import('fs')
      const path = require('path') as typeof import('path')

      // Generate meaningful filename
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)
      const baseName = privateCpuProfileName || 'cpu-profile'
      const filename = `${baseName}-${timestamp}.cpuprofile`

      // Determine output directory
      let outputPath: string
      if (cpuProfileDir) {
        // Ensure directory exists
        if (!fs.existsSync(cpuProfileDir)) {
          fs.mkdirSync(cpuProfileDir, { recursive: true })
        }
        outputPath = path.join(cpuProfileDir, filename)
      } else {
        outputPath = `./${filename}`
      }

      // Write profile to disk
      fs.writeFileSync(outputPath, JSON.stringify(param.profile))
      console.log(`\n\x1b[32mCPU profile saved:\x1b[0m ${outputPath}`)
      console.log('Open in Chrome DevTools → Performance tab → Load profile')
      resolve()
    })
  })
}
