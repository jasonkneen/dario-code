/**
 * Dario Hooks System
 *
 * Provides lifecycle hooks that execute shell commands at specific points:
 * - PreToolUse: Before a tool is executed
 * - PostToolUse: After a tool completes
 * - SessionStart: When a new session starts
 * - SessionEnd: When a session ends
 * - PreCompact: Before context compaction
 * - SubagentStop: When a subagent stops
 * - UserPromptSubmit: When user submits a prompt
 * - PermissionRequest: When permissions are requested
 * - Notification: When notifications occur
 * - Stop: When Claude is about to stop (for final actions)
 * - PostToolUseFailure: When a tool call fails with an error
 * - SubagentStart: Before a subagent is spawned
 * - InstructionsLoaded: After CLAUDE.md content is loaded
 * - ConfigChange: When hook configuration changes mid-session
 * - WorktreeCreate: When a git worktree is created for an agent
 * - WorktreeRemove: When a git worktree is removed
 *
 * Configuration in settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       {
 *         "matcher": "Bash",
 *         "command": ["./validate-bash.sh"],
 *         "timeout": 5000
 *       }
 *     ],
 *     "PostToolUse": [...],
 *     "SessionStart": [...],
 *     "SessionEnd": [...],
 *     "PreCompact": [...],
 *     "SubagentStop": [...],
 *     "UserPromptSubmit": [...],
 *     "PermissionRequest": [...],
 *     "Notification": [...],
 *     "Stop": [...]
 *   }
 * }
 */

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import { loadSettings } from './config.mjs'

// Hook types
export const HookType = {
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  SESSION_START: 'SessionStart',
  SESSION_END: 'SessionEnd',
  PRE_COMPACT: 'PreCompact',
  SUBAGENT_STOP: 'SubagentStop',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  PERMISSION_REQUEST: 'PermissionRequest',
  NOTIFICATION: 'Notification',
  STOP: 'Stop',
  SETUP: 'Setup',
  TEAMMATE_IDLE: 'TeammateIdle',
  TASK_COMPLETED: 'TaskCompleted',
  POST_TOOL_USE_FAILURE: 'PostToolUseFailure',
  SUBAGENT_START: 'SubagentStart',
  INSTRUCTIONS_LOADED: 'InstructionsLoaded',
  CONFIG_CHANGE: 'ConfigChange',
  WORKTREE_CREATE: 'WorktreeCreate',
  WORKTREE_REMOVE: 'WorktreeRemove'
}

// Hook result actions
export const HookAction = {
  CONTINUE: 'continue',   // Proceed with normal execution
  BLOCK: 'block',         // Block the tool execution (PreToolUse only)
  MODIFY: 'modify',       // Modify the input (PreToolUse only)
  SKIP: 'skip'           // Skip showing output
}

// Default timeout for hooks (10 seconds)
const DEFAULT_TIMEOUT = 10000

// Module-level once tracker — survives across runHooks calls within a session
const _onceTracker = new Set()

/**
 * Generate a unique key for a handler (used by once tracking and dedup).
 * @param {Object} handler - Normalized handler object
 * @returns {string} Unique key
 */
function handlerKey(handler) {
  return `${handler.type}:${JSON.stringify(handler.command)}`
}

/**
 * Check if a once-handler has already run this session.
 * @param {Object} handler - Normalized handler
 * @returns {boolean}
 */
function hasRunOnce(handler) {
  return _onceTracker.has(handlerKey(handler))
}

/**
 * Mark a once-handler as having run this session.
 * @param {Object} handler - Normalized handler
 */
function markAsRun(handler) {
  _onceTracker.add(handlerKey(handler))
}

/**
 * Clear once-tracking state (for tests and session end).
 */
export function clearOnceState() {
  _onceTracker.clear()
}

// ============================================================================
// HOOK-06: Session snapshot — cache hooks at session start
// ============================================================================

// Module-level snapshot cache
let _hookCache = null
let _hookHash = null

/**
 * Compute a SHA-256 hash of the given data.
 * @param {*} data - Data to hash (will be JSON-stringified)
 * @returns {string} Hex hash
 */
