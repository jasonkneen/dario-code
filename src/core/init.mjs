/**
 * Dario Core Initialization Module
 *
 * This module provides the readable implementations of the core initialization
 * functions found in cli.mjs lines 1-315. These functions handle:
 *
 * 1. Environment variable loading from .env files
 * 2. Process exit handlers for cleanup hooks
 * 3. Global API namespace setup (__dario and __darioHooks)
 *
 * which are expanded here with full documentation and error handling.
 *
 * @module core/init
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Import hook system
import { runStop, runPreToolUse, runPostToolUse, runPostToolUseFailure, runSessionStart, HookAction } from './hooks.mjs'

/**
 * Load environment variables from a .env file
 *
 * This function reads a .env file and populates process.env with its values.
 * It follows standard .env file conventions:
 * - Lines starting with # are treated as comments
 * - Empty lines are ignored
 * - Values can be quoted with single or double quotes
 * - Existing environment variables are NOT overwritten
 *
 * This is the readable version of _loadEnvFile from cli.mjs line 7-22.
 *
 * @param {string} envPath - Absolute path to the .env file
 * @returns {Object} Object containing loaded variables and any parsing errors
 *
 * @example
 * loadEnvFile('/path/to/project/.env')
 * // Loads variables like ANTHROPIC_API_KEY, CLAUDE_MODEL, etc.
 */
export function loadEnvFile(envPath) {
  const result = {
    loaded: [],
    skipped: [],
    errors: []
  }

  // Check if file exists
  if (!existsSync(envPath)) {
    return result
  }

  try {
    const content = readFileSync(envPath, 'utf8')
    const lines = content.split('\n')

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum]
      const trimmed = line.trim()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }

      // Find the first = sign
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) {
        result.errors.push({
          line: lineNum + 1,
          content: line,
          error: 'No = sign found'
        })
        continue
      }

      // Extract key and value
      const key = trimmed.slice(0, eqIndex).trim()
      let value = trimmed.slice(eqIndex + 1).trim()

      // Validate key
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        result.errors.push({
          line: lineNum + 1,
          content: line,
          error: `Invalid variable name: ${key}`
        })
        continue
      }

      // Strip surrounding quotes (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }

      // Only set if not already defined (existing env vars take precedence)
      if (process.env[key] === undefined) {
        process.env[key] = value
        result.loaded.push({ key, source: envPath })
      } else {
        result.skipped.push({ key, reason: 'Already defined in environment' })
      }
    }
  } catch (err) {
    result.errors.push({
      line: 0,
      content: '',
      error: `Failed to read file: ${err.message}`
    })
  }

  return result
}

/**
 * Load all .env files in priority order
 *
 * Files are loaded in this order (first wins for each variable):
 * 1. Current working directory .env
 * 2. ~/.dario/.env
 * 3. ~/.env
 *
 * This matches the behavior in cli.mjs lines 23-25.
 *
 * @param {string} [cwd=process.cwd()] - Current working directory
 * @returns {Object} Combined results from all loaded files
 *
 * @example
 * const result = loadAllEnvFiles()
 */
export function loadAllEnvFiles(cwd = process.cwd()) {
  const home = homedir()
  const results = {
    files: [],
    loaded: [],
    skipped: [],
    errors: []
  }

  // Load in priority order
  const envPaths = [
    join(cwd, '.env'),
    join(home, '.dario', '.env'),
    join(home, '.env')
  ]

  for (const envPath of envPaths) {
    const fileResult = loadEnvFile(envPath)

    if (fileResult.loaded.length > 0 || fileResult.errors.length > 0) {
      results.files.push(envPath)
    }

    results.loaded.push(...fileResult.loaded)
    results.skipped.push(...fileResult.skipped)
    results.errors.push(...fileResult.errors)
  }

  return results
}

/**
 * State tracking for stop hooks
 * Ensures hooks only run once during shutdown
 */
let stopHooksRan = false

/**
 * Run cleanup hooks on process exit
 *
 * This function runs the Stop hooks when the process is about to exit.
 * It ensures hooks only run once, even if multiple exit signals are received.
 *
 * This is the readable version of _runStopHooks from cli.mjs lines 105-117.
 *
 * @param {Object} [options={}] - Exit context options
 * @param {string} [options.exitReason='normal'] - Reason for exit (normal, signal, error)
 * @param {string} [options.signal] - The signal that triggered exit (SIGINT, SIGTERM)
 * @param {Error} [options.error] - Any error that caused the exit
 * @param {boolean} [verbose=false] - Enable verbose logging
 * @returns {Promise<void>}
 *
 * @example
 * process.on('SIGINT', async () => {
 *   await runStopHooks({ exitReason: 'signal', signal: 'SIGINT' })
 *   process.exit(0)
 * })
 */
export async function runStopHooks(options = {}, verbose = false) {
  // Prevent running multiple times
  if (stopHooksRan) {
    return
  }
  stopHooksRan = true

  const {
    exitReason = 'normal',
    signal = null,
    error = null
  } = options

  try {
    await runStop({
      exitReason,
      signal,
      error: error ? error.message : null
    }, verbose)
  } catch (e) {
    // Ignore errors during shutdown
    // We don't want a failing hook to prevent process exit
    if (verbose) {
      console.error('[Stop Hooks] Error during shutdown:', e.message)
    }
  }
}

