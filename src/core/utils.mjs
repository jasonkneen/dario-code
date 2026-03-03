/**
 * Core Utilities for Dario
 *
 * Shared utility functions used across all tools and modules.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

// Track original working directory
let originalWorkingDir = process.cwd()
let currentWorkingDir = process.cwd()

/**
 * Get the original working directory (set at startup)
 */
export function getOriginalDir() {
  return originalWorkingDir
}

/**
 * Set the original working directory (call once at startup)
 */
export function setOriginalDir(dir) {
  originalWorkingDir = dir
}

/**
 * Get the current working directory
 */
export function getCurrentDir() {
  return currentWorkingDir
}

/**
 * Set the current working directory
 */
export function setCurrentDir(dir) {
  currentWorkingDir = dir
}

/**
 * Check if a path is absolute
 */
export function isAbsolutePath(filePath) {
  return path.isAbsolute(filePath)
}

/**
 * Resolve a path relative to the current working directory
 */
export function resolvePath(filePath, basePath = currentWorkingDir) {
  if (!filePath) return basePath
  if (path.isAbsolute(filePath)) return filePath
  return path.resolve(basePath, filePath)
}

/**
 * Get relative path from current directory
 */
export function getRelativePath(filePath) {
  return path.relative(currentWorkingDir, filePath)
}

/**
 * Check if a file exists
 */
export function fileExists(filePath) {
  try {
    fs.accessSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Check if a path is a directory
 */
export function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

/**
 * Get file stats
 */
export function getFileStats(filePath) {
  return fs.statSync(filePath)
}

/**
 * Read file contents
 */
export function readFile(filePath, encoding = 'utf8') {
  return fs.readFileSync(filePath, encoding)
}

/**
 * Write file with encoding and line ending handling
 */
export function writeFile(filePath, content, encoding = 'utf8', lineEnding = 'LF') {
  // Normalize line endings
  let normalizedContent = content
  if (lineEnding === 'CRLF') {
    normalizedContent = content.replace(/\r?\n/g, '\r\n')
  } else {
    normalizedContent = content.replace(/\r\n/g, '\n')
  }

  fs.writeFileSync(filePath, normalizedContent, encoding)
}

/**
 * Detect file encoding (simplified - assumes UTF-8)
 */
export function detectEncoding(filePath) {
  // In a full implementation, this would detect BOM and other indicators
  return 'utf8'
}

/**
 * Detect line ending style in a file
 */
export function detectLineEnding(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    if (content.includes('\r\n')) return 'CRLF'
    return 'LF'
  } catch {
    return 'LF'
  }
}

/**
 * Get default line ending for the platform
 */
export function getDefaultLineEnding(dir) {
  // Check .editorconfig or use platform default
  const editorConfig = path.join(dir, '.editorconfig')
  if (fileExists(editorConfig)) {
    const content = readFile(editorConfig)
    if (content.includes('end_of_line = crlf')) return 'CRLF'
    if (content.includes('end_of_line = lf')) return 'LF'
  }
  return os.EOL === '\r\n' ? 'CRLF' : 'LF'
}

/**
 * Normalize line endings to LF
 */
export function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, '\n')
}

/**
 * Check if a path is within the allowed directory (security)
 */
export function isInAllowedDirectory(filePath, allowedDir = originalWorkingDir) {
  const normalizedPath = path.normalize(path.resolve(filePath))
  const normalizedAllowed = path.normalize(allowedDir)
  return normalizedPath.startsWith(normalizedAllowed)
}

/**
 * Find a similar file path (for "did you mean?" suggestions)
 */
export function findSimilarFile(filePath) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)

  if (!fileExists(dir)) return null

  try {
    const files = fs.readdirSync(dir)
    const lowerBase = base.toLowerCase()

    // Find case-insensitive match
    const match = files.find(f => f.toLowerCase() === lowerBase)
    if (match && match !== base) {
      return path.join(dir, match)
    }

    // Find similar name (simple Levenshtein-like check)
    for (const file of files) {
      if (areSimilar(base, file)) {
        return path.join(dir, file)
      }
    }
  } catch {
    // Ignore errors
  }

  return null
}

/**
 * Check if two strings are similar (for typo detection)
 */