function computeHash(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

/**
 * Capture a snapshot of normalized hooks at session start.
 * Calls loadHooks() once, stores the result and its hash.
 * @returns {Object} The cached normalized hooks
 */
export function snapshotHooks() {
  _hookCache = loadHooks()
  _hookHash = computeHash(_hookCache)
  return _hookCache
}

/**
 * Return the cached hook snapshot.
 * @returns {Object|null} Cached hooks, or null if snapshotHooks() was never called
 */
export function getCachedHooks() {
  return _hookCache
}

/**
 * Check whether the on-disk hook config has changed since the snapshot.
 * Loads hooks fresh, computes hash, compares to snapshot hash.
 * @returns {{ changed: boolean, warning: string|null }}
 */
export async function checkHookIntegrity() {
  if (_hookHash === null) {
    return { changed: false, warning: null }
  }

  const freshHooks = loadHooks()
  const freshHash = computeHash(freshHooks)

  if (freshHash !== _hookHash) {
    // Fire ConfigChange hook when config has changed
    try {
      await runConfigChange({ oldHash: _hookHash, newHash: freshHash })
    } catch (e) {
      // Non-fatal
    }

    return {
      changed: true,
      warning: 'Hook configuration has changed since session start. The running session uses the original snapshot. Restart to pick up changes.',
    }
  }

  return { changed: false, warning: null }
}

/**
 * Clear the hook snapshot cache (for tests and session end).
 */
export function clearHookSnapshot() {
  _hookCache = null
  _hookHash = null
}

/**
 * Normalize a single handler entry, ensuring all fields have defaults.
 * @param {Object} handler - Raw handler from config
 * @returns {Object} Normalized handler
 */
function normalizeHandler(handler) {
  const command = handler.command
    ? (Array.isArray(handler.command) ? handler.command : [handler.command])
    : []

  return {
    type: handler.type || 'command',
    command,
    ...(handler.timeout != null ? { timeout: handler.timeout } : {}),
    ...(handler.environment != null ? { environment: handler.environment } : {}),
    statusMessage: handler.statusMessage ?? null,
    once: handler.once ?? false,
    async: handler.async ?? false,
    url: handler.url ?? null,
    prompt: handler.prompt ?? null,
    model: handler.model ?? null,
  }
}

/**
 * Normalize hook config entries from flat or nested format to canonical nested.
 *
 * Flat format:  { matcher, command, timeout, ... }
 * Nested format: { matcher, hooks: [{ type, command, ... }] }
 *
 * Both normalize to: { matcher, hooks: [{ type, command, statusMessage, once, ... }] }
 *
 * @param {Array|null|undefined} hookList - Array of hook entries
 * @returns {Array} Normalized entries in nested format
 */
export function normalizeHookConfig(hookList) {
  if (!hookList || !Array.isArray(hookList) || hookList.length === 0) {
    return []
  }

  return hookList.map(entry => {
    // Already nested format
    if (entry.hooks && Array.isArray(entry.hooks)) {
      return {
        matcher: entry.matcher,
        hooks: entry.hooks.map(normalizeHandler),
      }
    }

    // Flat format — convert to nested
    return {
      matcher: entry.matcher,
      hooks: [normalizeHandler(entry)],
    }
  })
}

/**
 * Deduplicate handlers by type + command identity.
 * Keeps the first occurrence of each unique handler.
 *
 * @param {Array} handlers - Array of normalized handler objects
 * @returns {Array} Deduplicated handlers
 */
export function deduplicateHandlers(handlers) {
  const seen = new Set()
  const result = []

  for (const handler of handlers) {
    const key = handlerKey(handler)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(handler)
    }
  }

  return result
}

/**
 * Load hooks configuration from settings, normalized to nested format.
 * @returns {Object} Map of event type to normalized hook entries
 */
export function loadHooks() {
  const settings = loadSettings()
  const rawHooks = settings.hooks || {}
  const normalized = {}

  for (const [eventType, hookList] of Object.entries(rawHooks)) {
    normalized[eventType] = normalizeHookConfig(hookList)
  }

  return normalized
}

/**
 * Check if a hook matches the given criteria
 */
