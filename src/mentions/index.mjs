/**
 * Mentions Module for Dario
 *
 * Handles @-mention support for files and images in user prompts.
 * Features:
 * - @file detection and resolution
 * - Glob pattern support for multiple files
 * - Tab completion for file paths
 * - Image paste from clipboard
 * - Automatic content injection into messages
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { glob } from 'glob'
import { fileExists, readFile, resolvePath, getCurrentDir, formatBytes, truncateContent } from '../core/utils.mjs'
import { getWindowsClipboardImagePng } from './windows-clipboard.mjs'

/**
 * @mention pattern regex
 * Matches: @path/to/file, @./relative/file, @~/home/file, @glob-patterns
 */
const MENTION_PATTERN = /@([\w~./*-]+)/g

/**
 * Parse mentions from user input
 * Returns array of mention objects with path and type
 */
export function parseMentions(input) {
  const mentions = []
  let match

  while ((match = MENTION_PATTERN.exec(input)) !== null) {
    mentions.push({
      fullMatch: match[0],
      path: match[1],
      startIndex: match.index,
      endIndex: match.index + match[0].length
    })
  }

  return mentions
}

/**
 * Resolve a single @mention to file(s)
 * Handles: absolute paths, relative paths, home directory, glob patterns
 */
export async function resolveMention(mentionPath, basePath = getCurrentDir()) {
  // Expand home directory
  let resolvedPath = mentionPath.replace(/^~/, os.homedir())

  // Check if it's a glob pattern
  if (resolvedPath.includes('*') || resolvedPath.includes('?')) {
    return resolveGlobPattern(resolvedPath, basePath)
  }

  // Otherwise treat as single file path
  resolvedPath = resolvePath(resolvedPath, basePath)

  if (!fileExists(resolvedPath)) {
    return {
      success: false,
      error: `File not found: ${mentionPath}`,
      path: mentionPath
    }
  }

  try {
    const content = readFile(resolvedPath)
    const stats = fs.statSync(resolvedPath)

    return {
      success: true,
      path: resolvedPath,
      displayPath: mentionPath,
      content,
      size: stats.size,
      isDirectory: false,
      files: [resolvedPath]
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to read file: ${error.message}`,
      path: mentionPath
    }
  }
}

/**
 * Resolve glob pattern to multiple files
 */
async function resolveGlobPattern(pattern, basePath = getCurrentDir()) {
  try {
    const matches = await glob(pattern, {
      cwd: basePath,
      absolute: false,
      follow: true,
      nodir: true
    })

    if (matches.length === 0) {
      return {
        success: false,
        error: `No files matching pattern: ${pattern}`,
        path: pattern
      }
    }

    // Limit to reasonable number of files
    const MAX_FILES = 50
    const truncated = matches.length > MAX_FILES
    if (matches.length > MAX_FILES) {
      matches.length = MAX_FILES
    }

    const files = matches.map(f => path.resolve(basePath, f))

    return {
      success: true,
      path: pattern,
      displayPath: pattern,
      files,
      count: matches.length,
      truncated
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to resolve glob pattern: ${error.message}`,
      path: pattern
    }
  }
}

/**
 * Process all mentions in user input
 * Returns processed input with mentions replaced and list of resolved files
 */
export async function processMentions(input, basePath = getCurrentDir()) {
  const mentions = parseMentions(input)

  if (mentions.length === 0) {
    return {
      input,
      mentions: [],
      files: [],
      warnings: []
    }
  }

  const results = {
    mentions: [],
    files: [],
    warnings: [],
    attachments: []
  }

  // Resolve all mentions
  for (const mention of mentions) {
    const resolved = await resolveMention(mention.path, basePath)
    results.mentions.push(resolved)

    if (resolved.success) {
      if (resolved.files) {
        results.files.push(...resolved.files)
      }
    } else {
      results.warnings.push(resolved.error)
    }
  }

  return results
}

/**
 * Format resolved mentions for display
 */
export function formatMentionsSummary(results) {
  if (results.mentions.length === 0) {
    return ''
  }

  let summary = '\n-- Files included --\n'

  for (const mention of results.mentions) {
    if (mention.success) {
      if (mention.count !== undefined) {
        summary += `${mention.displayPath} (${mention.count} files)\n`
      } else {
        const size = formatBytes(mention.size)
        const lines = mention.content.split('\n').length
        summary += `${mention.displayPath} (${size}, ${lines} lines)\n`
      }
    }
  }

  if (results.warnings.length > 0) {
    summary += '\n-- Issues --\n'
    for (const warning of results.warnings) {
      summary += `⚠ ${warning}\n`
    }
  }

  return summary
}

/**
 * Create mention context to inject into messages
 * Reads all resolved files and creates formatted context
 */
export async function createMentionContext(results) {
  if (results.files.length === 0) {
    return ''
  }

  let context = '\n\n-- @mention References --\n'

  for (const filePath of results.files) {
    try {
      let content = readFile(filePath)
      const { content: truncated, truncated: wasTruncated, totalLines } = truncateContent(content, 2000)

      const relativePath = path.relative(getCurrentDir(), filePath)
      context += `\n### ${relativePath}\n\`\`\`\n${truncated}\n\`\`\``

      if (wasTruncated) {
        context += `\n(File truncated: showing 2000 of ${totalLines} lines)`
      }

      context += '\n'
    } catch (error) {
      context += `\n### ${filePath}\nError reading file: ${error.message}\n`
    }
  }

  return context
}

/**
 * Tab completion for file paths after @
 * Returns suggestions for files/directories matching the partial path
 */
export function getTabCompletions(partial, basePath = getCurrentDir()) {
  const suggestions = []

  try {
    // Handle home directory expansion
    let searchPath = partial.replace(/^~/, os.homedir())

    // If it ends with *, remove it for directory listing
    const hasGlobSuffix = searchPath.includes('*')
    if (hasGlobSuffix) {
      searchPath = searchPath.replace(/\*.*$/, '')
    }

    // Determine if we're searching in a directory or a partial filename
    let dir, prefix
    if (searchPath.endsWith('/')) {
      dir = searchPath
      prefix = ''
    } else {
      dir = path.dirname(searchPath)
      prefix = path.basename(searchPath)
    }

    // Resolve directory
    dir = resolvePath(dir, basePath)
    if (!fileExists(dir) || !fs.statSync(dir).isDirectory()) {
      return suggestions
    }

    // List directory contents
    const entries = fs.readdirSync(dir)

    // Filter by prefix and sort
    for (const entry of entries) {
      if (entry.startsWith(prefix) && !entry.startsWith('.')) {
        const fullPath = path.join(dir, entry)
        const stats = fs.statSync(fullPath)

        suggestions.push({
          label: entry,
          path: fullPath,
          isDirectory: stats.isDirectory,
          suffix: stats.isDirectory ? '/' : ''
        })
      }
    }

    // Sort directories first, then alphabetically
    suggestions.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return b.isDirectory - a.isDirectory
      }
      return a.label.localeCompare(b.label)
    })
  } catch (error) {
    // Silently fail for tab completion
  }

  return suggestions
}

