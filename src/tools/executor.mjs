/**
 * Tool execution module
 * Handles calling tools and managing tool permissions
 */

import { formatError } from '../utils/errors.mjs'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Path to approved tools config
const APPROVED_TOOLS_PATH = path.join(os.homedir(), '.openclaude', 'approved-tools.json')

/**
 * Execute a tool use
 *
 * @param {Object} toolUse - The tool_use content block
 * @param {Array} tools - Available tools (array of tool objects with name and call methods)
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} - Tool result with content and is_error
 */
export async function executeToolUse(toolUse, tools, options = {}) {
  // Find tool by name (check both internal name and user-facing name)
  const tool = tools.find((t) =>
    t.name === toolUse.name ||
    (typeof t.userFacingName === 'function' && t.userFacingName(toolUse.input || {}) === toolUse.name)
  )

  if (!tool) {
    return {
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true
    }
  }

  try {
    // Validate input schema if present
    if (tool.inputSchema && typeof tool.inputSchema.safeParse === 'function') {
      const validation = tool.inputSchema.safeParse(toolUse.input)
      if (!validation.success) {
        return {
          content: `Invalid tool input: ${JSON.stringify(validation.error.errors)}`,
          is_error: true
        }
      }
    }

    // Build execution context (needed by validateInput and call)
    const context = {
      abortController: options.abortController || new AbortController(),
      options: {
        commands: options.commands || [],
        tools: tools,
        verbose: options.verbose || false,
        debug: options.debug || false,
        dangerouslySkipPermissions: options.dangerouslySkipPermissions || false,
        slowAndCapableModel: options.slowAndCapableModel,
        forkNumber: options.forkNumber || 0,
        messageLogName: options.messageLogName || 'unknown',
        maxThinkingTokens: options.maxThinkingTokens || 0
      },
      readFileTimestamps: options.readFileTimestamps || {},
      messageId: options.messageId
    }

    // Validate command logic (e.g., security checks)
    if (typeof tool.validateInput === 'function') {
      const validation = await tool.validateInput(toolUse.input, context)
      if (validation && !validation.result) {
        return {
          content: validation.message || 'Tool input validation failed',
          is_error: true
        }
      }
    }

    // Check permissions - interactive prompt flow
    if (!options.dangerouslySkipPermissions && typeof tool.needsPermissions === 'function' && tool.needsPermissions(toolUse.input || {})) {
      const hasPermission = await checkToolPermission(tool, toolUse.input, options)
      if (hasPermission === 'always') {
        // User chose "Always allow" - persist the approval
        const descriptor = buildToolDescriptor(tool, toolUse.input)
        approveToolUse(descriptor)
      } else if (!hasPermission) {
        return {
          content: 'Tool use rejected by user',
          is_error: false
        }
      }
    }

    // Execute tool - tools use async generators that yield progress and results
    const generator = tool.call(toolUse.input || {}, context)

    // Handle generator results (async iteration)
    if (generator && typeof generator[Symbol.asyncIterator] === 'function') {
      let finalResult = null

      for await (const item of generator) {
        // Progress updates (type: 'progress')
        if (item.type === 'progress' && options.onProgress) {
          options.onProgress(item)
        }

        // Final result (type: 'result')
        if (item.type === 'result') {
          finalResult = item
        }
      }

      if (!finalResult) {
        return {
          content: 'Tool completed but returned no result',
          is_error: false
        }
      }

      // Extract result content
      return {
        content: finalResult.resultForAssistant || JSON.stringify(finalResult.data || finalResult),
        is_error: false,
        data: finalResult.data
      }
    }

    // Handle non-generator results (shouldn't happen with proper tools)
    return {
      content: typeof generator === 'string' ? generator : JSON.stringify(generator),
      is_error: false
    }
  } catch (error) {
    return {
      content: formatError(error),
      is_error: true
    }
  }
}