function matchesHook(hook, context) {
  if (!hook.matcher) return true

  const matchers = Array.isArray(hook.matcher) ? hook.matcher : [hook.matcher]

  // Check tool name matcher
  if (context.toolName) {
    for (const matcher of matchers) {
      // Exact match
      if (matcher === context.toolName) return true

      // Glob-like patterns (simple)
      if (matcher.includes('*')) {
        const regex = new RegExp('^' + matcher.replace(/\*/g, '.*') + '$')
        if (regex.test(context.toolName)) return true
      }

      // Regex pattern
      if (matcher.startsWith('/') && matcher.endsWith('/')) {
        try {
          const regex = new RegExp(matcher.slice(1, -1))
          if (regex.test(context.toolName)) return true
        } catch (e) {
          // Invalid regex, skip
        }
      }
    }
    return false
  }

  return true
}

/**
 * Execute a hook command
 */
async function executeHook(hook, context, verbose = false) {
  const command = Array.isArray(hook.command) ? hook.command : [hook.command]
  const timeout = hook.timeout || DEFAULT_TIMEOUT

  // Build environment variables
  const env = {
    ...process.env,
    ...hook.environment,
    HOOK_TYPE: context.hookType,
    TOOL_NAME: context.toolName || '',
    TOOL_INPUT: context.input ? JSON.stringify(context.input) : '',
    TOOL_OUTPUT: context.output ? JSON.stringify(context.output) : '',
    SESSION_ID: context.sessionId || '',
    MESSAGE_ID: context.messageId || '',
    WORKING_DIR: process.cwd(),
    HOME_DIR: os.homedir()
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false

    if (verbose) {
      console.error(`[Hook] Executing: ${command.join(' ')}`)
    }

    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    })

    // Send input as JSON to stdin
    if (context.input) {
      child.stdin.write(JSON.stringify(context.input))
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    const timeoutId = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timeoutId)

      if (timedOut) {
        if (verbose) {
          console.error(`[Hook] Timed out after ${timeout}ms`)
        }
        resolve({
          success: false,
          action: HookAction.CONTINUE,
          error: `Hook timed out after ${timeout}ms`
        })
        return
      }

      // Parse hook response
      let result = {
        success: code === 0,
        action: HookAction.CONTINUE,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code
      }

      // Try to parse JSON response from stdout
      if (stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout.trim())
          if (parsed.action) result.action = parsed.action
          if (parsed.message) result.message = parsed.message
          if (parsed.modifiedInput) result.modifiedInput = parsed.modifiedInput
          if (parsed.reason) result.reason = parsed.reason
        } catch (e) {
          // Not JSON, use as message
          result.message = stdout.trim()
        }
      }

      // Non-zero exit code means block (for PreToolUse)
      if (code !== 0 && context.hookType === HookType.PRE_TOOL_USE) {
        result.action = HookAction.BLOCK
        result.reason = stderr.trim() || `Hook exited with code ${code}`
      }

      if (verbose) {
        console.error(`[Hook] Completed with code ${code}, action: ${result.action}`)
      }

      resolve(result)
    })

    child.on('error', (err) => {
      clearTimeout(timeoutId)
      if (verbose) {
        console.error(`[Hook] Error: ${err.message}`)
      }
      resolve({
        success: false,
        action: HookAction.CONTINUE,
        error: err.message
      })
    })
  })
}

/**
 * Execute an HTTP webhook hook.
 * POSTs event JSON to handler.url (falls back to handler.command[0]).
 * Uses AbortController for timeout.
 * @param {Object} handler - Normalized handler with url field
 * @param {Object} context - Execution context
 * @param {boolean} verbose
 * @returns {Promise<Object>} Hook result
 */
export async function executeHttpHook(handler, context, verbose = false) {
  const url = handler.url || (handler.command && handler.command[0])
  const timeout = handler.timeout || DEFAULT_TIMEOUT

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    if (verbose) {
      process.stderr.write(`[Hook] HTTP POST to: ${url}\n`)
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hookType: context.hookType,
        toolName: context.toolName || null,
        input: context.input || null,
        output: context.output || null,
        sessionId: context.sessionId || null,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    const body = await response.json()
    return {
      success: response.ok,
      action: body.action || 'continue',
      message: body.message || null,
      reason: body.reason || null,
      modifiedInput: body.modifiedInput || null,
    }
  } catch (err) {
    clearTimeout(timeoutId)
    if (verbose) {
      process.stderr.write(`[Hook] HTTP hook error: ${err.message}\n`)
    }
    return { success: false, action: 'continue', error: err.message }
  }
}