/**
 * Parse image from clipboard (Node.js implementation)
 * Requires xclip on Linux, pbpaste on macOS, and @napi-rs/clipboard on Windows
 */
export async function getImageFromClipboard() {

  try {
    let clipboardData

    if (os.platform() === 'darwin') {
      // macOS
      clipboardData = Buffer.from(execSync('pbpaste'))
    } else if (os.platform() === 'linux') {
      // Linux
      try {
        clipboardData = execSync('xclip -selection clipboard -t image/png -o')
      } catch {
        return null // Not an image
      }
    } else if (os.platform() === 'win32') {
      const winImage = await getWindowsClipboardImagePng()
      if (!winImage) return null
      return {
        data: winImage.data,
        type: winImage.type,
        size: winImage.size
      }
    }

    // Check if it looks like image data
    if (!clipboardData || clipboardData.length < 100) {
      return null
    }

    // Detect image type by magic bytes
    let imageType = 'unknown'
    if (clipboardData[0] === 0xff && clipboardData[1] === 0xd8) {
      imageType = 'jpeg'
    } else if (clipboardData[0] === 0x89 && clipboardData[1] === 0x50) {
      imageType = 'png'
    } else if (clipboardData[0] === 0x47 && clipboardData[1] === 0x49) {
      imageType = 'gif'
    } else {
      return null
    }

    return {
      data: clipboardData,
      type: imageType,
      size: clipboardData.length
    }
  } catch (error) {
    return null
  }
}

/**
 * Save image to temporary file
 */
export function saveImageToTemp(imageData) {
  const tempDir = os.tmpdir()
  const fileName = `clipboard-${Date.now()}.${imageData.type}`
  const filePath = path.join(tempDir, fileName)

  try {
    fs.writeFileSync(filePath, imageData.data)
    return {
      success: true,
      path: filePath,
      size: imageData.size,
      type: imageData.type
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to save image: ${error.message}`
    }
  }
}

/**
 * Detect and include image from clipboard in message
 */
export async function processClipboardImage() {
  const imageData = await getImageFromClipboard()

  if (!imageData) {
    return null
  }

  return saveImageToTemp(imageData)
}

/**
 * Export all functions as default object
 */
export default {
  parseMentions,
  resolveMention,
  processMentions,
  formatMentionsSummary,
  createMentionContext,
  getTabCompletions,
  getImageFromClipboard,
  saveImageToTemp,
  processClipboardImage
}