/**
 * Convert a glob-style pattern string to a RegExp.
 *
 * Supported wildcards:
 *   "*"  → matches any sequence of characters
 *   "?"  → matches exactly one character
 *
 * All other characters are escaped so they match literally.
 *
 * Examples:
 *   "Bash(npm *)"  → /^Bash\(npm .*\)$/
 *   "Read"         → /^Read$/
 *   "Write(src/*)" → /^Write\(src\/.*\)$/
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let re = ''
  for (const ch of pattern) {
    if (ch === '*') {
      re += '.*'
    } else if (ch === '?') {
      re += '.'
    } else {
      // Escape all regex-special characters
      re += ch.replace(/[\\^$.|+[\]{}()\/]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * Build a descriptor string that represents a tool invocation with its
 * primary argument, used for matching against glob patterns.
 *
 *   Bash + { command: "npm install" } → "Bash(npm install)"
 *   Write + { file_path: "src/index.mjs" } → "Write(src/index.mjs)"
 *   Read (no relevant arg) → "Read"
 *
 * @param {Object} tool
 * @param {Object} input
 * @returns {string}
 */
function buildToolDescriptor(tool, input) {
  const arg = input?.command || input?.file_path || input?.path
  if (arg) {
    return `${tool.name}(${arg})`
  }
  return tool.name
}

/**
 * Test whether a descriptor string matches any entry in an approved
 * patterns list (exact or glob).
 *
 * @param {string} descriptor
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesAnyPattern(descriptor, patterns) {
  for (const pattern of patterns) {
    if (pattern === descriptor) return true
    if (globToRegExp(pattern).test(descriptor)) return true
  }
  return false
}

/**
 * Check if tool use requires and has permission.
 *
 * Resolution order:
 *   1. Check the approved-tools list on disk (glob-aware). If the bare
 *      tool name **or** the full descriptor (e.g. "Bash(npm install)")
 *      matches any approved pattern, allow immediately.
 *   2. If an interactive `onPermissionRequest` callback was supplied,
 *      delegate to it so the user can approve / deny in the TUI.
 *      The callback may return true, false, or 'always' to persist approval.
 *   3. Otherwise deny.
 *
 * @param {Object} tool - Tool instance
 * @param {Object} input - Tool input
 * @param {Object} options - Options with onPermissionRequest callback
 * @returns {Promise<boolean|'always'>}
 */
async function checkToolPermission(tool, input, options = {}) {
  const approved = getApprovedTools()
  const descriptor = buildToolDescriptor(tool, input)

  // Fast path — already approved (bare name or full descriptor)
  if (
    matchesAnyPattern(tool.name, approved) ||
    matchesAnyPattern(descriptor, approved)
  ) {
    return true
  }

  // Interactive mode — ask the user
  if (typeof options.onPermissionRequest === 'function') {
    return await options.onPermissionRequest(tool, input)
  }

  // No match and no way to ask → deny
  return false
}

/**
 * Create a default interactive permission request handler for terminal use.
 * Returns a callback suitable for options.onPermissionRequest.
 *
 * The callback prompts the user with:
 *   y = allow once, a = always allow, n = deny
 *
 * @param {Object} opts
 * @param {NodeJS.ReadStream} [opts.stdin] - Input stream (default: process.stdin)
 * @param {NodeJS.WriteStream} [opts.stderr] - Output stream (default: process.stderr)
 * @returns {Function} onPermissionRequest callback
 */