/**
 * Execute a prompt-based hook.
 * Sends handler.prompt (falls back to handler.command[0]) to Claude for allow/deny.
 * @param {Object} handler - Normalized handler with prompt field
 * @param {Object} context - Execution context
 * @param {boolean} verbose
 * @returns {Promise<Object>} Hook result
 */
export async function executePromptHook(handler, context, verbose = false) {
  try {
    const { getClient } = await import('../api/client.mjs')
    const client = await getClient()

    const promptText = handler.prompt || (handler.command && handler.command[0])
    const model = handler.model || 'claude-haiku-4-5-20251001'
    const contextJson = JSON.stringify({
      hookType: context.hookType,
      toolName: context.toolName,
      input: context.input,
    })

    if (verbose) {
      process.stderr.write(`[Hook] Prompt hook using model: ${model}\n`)
    }

    const response = await client.messages.create({
      model,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `${promptText}\n\nContext:\n${contextJson}\n\nRespond with JSON: {"decision": "allow"} or {"decision": "deny", "reason": "..."}`,
      }],
    })

    const text = response.content[0].text
    const parsed = JSON.parse(text)
    return {
      success: true,
      action: parsed.decision === 'deny' ? 'block' : 'continue',
      reason: parsed.reason || null,
      message: text,
    }
  } catch (err) {
    if (verbose) {
      process.stderr.write(`[Hook] Prompt hook error: ${err.message}\n`)
    }
    return { success: false, action: 'continue', error: err.message }
  }
}

/**
 * Execute an agent hook.
 * Spawns a read-only subagent (EXPLORE type) with handler.command[0] as system prompt.
 * @param {Object} handler - Normalized handler
 * @param {Object} context - Execution context
 * @param {boolean} verbose
 * @returns {Promise<Object>} Hook result
 */
export async function executeAgentHook(handler, context, verbose = false) {
  try {
    const { createAgentConfig, spawnAgent, AgentType } = await import('../agents/subagent.mjs')
    const config = createAgentConfig({
      type: AgentType.EXPLORE,
      systemPrompt: handler.command[0],
      maxTokens: 2048,
      timeout: handler.timeout || DEFAULT_TIMEOUT,
    })

    if (verbose) {
      process.stderr.write(`[Hook] Spawning agent hook with prompt: ${handler.command[0]}\n`)
    }

    const result = await spawnAgent(config, JSON.stringify(context), context)
    return {
      success: true,
      action: 'continue',
      message: result.message,
    }
  } catch (err) {
    if (verbose) {
      process.stderr.write(`[Hook] Agent hook error: ${err.message}\n`)
    }
    return { success: false, action: 'continue', error: err.message }
  }
}

/**
 * Dispatch a single normalized handler.
 * Routes by handler.type: http, prompt, agent, or command (default).
 * Handles async mode for command-type hooks (fire-and-forget).
 * @param {Object} handler - Normalized handler
 * @param {Object} context - Execution context
 * @param {boolean} verbose
 * @returns {Promise<Object>} Hook result
 */
export async function dispatchHook(handler, context, verbose = false) {
  // Handle async mode (fire-and-forget) for command type only
  if (handler.async && (handler.type === 'command' || !handler.type)) {
    const hookObj = {
      command: handler.command,
      timeout: handler.timeout,
      environment: handler.environment,
    }
    executeHook(hookObj, context, verbose).catch(err => {
      if (verbose) {
        process.stderr.write(`[Hook] Async error: ${err.message}\n`)
      }
    })
    const result = { success: true, action: 'continue' }
    if (handler.statusMessage) {
      result.statusMessage = handler.statusMessage
    }
    return result
  }

  let result

  switch (handler.type) {
    case 'http':
      result = await executeHttpHook(handler, context, verbose)
      break
    case 'prompt':
      result = await executePromptHook(handler, context, verbose)
      break
    case 'agent':
      result = await executeAgentHook(handler, context, verbose)
      break
    case 'command':
    default: {
      const hookObj = {
        command: handler.command,
        timeout: handler.timeout,
        environment: handler.environment,
      }
      result = await executeHook(hookObj, context, verbose)
      break
    }
  }

  // Attach statusMessage to result for downstream consumers
  if (handler.statusMessage) {
    result.statusMessage = handler.statusMessage
  }

  return result
}

/**
 * Run all matching hooks for a given event.
 * Handles normalized (nested) format with dedup and once filtering.
 */