function areSimilar(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false

  let differences = 0
  const maxLen = Math.max(a.length, b.length)

  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) differences++
    if (differences > 2) return false
  }

  return differences > 0 && differences <= 2
}

/**
 * Truncate content to a maximum number of lines
 */
export function truncateContent(content, maxLines = 2000) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) {
    return { content, truncated: false, totalLines: lines.length }
  }
  return {
    content: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    totalLines: lines.length
  }
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Safe JSON parse with default value
 */
export function safeJsonParse(str, defaultValue = null) {
  try {
    return JSON.parse(str)
  } catch {
    return defaultValue
  }
}

/**
 * Deep clone an object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * Create a debounced function
 */
export function debounce(fn, ms) {
  let timeoutId
  return (...args) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), ms)
  }
}

/**
 * Create a throttled function
 */
export function throttle(fn, ms) {
  let lastCall = 0
  return (...args) => {
    const now = Date.now()
    if (now - lastCall >= ms) {
      lastCall = now
      return fn(...args)
    }
  }
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff
 */
export async function retry(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < maxRetries - 1) {
        await sleep(initialDelay * Math.pow(2, i))
      }
    }
  }
  throw lastError
}

/**
 * Glob for files matching a pattern in a directory.
 * Used as a dependency for the Glob tool.
 *
 * @param {string} pattern - Glob pattern
 * @param {string} targetDir - Directory to search in
 * @param {Object} options - Options (limit, offset, ignore)
 * @param {AbortSignal} signal - Abort signal (unused for now)
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
export async function globFiles(pattern, targetDir, options = {}, signal) {
  const { glob } = await import('glob')
  const {
    limit = 100,
    offset = 0,
    ignore = ['**/node_modules/**', '**/.git/**']
  } = options

  const cwd = targetDir || currentWorkingDir

  const allFiles = await glob(pattern, {
    cwd,
    ignore,
    absolute: true
  })

  const truncated = allFiles.length > limit
  const files = allFiles.slice(offset, offset + limit)

  return { files, truncated }
}

/**
 * Run ripgrep search.
 * Used as a dependency for the Grep tool.
 *
 * @param {string[]} args - Ripgrep arguments (built by the Grep tool)
 * @param {string} targetDir - Directory to search in
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<string[]>} - Array of matching file paths or lines
 */
export async function runRipgrep(args, targetDir, signal) {
  const { spawn } = await import('child_process')

  return new Promise((resolve, reject) => {
    let searchPath = targetDir || currentWorkingDir
    let spawnCwd = searchPath

    // If the path is a file (not a directory), use its parent as cwd
    // to avoid ENOTDIR when spawn tries to set the working directory
    try {
      if (fs.statSync(searchPath).isFile()) {
        spawnCwd = path.dirname(searchPath)
      }
    } catch {
      // Path doesn't exist — let rg report the error
    }

    const child = spawn('rg', ['--color=never', ...args, searchPath], {
      cwd: spawnCwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill('SIGTERM')
      })
    }

    child.on('close', (code) => {
      // ripgrep returns exit code 1 when no matches found
      if (code === 1 && !stderr) {
        resolve([])
        return
      }
      if (code !== 0 && code !== 1) {
        reject(new Error(`ripgrep failed (code ${code}): ${stderr}`))
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean)
      resolve(lines)
    })

    child.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Process an image file into a base64 content block for the API
 */
export async function processImage(filePath) {
  const content = fs.readFileSync(filePath)
  const base64 = content.toString('base64')
  const ext = path.extname(filePath).toLowerCase()

  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp'
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeTypes[ext] || 'image/png',
      data: base64
    }
  }
}

export default {
  getOriginalDir,
  setOriginalDir,
  getCurrentDir,
  setCurrentDir,
  isAbsolutePath,
  resolvePath,
  getRelativePath,
  fileExists,
  isDirectory,
  getFileStats,
  readFile,
  writeFile,
  detectEncoding,
  detectLineEnding,
  getDefaultLineEnding,
  normalizeLineEndings,
  isInAllowedDirectory,
  findSimilarFile,
  truncateContent,
  formatBytes,
  formatDuration,
  safeJsonParse,
  deepClone,
  debounce,
  throttle,
  sleep,
  retry,
  processImage,
  globFiles,
  runRipgrep
}
