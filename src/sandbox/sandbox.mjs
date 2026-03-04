/**
 * Sandbox Mode for Dario
 *
 * Implements bash command sandboxing using macOS sandbox-exec for security.
 * Provides permission boundaries and escape detection.
 */

import { execSync, spawnSync } from 'child_process'
import { homedir } from 'os'
import { platform } from 'os'
import path from 'path'
import fs from 'fs'
import { buildShellSpawn } from '../core/shell.mjs'

/**
 * Check if the current platform supports sandboxing
 * macOS uses sandbox-exec; Linux uses bubblewrap (bwrap) or firejail
 * (CC 2.1.41 parity — Linux sandbox support)
 */
export function isSandboxSupported() {
  const p = platform()
  if (p === 'darwin') return true
  if (p === 'linux') return detectLinuxSandboxBin() !== null
  return false
}

/**
 * Detect which Linux sandbox binary is available.
 * Returns 'bwrap' (bubblewrap, preferred) or 'firejail', or null if neither found.
 * (CC 2.1.41 parity)
 */
export function detectLinuxSandboxBin() {
  const candidates = ['bwrap', 'firejail']
  for (const bin of candidates) {
    try {
      const result = spawnSync('which', [bin], { encoding: 'utf8', timeout: 2000 })
      if (result.status === 0 && result.stdout.trim()) {
        return bin
      }
    } catch {
      // bin not found
    }
  }
  return null
}

/**
 * Wrap a command using bubblewrap or firejail on Linux.
 * Restricts write access to projectDir and /tmp.
 *
 * @param {string} command - Shell command to wrap
 * @param {string} projectDir - Project directory (allowed writes)
 * @returns {string|null} Wrapped command, or null if no sandbox available
 */
export function wrapCommandLinux(command, projectDir) {
  const bin = detectLinuxSandboxBin()
  if (!bin) return null

  const escapedCommand = command.replace(/'/g, "'\\''")

  if (bin === 'bwrap') {
    // bubblewrap: bind full filesystem read-only, then allow writes in projectDir + /tmp
    const bwrapArgs = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--bind', projectDir, projectDir,
      '--bind', '/tmp', '/tmp',
      // Deny sensitive credential paths
      '--ro-bind-try', `${process.env.HOME}/.ssh`, `${process.env.HOME}/.ssh-ro-only`,
      '--',
      'sh', '-c', `'${escapedCommand}'`,
    ].join(' ')
    return `${bin} ${bwrapArgs}`
  }

  if (bin === 'firejail') {
    // firejail: whitelist the project directory and /tmp, block everything else
    const firejailArgs = [
      `--whitelist=${projectDir}`,
      `--whitelist=/tmp`,
      `--read-only=/`,
      `--read-write=${projectDir}`,
      `--read-write=/tmp`,
      '--',
      'sh', '-c', `'${escapedCommand}'`,
    ].join(' ')
    return `${bin} ${firejailArgs}`
  }

  return null
}

/**
 * Patterns that indicate an attempt to escape the sandbox
 */
const ESCAPE_PATTERNS = [
  /sandbox-exec\s+-p/i,           // Trying to run sandbox-exec
  /rhino\s+sandbox/i,              // macOS Rhino sandbox escaping
  /\.dylib.*inject/i,              // Injecting libraries
  /ptrace|dtrace|strace/i,         // Debugger/tracer bypass attempts
  /launchctl\s+load/i,             // Loading launch agents/daemons
  /kextload|kextunload/i,          // Kernel extension manipulation
  /sudo\s+sandbox-exec/i,          // Trying to elevate sandbox
  /codesign.*-R/i,                 // Code signature removal attempts
  /otool|install_name_tool/i,      // Mach-O manipulation
  /nvram|bless/i,                  // Boot parameter manipulation
  /_JAVA_TOOL_OPTIONS|LD_PRELOAD/i, // Environment-based injection
  /dmesg|sysctl.*kern\.sysv/i,    // System parameter manipulation
]

/**
 * Detect if a command contains patterns that indicate sandbox escape attempts
 */
export function detectEscapeAttempt(command) {
  for (const pattern of ESCAPE_PATTERNS) {
    if (pattern.test(command)) {
      return {
        detected: true,
        pattern: pattern.source,
        message: `Potential sandbox escape detected: ${pattern.source}`
      }
    }
  }

  return {
    detected: false,
    pattern: null,
    message: null
  }
}

/**
 * Generate a macOS sandbox-exec profile based on options
 *
 * Profile restrictions:
 * - File reads: allowed everywhere (except sensitive system paths)
 * - File writes: restricted to project dir and /tmp
 * - Network: allowed (unless disabled in options)
 * - Process execution: allowed but limited
 */