export async function runHooks(hookType, context, verbose = false) {
  const hooks = getCachedHooks() || loadHooks()
  const hookList = hooks[hookType] || []

  const results = []
  let finalAction = HookAction.CONTINUE
  let modifiedInput = context.input

  // Phase 1: filter by matcher, collect all handlers
  let allHandlers = []
  for (const entry of hookList) {
    if (!matchesHook(entry, { ...context, hookType })) {
      continue
    }

    if (entry.hooks && Array.isArray(entry.hooks)) {
      allHandlers.push(...entry.hooks)
    }
  }

  // Phase 2: deduplicate
  allHandlers = deduplicateHandlers(allHandlers)

  // Phase 3: execute each handler (respecting once flag)
  for (const handler of allHandlers) {
    // Skip once-handlers that already ran
    if (handler.once && hasRunOnce(handler)) {
      continue
    }

    const result = await dispatchHook(handler, { ...context, hookType, input: modifiedInput }, verbose)
    results.push(result)

    // Mark once-handlers as run
    if (handler.once) {
      markAsRun(handler)
    }

    // Process result
    if (result.action === HookAction.BLOCK) {
      finalAction = HookAction.BLOCK
      break
    }

    if (result.action === HookAction.MODIFY && result.modifiedInput) {
      modifiedInput = result.modifiedInput
    }
  }

  return {
    action: finalAction,
    results,
    modifiedInput: modifiedInput !== context.input ? modifiedInput : null
  }
}

/**
 * Helper for PreToolUse hooks
 * Returns { allowed: boolean, reason?: string, modifiedInput?: any }
 */
export async function runPreToolUse(toolName, input, context = {}, verbose = false) {
  const result = await runHooks(HookType.PRE_TOOL_USE, {
    toolName,
    input,
    ...context
  }, verbose)

  return {
    allowed: result.action !== HookAction.BLOCK,
    reason: result.results.find(r => r.reason)?.reason,
    modifiedInput: result.modifiedInput,
    message: result.results.find(r => r.message)?.message
  }
}

/**
 * Helper for PostToolUse hooks
 */
export async function runPostToolUse(toolName, input, output, context = {}, verbose = false) {
  return runHooks(HookType.POST_TOOL_USE, {
    toolName,
    input,
    output,
    ...context
  }, verbose)
}

/**
 * Helper for SessionStart hooks
 */
export async function runSessionStart(sessionId, context = {}, verbose = false) {
  // Capture hook snapshot at session start (HOOK-06)
  snapshotHooks()

  return runHooks(HookType.SESSION_START, {
    sessionId,
    ...context
  }, verbose)
}

/**
 * Helper for Notification hooks
 */
export async function runNotification(message, context = {}, verbose = false) {
  return runHooks(HookType.NOTIFICATION, {
    message,
    ...context
  }, verbose)
}

/**
 * Helper for Stop hooks
 */
export async function runStop(context = {}, verbose = false) {
  return runHooks(HookType.STOP, context, verbose)
}

/**
 * Helper for SessionEnd hooks
 */
export async function runSessionEnd(sessionId, context = {}, verbose = false) {
  return runHooks(HookType.SESSION_END, {
    sessionId,
    ...context
  }, verbose)
}

/**
 * Helper for PreCompact hooks
 */
export async function runPreCompact(context = {}, verbose = false) {
  return runHooks(HookType.PRE_COMPACT, context, verbose)
}

/**
 * Helper for SubagentStop hooks
 */
export async function runSubagentStop(agentId, result, context = {}, verbose = false) {
  return runHooks(HookType.SUBAGENT_STOP, {
    agentId,
    result,
    ...context
  }, verbose)
}

/**
 * Helper for UserPromptSubmit hooks
 * Can modify/block the prompt before submission
 */
export async function runUserPromptSubmit(prompt, context = {}, verbose = false) {
  const hookResult = await runHooks(HookType.USER_PROMPT_SUBMIT, {
    prompt,
    input: prompt,
    ...context
  }, verbose)

  return {
    allowed: hookResult.action !== HookAction.BLOCK,
    reason: hookResult.results.find(r => r.reason)?.reason,
    modifiedPrompt: hookResult.modifiedInput,
    message: hookResult.results.find(r => r.message)?.message
  }
}

/**
 * Helper for PermissionRequest hooks
 * Can auto-approve or deny permissions
 */