/**
 * Reset the stop hooks state (for testing)
 */
export function resetStopHooksState() {
  stopHooksRan = false
}

/**
 * Register process exit handlers
 *
 * Sets up handlers for process exit events that run the stop hooks.
 * Handles: beforeExit, SIGINT (Ctrl+C), SIGTERM
 *
 * This corresponds to cli.mjs lines 115-117.
 *
 * @param {boolean} [verbose=false] - Enable verbose logging
 *
 * @example
 * registerExitHandlers(true) // Enable debug logging
 */
export function registerExitHandlers(verbose = false) {
  // Normal exit
  process.on('beforeExit', () => runStopHooks({ exitReason: 'normal' }, verbose))

  // Ctrl+C
  process.on('SIGINT', async () => {
    await runStopHooks({ exitReason: 'signal', signal: 'SIGINT' }, verbose)
    process.exit(0)
  })

  // Kill signal
  process.on('SIGTERM', async () => {
    await runStopHooks({ exitReason: 'signal', signal: 'SIGTERM' }, verbose)
    process.exit(0)
  })

  if (verbose) {
  }
}

/**
 * Global Hooks API
 *
 * This object provides the hook functions for tool integration.
 * It corresponds to globalThis.__darioHooks in cli.mjs lines 119-144.
 *
 * The API is exposed globally for use by tools and plugins that need
 * to check permissions or notify about tool execution.
 *
 * @typedef {Object} DarioHooksAPI
 * @property {Function} runPreToolUse - Run pre-tool-use hooks
 * @property {Function} runPostToolUse - Run post-tool-use hooks
 * @property {Function} runSessionStart - Run session start hooks
 * @property {Function} runStop - Run stop hooks
 * @property {Object} HookAction - Hook action constants
 * @property {Function} checkToolAllowed - Helper to check if tool is allowed
 * @property {Function} notifyToolComplete - Helper to notify tool completion
 */
export const darioHooksAPI = {
  runPreToolUse,
  runPostToolUse,
  runSessionStart,
  runStop,
  HookAction,

  /**
   * Check if a tool should be allowed to execute
   *
   * This is a helper function that runs PreToolUse hooks and returns
   * a simple result indicating whether the tool should proceed.
   *
   * @param {string} toolName - Name of the tool
   * @param {Object} input - Tool input parameters
   * @param {boolean} [verbose=false] - Enable verbose logging
   * @returns {Promise<{allowed: boolean, reason?: string, modifiedInput?: Object}>}
   *
   * @example
   * const result = await checkToolAllowed('Bash', { command: 'rm -rf /' })
   * if (!result.allowed) {
   * }
   */
  async checkToolAllowed(toolName, input, verbose = false) {
    try {
      const result = await runPreToolUse(toolName, input, {}, verbose)
      return result
    } catch (e) {
      if (verbose) {
        console.error('[Hook] PreToolUse error:', e.message)
      }
      // Default to allowing on hook errors
      return { allowed: true }
    }
  },

  /**
   * Notify that a tool has completed execution
   *
   * This is a helper function that runs PostToolUse hooks to notify
   * about tool completion. Errors are silently ignored.
   *
   * @param {string} toolName - Name of the tool
   * @param {Object} input - Tool input parameters
   * @param {*} output - Tool output/result
   * @param {boolean} [verbose=false] - Enable verbose logging
   * @returns {Promise<void>}
   *
   * @example
   * await notifyToolComplete('Read', { file_path: '/foo/bar.txt' }, fileContents)
   */
  async notifyToolComplete(toolName, input, output, verbose = false) {
    try {
      await runPostToolUse(toolName, input, output, {}, verbose)
    } catch (e) {
      if (verbose) {
        console.error('[Hook] PostToolUse error:', e.message)
      }
    }
  },

  /**
   * Notify that a tool execution failed
   *
   * Runs PostToolUseFailure hooks. Errors are silently ignored.
   *
   * @param {string} toolName - Name of the tool
   * @param {Object} input - Tool input parameters
   * @param {Error|string} error - The error that occurred
   * @param {boolean} [verbose=false] - Enable verbose logging
   * @returns {Promise<void>}
   */
  async notifyToolFailure(toolName, input, error, verbose = false) {
    try {
      await runPostToolUseFailure(toolName, input, error, {}, verbose)
    } catch (e) {
      if (verbose) {
        console.error('[Hook] PostToolUseFailure error:', e.message)
      }
    }
  }
}

/**
 * Initialize the Dario global namespace
 *
 * This function sets up the globalThis.__dario and globalThis.__darioHooks
 * objects that provide the runtime API for tools, plugins, and integrations.
 *
 * The structure matches cli.mjs lines 119-315.
 *
 * @param {Object} subsystems - All imported subsystems to expose
 * @returns {Object} The initialized __dario object
 *
 * @example
 * const api = initializeGlobalAPI({
 *   plan: planModule,
 *   agents: agentsModule,
 *   tasks: tasksModule
 * })
 */