export function createInteractivePermissionHandler(opts = {}) {
  const output = opts.stderr || process.stderr
  return async (tool, input) => {
    const descriptor = buildToolDescriptor(tool, input)

    // Diff preview for Write/Edit tools (CC 2.x parity)
    await _showDiffPreviewIfApplicable(tool, input, output)

    output.write(`\n⚡ Tool permission required: ${descriptor}\n`)
    output.write('  Allow? [y]es / [a]lways / [n]o: ')

    // Read a single keypress
    const answer = await new Promise((resolve) => {
      const stdin = opts.stdin || process.stdin
      const wasRaw = stdin.isRaw
      if (stdin.setRawMode) stdin.setRawMode(true)
      stdin.resume()
      const onData = (data) => {
        stdin.removeListener('data', onData)
        if (stdin.setRawMode && wasRaw !== undefined) stdin.setRawMode(wasRaw)
        const ch = data.toString().trim().toLowerCase()
        output.write(ch + '\n')
        resolve(ch)
      }
      stdin.on('data', onData)
    })

    if (answer === 'a') return 'always'
    if (answer === 'y') return true
    return false
  }
}

/**
 * Show a compact unified diff above the permission prompt for Write/Edit tools.
 * (CC 2.x diff preview in permission prompts — parity)
 *
 * @param {Object} tool
 * @param {Object} input
 * @param {NodeJS.WriteStream} output
 */
async function _showDiffPreviewIfApplicable(tool, input, output) {
  try {
    const { generateUnifiedDiff, renderDiffColored } = await import('../utils/diff.mjs')
    const toolName = tool.name || ''

    if (toolName === 'Write' || toolName.toLowerCase() === 'write') {
      const filePath = input?.file_path
      const newContent = input?.content || input?.new_content || ''
      if (filePath && newContent) {
        let before = ''
        try { before = fs.readFileSync(filePath, 'utf-8') } catch {}
        const diff = generateUnifiedDiff(filePath, before, newContent)
        const colored = renderDiffColored(diff)
        if (colored && colored !== '  (no changes)') {
          output.write('\n' + colored + '\n')
        }
      }
    } else if (toolName === 'Edit' || toolName.toLowerCase() === 'edit') {
      const oldString = input?.old_string || ''
      const newString = input?.new_string || ''
      const filePath = input?.file_path || 'file'
      if (oldString !== newString) {
        const diff = generateUnifiedDiff(path.basename(filePath), oldString, newString)
        const colored = renderDiffColored(diff)
        if (colored && colored !== '  (no changes)') {
          output.write('\n' + colored + '\n')
        }
      }
    }
  } catch {
    // Diff preview is best-effort — never block the permission prompt
  }
}

/**
 * Synchronous convenience check: does the user have *any* approved
 * pattern that would cover this tool name?  (No input context, so only
 * bare-name or "ToolName(*)" style patterns can match.)
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function hasPermissionsToUseTool(toolName) {
  const approved = getApprovedTools()
  return matchesAnyPattern(toolName, approved)
}

/**
 * Load the approved-tools list from ~/.openclaude/approved-tools.json.
 * Returns an empty array when the file is missing or corrupt.
 *
 * @returns {string[]}
 */
export function getApprovedTools() {
  try {
    const data = fs.readFileSync(APPROVED_TOOLS_PATH, 'utf-8')
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Persist an approved-tools array to disk, creating the config directory
 * if it doesn't exist yet.
 *
 * @param {string[]} tools
 */
function saveApprovedTools(tools) {
  const dir = path.dirname(APPROVED_TOOLS_PATH)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(APPROVED_TOOLS_PATH, JSON.stringify(tools, null, 2) + '\n', 'utf-8')
}

/**
 * Add a tool name or glob pattern to the approved list.
 * Duplicates are silently ignored.
 *
 * @param {string} toolName - e.g. "Read", "Bash", or "Bash(npm *)"
 */
export function approveToolUse(toolName) {
  const approved = getApprovedTools()
  if (!approved.includes(toolName)) {
    approved.push(toolName)
    saveApprovedTools(approved)
  }
}

/**
 * Remove a tool name or glob pattern from the approved list.
 * No-op if the pattern isn't present.
 *
 * @param {string} toolName - Exact pattern string to remove
 */
export function revokeToolApproval(toolName) {
  const approved = getApprovedTools()
  const updated = approved.filter((t) => t !== toolName)
  if (updated.length !== approved.length) {
    saveApprovedTools(updated)
  }
}