export async function runPermissionRequest(permission, context = {}, verbose = false) {
  const hookResult = await runHooks(HookType.PERMISSION_REQUEST, {
    permission,
    ...context
  }, verbose)

  return {
    allowed: hookResult.action !== HookAction.BLOCK,
    reason: hookResult.results.find(r => r.reason)?.reason,
    message: hookResult.results.find(r => r.message)?.message
  }
}

/**
 * Helper for Setup hooks (triggered by --init, --init-only, --maintenance)
 */
export async function runSetupHooks(context = {}, verbose = false) {
  return runHooks(HookType.SETUP, context, verbose)
}

/**
 * Helper for TaskCompleted hooks
 */
export async function runTaskCompleted(taskId, result, context = {}, verbose = false) {
  return runHooks(HookType.TASK_COMPLETED, {
    taskId,
    result,
    ...context
  }, verbose)
}

/**
 * Helper for TeammateIdle hooks
 */
export async function runTeammateIdle(agentId, context = {}, verbose = false) {
  return runHooks(HookType.TEAMMATE_IDLE, {
    agentId,
    ...context
  }, verbose)
}

/**
 * Helper for PostToolUseFailure hooks
 * Fires when a tool call fails with an error
 */
export async function runPostToolUseFailure(toolName, input, error, context = {}, verbose = false) {
  return runHooks(HookType.POST_TOOL_USE_FAILURE, {
    toolName,
    input,
    error: error instanceof Error ? error.message : String(error),
    ...context
  }, verbose)
}

/**
 * Helper for SubagentStart hooks
 * Fires before a subagent is spawned; can block spawn if hook returns block action
 */
export async function runSubagentStart(agentConfig, context = {}, verbose = false) {
  return runHooks(HookType.SUBAGENT_START, {
    agentConfig,
    ...context
  }, verbose)
}

/**
 * Helper for InstructionsLoaded hooks
 * Fires after CLAUDE.md content is loaded
 */
export async function runInstructionsLoaded(instructions, context = {}, verbose = false) {
  return runHooks(HookType.INSTRUCTIONS_LOADED, {
    instructions,
    ...context
  }, verbose)
}

// Re-entrancy guard for ConfigChange
let _firingConfigChange = false

/**
 * Helper for ConfigChange hooks
 * Fires when hook config changes are detected; can return block action.
 * Has re-entrancy guard to prevent infinite loops.
 */
export async function runConfigChange(context = {}, verbose = false) {
  if (_firingConfigChange) {
    return { action: 'continue', results: [], modifiedInput: null }
  }
  _firingConfigChange = true
  try {
    return await runHooks(HookType.CONFIG_CHANGE, context, verbose)
  } finally {
    _firingConfigChange = false
  }
}

/**
 * Helper for WorktreeCreate hooks
 * Fires after a git worktree is created
 */
export async function runWorktreeCreate(worktreePath, context = {}, verbose = false) {
  return runHooks(HookType.WORKTREE_CREATE, {
    worktreePath,
    ...context
  }, verbose)
}

/**
 * Helper for WorktreeRemove hooks
 * Fires before a git worktree is removed
 */
export async function runWorktreeRemove(worktreePath, context = {}, verbose = false) {
  return runHooks(HookType.WORKTREE_REMOVE, {
    worktreePath,
    ...context
  }, verbose)
}

/**
 * Create a hook configuration
 */
export function createHook(options) {
  return {
    matcher: options.matcher,
    command: options.command,
    timeout: options.timeout || DEFAULT_TIMEOUT,
    environment: options.environment || {}
  }
}

export default {
  HookType,
  HookAction,
  loadHooks,
  runHooks,
  runPreToolUse,
  runPostToolUse,
  runSessionStart,
  runSessionEnd,
  runPreCompact,
  runSubagentStop,
  runUserPromptSubmit,
  runPermissionRequest,
  runNotification,
  runStop,
  createHook,
  normalizeHookConfig,
  deduplicateHandlers,
  clearOnceState,
  snapshotHooks,
  getCachedHooks,
  checkHookIntegrity,
  clearHookSnapshot,
  executeHttpHook,
  executePromptHook,
  executeAgentHook,
  dispatchHook,
  runPostToolUseFailure,
  runSubagentStart,
  runInstructionsLoaded,
  runConfigChange,
  runWorktreeCreate,
  runWorktreeRemove,
}