export function initializeGlobalAPI(subsystems = {}) {
  // Set up hooks API first
  globalThis.__darioHooks = darioHooksAPI

  // Set up main API namespace
  globalThis.__dario = {
    hooks: globalThis.__darioHooks,

    // Plan mode management
    plan: subsystems.plan || {},

    // Subagent system
    agents: subsystems.agents || {},

    // Status line UI
    statusline: subsystems.statusline || {},

    // Sandbox mode
    sandbox: subsystems.sandbox || {},

    // Background tasks
    tasks: subsystems.tasks || {},

    // Session management
    session: subsystems.session || {},

    // Todo management
    todos: subsystems.todos || {},

    // Plugin system
    plugins: subsystems.plugins || {},

    // Keyboard shortcuts
    keyboard: subsystems.keyboard || {},

    // @-mentions
    mentions: subsystems.mentions || {},

    // Web search
    websearch: subsystems.websearch || {},

    // Tools
    tools: subsystems.tools || {},

    // API client
    api: subsystems.api || {},

    // Auth system
    auth: subsystems.auth || {},

    // CLI module
    cli: subsystems.cli || {},

    // Config module
    config: subsystems.config || {},

    // Terminal module
    terminal: subsystems.terminal || {},

    // Core utilities
    core: subsystems.core || {},

    // Git utilities
    git: subsystems.git || {},

    // File/search utilities
    utils: subsystems.utils || {},

    // Sessions
    sessions: subsystems.sessions || {},

    // WASM UI
    wasm: subsystems.wasm || {},

    // Integration layer
    integration: subsystems.integration || {},

    // Tool override system
    toolOverrides: new Map(),

    /**
     * Register a tool override
     *
     *
     * @param {string} toolName - Name of the tool to override
     * @param {Object} readableTool - The readable tool implementation
     */
    registerToolOverride(toolName, readableTool) {
      this.toolOverrides.set(toolName, readableTool)
    },

    /**
     * Unregister a tool override
     *
     * @param {string} toolName - Name of the tool to unregister
     */
    unregisterToolOverride(toolName) {
      this.toolOverrides.delete(toolName)
    },

    /**
     * Get a tool override if one exists
     *
     * @param {string} toolName - Name of the tool
     * @returns {Object|undefined} The override or undefined
     */
    getToolOverride(toolName) {
      return this.toolOverrides.get(toolName)
    },

    /**
     * Check if a tool has an override registered
     *
     * @param {string} toolName - Name of the tool
     * @returns {boolean}
     */
    hasToolOverride(toolName) {
      return this.toolOverrides.has(toolName)
    },

    /**
     * Wrap a tool to use its override if available
     *
     * @param {Object} originalTool - The original tool
     * @returns {Object} Wrapped tool that uses override if available
     */
    wrapTool(originalTool) {
      const self = this
      return {
        ...originalTool,
        async *call(input, context) {
          const override = self.toolOverrides.get(originalTool.name)
          if (override && typeof override.call === 'function') {
            yield* override.call(input, context)
          } else {
            yield* originalTool.call(input, context)
          }
        }
      }
    },

    /**
     * Apply all overrides to a tools array
     *
     * @param {Array} tools - Array of tools
     * @returns {Array} Tools with overrides applied
     */
    applyOverrides(tools) {
      return tools.map(tool =>
        this.hasToolOverride(tool.name) ? this.wrapTool(tool) : tool
      )
    }
  }

  return globalThis.__dario
}

/**
 * Full initialization routine
 *
 * Runs all initialization steps in order:
 * 1. Load .env files
 * 2. Register exit handlers
 * 3. Initialize global API
 *
 * @param {Object} options - Initialization options
 * @param {boolean} [options.verbose=false] - Enable verbose logging
 * @param {Object} [options.subsystems={}] - Subsystems to expose in global API
 * @returns {Object} Initialization results
 *
 * @example
 * const result = await initialize({
 *   verbose: process.env.DEBUG === 'true',
 *   subsystems: {
 *     plan: planModule,
 *     agents: agentsModule
 *   }
 * })
 */
export async function initialize(options = {}) {
  const {
    verbose = process.env.DEBUG === 'true',
    subsystems = {}
  } = options

  const result = {
    envLoaded: null,
    exitHandlersRegistered: false,
    globalAPIInitialized: false
  }

  // Step 1: Load .env files
  result.envLoaded = loadAllEnvFiles()

  if (verbose) {
    for (const file of result.envLoaded.files) {
    }
  }

  // Step 2: Register exit handlers
  registerExitHandlers(verbose)
  result.exitHandlersRegistered = true

  // Step 3: Initialize global API
  initializeGlobalAPI(subsystems)
  result.globalAPIInitialized = true

  if (verbose) {
  }

  return result
}

export default {
  loadEnvFile,
  loadAllEnvFiles,
  runStopHooks,
  resetStopHooksState,
  registerExitHandlers,
  darioHooksAPI,
  initializeGlobalAPI,
  initialize
}
