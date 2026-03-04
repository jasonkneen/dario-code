import fs from 'fs'
import os from 'os'
import path from 'path'

const WINDOWS_DRIVE_PATH = /^\/([a-zA-Z])(?:\/(.*))?$/
const WINDOWS_DRIVE_PREFIX_PATH = /^([a-zA-Z])[\\/](.*)$/

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function normalizeWindowsPath(input) {
  if (typeof input !== 'string') return input
  const trimmed = input.trim()
  if (!trimmed) return trimmed

  const driveMatch = trimmed.match(WINDOWS_DRIVE_PATH)
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase()
    const rest = driveMatch[2] ? driveMatch[2].replace(/\//g, '\\') : ''
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`
  }

  const drivePrefixMatch = trimmed.match(WINDOWS_DRIVE_PREFIX_PATH)
  if (drivePrefixMatch) {
    const drive = drivePrefixMatch[1].toUpperCase()
    const driveRoot = `${drive}:\\`
    if (fs.existsSync(driveRoot)) {
      const rest = drivePrefixMatch[2] ? drivePrefixMatch[2].replace(/\//g, '\\') : ''
      return rest ? `${driveRoot}${rest}` : driveRoot
    }
  }

  if (/^[a-zA-Z]:\//.test(trimmed)) {
    return trimmed.replace(/\//g, '\\')
  }

  return trimmed
}

function getWindowsShell() {
  const programFiles = normalizeWindowsPath(process.env.ProgramFiles || 'C:\\Program Files')
  const programFilesX86 = normalizeWindowsPath(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)')
  const localAppData = normalizeWindowsPath(process.env.LocalAppData || '')

  const gitBashCandidates = [
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'bash.exe')
  ]
  if (localAppData) {
    gitBashCandidates.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))
  }

  const gitBashPath = firstExistingPath(gitBashCandidates.map(normalizeWindowsPath))
  if (gitBashPath) {
    return {
      command: gitBashPath,
      args: ['-lc'],
      name: 'bash'
    }
  }

  return {
    command: normalizeWindowsPath(process.env.ComSpec) || 'cmd.exe',
    args: ['/d', '/s', '/c'],
    name: 'cmd'
  }
}

export function getShellCommand() {
  if (os.platform() === 'win32') {
    return getWindowsShell()
  }

  return {
    command: process.env.SHELL || 'sh',
    args: ['-c'],
    name: 'sh'
  }
}

export function buildShellSpawn(command) {
  const shell = getShellCommand()
  return {
    command: shell.command,
    args: [...shell.args, command],
    shellName: shell.name
  }
}
