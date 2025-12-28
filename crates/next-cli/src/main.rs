//! Next.js CLI Wrapper
//!
//! Ultra-fast native binary that handles the restart loop for Next.js CLI.
//! Exit code 77 signals "restart needed" (e.g., config change during dev).
//!
//! This eliminates ~70ms of Node.js parent process bootstrap overhead.

use std::{
    env, fs,
    process::{Command, exit},
};

/// Exit code used by Next.js to signal restart needed
const EXIT_CODE_RESTART: i32 = 77;

fn main() {
    let args: Vec<String> = env::args().collect();

    // Get the directory where this binary lives (packages/next/bin/)
    let bin_dir = env::current_exe()
        .expect("failed to get executable path")
        .parent()
        .expect("failed to get parent directory")
        .to_path_buf();

    // Script is at ../dist/bin/next relative to bin/
    let script = bin_dir.parent().unwrap().join("dist/bin/next");

    // Build NODE_OPTIONS for dev command
    let node_options = if args.get(1).map(|s| s.as_str()) == Some("dev") {
        build_dev_node_options(&args)
    } else {
        env::var("NODE_OPTIONS").unwrap_or_default()
    };

    // Restart loop: exit code 77 means "restart me"
    loop {
        let mut cmd = Command::new("node");
        cmd.arg(&script).args(&args[1..]);

        if !node_options.is_empty() {
            cmd.env("NODE_OPTIONS", &node_options);
        }

        // macOS workaround: limit file watchers to avoid slow close
        // https://github.com/nodejs/node/issues/29949
        #[cfg(target_os = "macos")]
        if args.get(1).map(|s| s.as_str()) == Some("dev") {
            cmd.env("WATCHPACK_WATCHER_LIMIT", "20");
        }

        let status = cmd.status().expect("failed to execute node");
        let code = status.code().unwrap_or(1);

        if code != EXIT_CODE_RESTART {
            exit(code);
        }
    }
}

/// Get total system memory in MB (Linux only, returns None on other platforms)
fn get_total_memory_mb() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = fs::read_to_string("/proc/meminfo") {
            for line in content.lines() {
                if line.starts_with("MemTotal:") {
                    // Format: "MemTotal:        4287680 kB"
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(kb) = parts[1].parse::<u64>() {
                            return Some(kb / 1024); // Convert KB to MB
                        }
                    }
                }
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        None // macOS/Windows: rely on Node.js defaults or user-set NODE_OPTIONS
    }
}

/// Build NODE_OPTIONS for dev command
/// - Sets max-old-space-size to 50% of system memory (if not already set)
/// - Enables source maps (unless --disable-source-maps)
/// - Handles --inspect flag
/// - Supports CPU profiling via NEXT_CPU_PROF_DIR
fn build_dev_node_options(args: &[String]) -> String {
    let mut options: Vec<String> = Vec::new();

    // Start with existing NODE_OPTIONS
    if let Ok(existing) = env::var("NODE_OPTIONS") {
        options.push(existing);
    }

    // Set max-old-space-size to 50% of system memory if not already set
    // and NEXT_DISABLE_MEM_OVERRIDE is not set
    let has_max_old_space = options
        .iter()
        .any(|o| o.contains("max-old-space-size") || o.contains("max_old_space_size"));

    if !has_max_old_space && env::var("NEXT_DISABLE_MEM_OVERRIDE").is_err() {
        if let Some(total_mb) = get_total_memory_mb() {
            let max_old_space_mb = total_mb / 2;
            options.push(format!("--max-old-space-size={}", max_old_space_mb));
        }
    }

    // Check for --disable-source-maps flag
    let disable_source_maps = args.iter().any(|a| a == "--disable-source-maps");

    // Enable source maps by default unless disabled
    if !disable_source_maps {
        let has_source_maps = options.iter().any(|o| o.contains("enable-source-maps"));
        if !has_source_maps {
            options.push("--enable-source-maps".to_string());
        }
    }

    // Handle --inspect flag
    for (i, arg) in args.iter().enumerate() {
        if arg == "--inspect" {
            // Check if next arg is a port/address (doesn't start with -)
            let addr = args.get(i + 1).filter(|a| !a.starts_with('-'));
            if let Some(addr) = addr {
                options.push(format!("--inspect={}", addr));
            } else {
                options.push("--inspect".to_string());
            }
            break;
        } else if arg.starts_with("--inspect=") {
            options.push(arg.clone());
            break;
        }
    }

    // Support CPU profiling via NEXT_CPU_PROF_DIR environment variable
    if let Ok(cpu_prof_dir) = env::var("NEXT_CPU_PROF_DIR") {
        options.push("--cpu-prof".to_string());
        options.push(format!("--cpu-prof-dir={}", cpu_prof_dir));
    }

    options.join(" ")
}
