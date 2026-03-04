/**
 * Dario Bootstrap Integration
 *
 * tool modules with the main cli.mjs runtime.
 *
 * Usage in cli.mjs:
 *   import { initializeTools, getTools } from './src/integration/bootstrap.mjs'
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn, exec } from 'child_process'
import { glob } from 'glob'
import { buildShellSpawn } from '../core/shell.mjs'

// Import core utilities
import {
  getCurrentDir,
  setCurrentDir,
  getOriginalDir,
  setOriginalDir,
  isAbsolutePath,
  resolvePath,
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
  formatDuration
} from '../core/utils.mjs'

// Import tool creators
import {
  createBashTool,
  createReadTool,
  createEditTool,
  createWriteTool,
  createGlobTool,
  createGrepTool,
  createTaskTool,
  createTodoWriteTool,
  createTodoReadTool,
  createWebFetchTool,
  createWebSearchTool,
  createNotebookEditTool,
  createAskUserQuestionTool,
  createLspTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createSkillTool,
  createMultiEditTool
} from '../tools/index.mjs'

// Shared state
let toolInstances = null
let initialized = false

/**
 * Create dependencies object for tool factories
 */
function createDependencies(options = {}) {
  const {
    React = null,
    executeCommand = defaultExecuteCommand,
    globFiles = defaultGlobFiles,
    runRipgrep = defaultRunRipgrep,
    processImage = defaultProcessImage,
    logError = console.error,
    logEvent = () => {}
  } = options

  return {
    fs,
    path,
    os,
    getCurrentDir,
    getOriginalDir,
    resolvePath,
    isAbsolutePath,
    fileExists,
    isDirectory,
    getFileStats,
    findSimilarFile,
    isInAllowedDirectory,
    detectEncoding,
    detectLineEnding,
    getDefaultLineEnding,
    normalizeLineEndings,
    writeFile,
    executeCommand,
    globFiles,
    runRipgrep,
    processImage,
    logError,
    logEvent,
    React,
    getAvailableTools: async (_dangerouslySkipPermissions) => getToolsArray()
  }
}

/**
 * Default command executor using child_process
 * Signature matches Bash tool expectation: (command, signal, timeout)
 */
async function defaultExecuteCommand(command, signal, timeout = 120000) {
  const cwd = getCurrentDir()
  const shellInvocation = buildShellSpawn(command)

  return new Promise((resolve, reject) => {
    const child = spawn(shellInvocation.command, shellInvocation.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    const timeoutId = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
    }, timeout)

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true
        child.kill('SIGTERM')
      })
    }

    child.on('close', (code) => {
      clearTimeout(timeoutId)
      resolve({
        code: killed ? 143 : code, // 143 = SIGTERM exit code
        stdout,
        stderr,
        interrupted: killed
      })
    })

    child.on('error', (err) => {
      clearTimeout(timeoutId)
      reject(err)
    })
  })
}

/**
 * Default glob implementation
 * Signature: (pattern, targetDir, options, signal) to match Glob tool's call
 */
async function defaultGlobFiles(pattern, targetDir, options = {}, signal) {
  const {
    limit = 100,
    offset = 0,
    ignore = ['**/node_modules/**', '**/.git/**']
  } = options

  const cwd = targetDir || getCurrentDir()

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
 * Default ripgrep implementation
 */
async function defaultRunRipgrep(pattern, options = {}) {
  const {
    path: searchPath = getCurrentDir(),
    glob: fileGlob,
    type,
    outputMode = 'files_with_matches',
    caseInsensitive = false,
    contextBefore = 0,
    contextAfter = 0,
    contextAround = 0,
    multiline = false,
    showLineNumbers = true,
    limit
  } = options

  // Build ripgrep arguments
  const args = ['--color=never']

  if (outputMode === 'files_with_matches') {
    args.push('-l')
  } else if (outputMode === 'count') {
    args.push('-c')
  }

  if (caseInsensitive) args.push('-i')
  if (multiline) args.push('-U', '--multiline-dotall')
  if (showLineNumbers && outputMode === 'content') args.push('-n')
  if (fileGlob) args.push('--glob', fileGlob)
  if (type) args.push('--type', type)
  if (contextBefore > 0) args.push('-B', String(contextBefore))
  if (contextAfter > 0) args.push('-A', String(contextAfter))
  if (contextAround > 0) args.push('-C', String(contextAround))

  args.push(pattern, searchPath)

  return new Promise((resolve, reject) => {
    exec(`rg ${args.map(a => `"${a}"`).join(' ')}`, {
      cwd: searchPath,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      // ripgrep returns exit code 1 when no matches found
      if (error && error.code !== 1) {
        reject(error)
        return
      }

      const lines = stdout.trim().split('\n').filter(Boolean)

      if (limit && lines.length > limit) {
        resolve(lines.slice(0, limit))
      } else {
        resolve(lines)
      }
    })
  })
}

/**
 * Default image processor (returns base64)
 */
async function defaultProcessImage(filePath) {
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

/**
 * Initialize all tools with dependencies
 */
export function initializeTools(options = {}) {
  if (initialized && toolInstances) {
    return toolInstances
  }

  const deps = createDependencies(options)

  toolInstances = {
    Bash: createBashTool(deps),
    Read: createReadTool(deps),
    Edit: createEditTool(deps),
    Write: createWriteTool(deps),
    Glob: createGlobTool(deps),
    Grep: createGrepTool(deps),
    Task: createTaskTool(deps),
    TodoWrite: createTodoWriteTool(deps),
    TodoRead: createTodoReadTool(deps),
    WebFetch: createWebFetchTool(deps),
    WebSearch: createWebSearchTool(deps),
    NotebookEdit: createNotebookEditTool(deps),
    AskUserQuestion: createAskUserQuestionTool(deps),
    LSP: createLspTool(deps),
    EnterPlanMode: createEnterPlanModeTool(deps),
    ExitPlanMode: createExitPlanModeTool(deps),
    Skill: createSkillTool(deps),
    MultiEdit: createMultiEditTool(deps)
  }

  // Set initial working directory
  setOriginalDir(process.cwd())
  setCurrentDir(process.cwd())

  initialized = true
  return toolInstances
}

/**
 * Get initialized tools
 */
export function getTools() {
  if (!initialized) {
    return initializeTools()
  }
  return toolInstances
}

/**
 * Get tool by name
 */
export function getTool(name) {
  const tools = getTools()
  return tools[name] || null
}

/**
 * Get all tools as array (for compatibility with cli.mjs)
 */
export function getToolsArray() {
  const tools = getTools()
  return Object.values(tools)
}

/**
 * Reset tools (for testing)
 */
export function resetTools() {
  toolInstances = null
  initialized = false
}

export default {
  initializeTools,
  getTools,
  getTool,
  getToolsArray,
  resetTools,
  createDependencies
}