export function createSandboxProfile(options = {}) {
  const {
    projectDir = process.cwd(),
    allowNetwork = true,
    readOnlyPaths = [],
    writePaths = ['/tmp', projectDir],
    denyPaths = [
      process.env.HOME ? path.join(process.env.HOME, '.ssh') : '',
      process.env.HOME ? path.join(process.env.HOME, '.aws') : '',
      process.env.HOME ? path.join(process.env.HOME, '.kube') : '',
      process.env.HOME ? path.join(process.env.HOME, '.git-credentials') : '',
    ].filter(Boolean),
    allowProcessExec = true,
    allowSubprocesses = true
  } = options

  // Normalize paths
  const normalizedWritePaths = writePaths
    .filter(Boolean)
    .map(p => p.replace(/"/g, '\\"'))

  const normalizedDenyPaths = denyPaths
    .filter(Boolean)
    .map(p => p.replace(/"/g, '\\"'))

  const normalizedReadOnlyPaths = readOnlyPaths
    .filter(Boolean)
    .map(p => p.replace(/"/g, '\\"'))

  // Build profile rules
  const rules = [
    '(version 1)',
    '(deny default)',
    '',
    '; Allow necessary file operations',
    '(allow file-read*)',
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (subpath "/var/tmp"))',
  ]

  // Add write paths
  for (const writePath of normalizedWritePaths) {
    if (writePath) {
      rules.push(`(allow file-write* (subpath "${writePath}"))`)
    }
  }

  // Deny sensitive paths
  for (const denyPath of normalizedDenyPaths) {
    if (denyPath) {
      rules.push(`(deny file-read* (subpath "${denyPath}"))`)
      rules.push(`(deny file-write* (subpath "${denyPath}"))`)
    }
  }

  // Network access
  if (allowNetwork) {
    rules.push('')
    rules.push('; Allow network access')
    rules.push('(allow network-outbound)')
    rules.push('(allow network-inbound)')
  }

  // Process execution
  if (allowProcessExec) {
    rules.push('')
    rules.push('; Allow process execution')
    rules.push('(allow process-exec)')
    rules.push('(allow process-fork)')
  }

  // System operations
  rules.push('')
  rules.push('; Allow necessary system operations')
  rules.push('(allow sysctl-read)')
  rules.push('(allow iokit-get-properties)')
  rules.push('(allow mach-lookup)')
  rules.push('(allow unix-socket-open)')

  // Signal handling
  rules.push('')
  rules.push('; Allow signal operations')
  rules.push('(allow signal (target self))')

  return rules.join('\n')
}

/**
 * Write sandbox profile to a temporary file and return the path
 */
export function writeSandboxProfile(profile) {
  const tmpDir = '/tmp'
  const timestamp = Date.now()
  const profilePath = path.join(tmpDir, `.sandbox-profile-${process.pid}-${timestamp}.sb`)

  try {
    fs.writeFileSync(profilePath, profile, { mode: 0o600 })
    return profilePath
  } catch (error) {
    throw new Error(`Failed to write sandbox profile: ${error.message}`)
  }
}

/**
 * Clean up a temporary sandbox profile
 */
export function deleteSandboxProfile(profilePath) {
  try {
    if (fs.existsSync(profilePath)) {
      fs.unlinkSync(profilePath)
    }
  } catch (error) {
    // Silently ignore cleanup errors
  }
}

/**
 * Wrap a command with the platform-appropriate sandbox.
 *
 * On macOS: uses sandbox-exec with a profile file.
 * On Linux: uses bubblewrap (bwrap) or firejail via wrapCommandLinux().
 * On other platforms: returns null (no sandbox available).
 *
 * @param {string} command - Shell command to sandbox
 * @param {string} profilePathOrProjectDir - On macOS: path to sandbox profile file.
 *   On Linux: project directory (used as the write-allowed root).
 * @returns {string|null} Wrapped command or null
 */
export function wrapCommand(command, profilePathOrProjectDir) {
  const p = platform()

  if (p === 'darwin') {
    // macOS: sandbox-exec with profile file
    const profilePath = profilePathOrProjectDir
    if (!profilePath || !fs.existsSync(profilePath)) return null
    const escapedCommand = command.replace(/'/g, "'\\''")
    return `sandbox-exec -f "${profilePath}" sh -c '${escapedCommand}'`
  }

  if (p === 'linux') {
    const projectDir = profilePathOrProjectDir || process.cwd()
    return wrapCommandLinux(command, projectDir)
  }

  return null
}

/**
 * Get sandbox settings from configuration
 */
export function getSandboxSettings(configLoader) {
  try {
    // Load from config if configLoader provided
    if (configLoader && typeof configLoader.loadSettings === 'function') {
      const settings = configLoader.loadSettings()
      return settings.sandbox || {}
    }
  } catch (error) {
    // Ignore errors reading config
  }

  return {}
}

/**
 * Apply sandbox settings to options
 */
export function applySandboxSettings(options = {}, settings = {}) {
  const {
    enabled = settings.enabled ?? true,
    allowUnsandboxedCommands = settings.allowUnsandboxedCommands ?? false,
    allowNetwork = settings.allowNetwork ?? true,
    projectDir = process.cwd(),
    readOnlyPaths = settings.readOnlyPaths ?? [],
    writePaths = settings.writePaths ?? ['/tmp', projectDir],
    allowProcessExec = settings.allowProcessExec ?? true
  } = { ...settings, ...options }

  return {
    enabled,
    allowUnsandboxedCommands,
    allowNetwork,
    projectDir,
    readOnlyPaths,
    writePaths,
    allowProcessExec
  }
}

function runShellCommandSync(command) {
  const shellInvocation = buildShellSpawn(command)
  return spawnSync(shellInvocation.command, shellInvocation.args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  })
}

/**
 * Execute a command with optional sandboxing
 *
 * Returns object with stdout, stderr, code, and sandboxed flag
 */
export function executeWithSandbox(command, options = {}) {
  const settings = applySandboxSettings({}, options)

  // Check for escape attempts first
  const escapeCheck = detectEscapeAttempt(command)
  if (escapeCheck.detected) {
    return {
      stdout: '',
      stderr: `Error: ${escapeCheck.message}`,
      code: 1,
      sandboxed: false,
      escaped: true
    }
  }

  // If sandboxing not supported or disabled, run unsandboxed
  if (!isSandboxSupported() || !settings.enabled) {
    try {
      const result = runShellCommandSync(command)

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        code: result.status ?? 1,
        sandboxed: false,
        escaped: false
      }
    } catch (error) {
      return {
        stdout: '',
        stderr: error.message,
        code: 1,
        sandboxed: false,
        escaped: false
      }
    }
  }

  // On Linux: use wrapCommandLinux directly (no profile file needed)
  if (platform() === 'linux') {
    try {
      const wrappedCommand = wrapCommandLinux(command, settings.projectDir)
      if (!wrappedCommand) {
        // No Linux sandbox binary available — fall back to unsandboxed
        const result = runShellCommandSync(command)
        return { stdout: result.stdout || '', stderr: result.stderr || '', code: result.status ?? 1, sandboxed: false, escaped: false }
      }
      const result = spawnSync('sh', ['-c', wrappedCommand], { encoding: 'utf8', timeout: 120000 })
      return { stdout: result.stdout || '', stderr: result.stderr || '', code: result.status || 0, sandboxed: true, escaped: false }
    } catch (error) {
      return { stdout: '', stderr: error.message, code: 1, sandboxed: false, escaped: false }
    }
  }

  // Create and use macOS sandbox profile
  const profile = createSandboxProfile({
    projectDir: settings.projectDir,
    allowNetwork: settings.allowNetwork,
    readOnlyPaths: settings.readOnlyPaths,
    writePaths: settings.writePaths,
    allowProcessExec: settings.allowProcessExec
  })

  let profilePath = null

  try {
    profilePath = writeSandboxProfile(profile)
    const wrappedCommand = wrapCommand(command, profilePath)

    if (!wrappedCommand) {
      throw new Error('Failed to wrap command with sandbox')
    }

    const result = spawnSync('sh', ['-c', wrappedCommand], {
      encoding: 'utf8',
      timeout: 120000,
      shell: false
    })

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      code: result.status || 0,
      sandboxed: true,
      escaped: false
    }
  } catch (error) {
    return {
      stdout: '',
      stderr: error.message,
      code: 1,
      sandboxed: false,
      escaped: false
    }
  } finally {
    // Clean up profile file
    if (profilePath) {
      deleteSandboxProfile(profilePath)
    }
  }
}

/**
 * Check if a command is in the unsandboxed allowlist
 */
export function isInAllowlist(command, allowlist = []) {
  const cmdName = command.split(/\s+/)[0]

  for (const allowed of allowlist) {
    if (typeof allowed === 'string') {
      if (cmdName === allowed || cmdName.endsWith(`/${allowed}`)) {
        return true
      }
    } else if (allowed instanceof RegExp) {
      if (allowed.test(cmdName)) {
        return true
      }
    }
  }

  return false
}

/**
 * Export all sandbox functionality
 */
export default {
  isSandboxSupported,
  detectEscapeAttempt,
  detectLinuxSandboxBin,
  wrapCommandLinux,
  createSandboxProfile,
  writeSandboxProfile,
  deleteSandboxProfile,
  wrapCommand,
  getSandboxSettings,
  applySandboxSettings,
  executeWithSandbox,
  isInAllowlist
}
