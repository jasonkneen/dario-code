/**
 * Bash Tool - Execute shell commands
 *
 * This tool allows Claude to execute bash commands with security restrictions.
 * Commands are validated before execution to prevent security risks.
 */

import { z } from 'zod'

// Security: Commands that are blocked for security reasons
export const BLOCKED_COMMANDS = [
  'alias',
  'curl', 'curlie',
  'wget', 'axel', 'aria2c',
  'nc', 'telnet',
  'lynx', 'w3m', 'links',
  'httpie', 'xh', 'http-prompt',
  'chrome', 'firefox', 'safari'
]

// Input schema for the Bash tool
export const bashInputSchema = z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000)'),
  description: z.string().optional().describe('Clear, concise description of what this command does in 5-10 words'),
  run_in_background: z.boolean().optional().describe('Set to true to run this command in the background')
})

// Prompt/documentation for the Bash tool
export const BASH_PROMPT = `Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`ls\` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use \`ls foo\` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).
  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.
  - If the output exceeds 30000 characters, output will be truncated before being returned to you.
  - You can use the \`run_in_background\` parameter to run the command in the background, which allows you to continue working while the command runs.

  - Avoid using Bash with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Glob (NOT find or ls)
    - Content search: Use Grep (NOT grep or rg)
    - Read files: Use Read (NOT cat/head/tail)
    - Edit files: Use Edit (NOT sed/awk)
    - Write files: Use Write (NOT echo >/cat <<EOF)
    - Communication: Output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message.
    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`).
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.`

/**
 * Parse a command string into individual commands
 * Handles pipes, &&, ||, and ; separators
 */
export function parseCommands(command) {
  // Simple tokenizer - split on command separators
  const commands = []
  let current = ''
  let inQuote = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      current += char
      escaped = true
      continue
    }

    if (char === '"' || char === "'") {
      if (inQuote === char) {
        inQuote = null
      } else if (!inQuote) {
        inQuote = char
      }
      current += char
      continue
    }

    if (!inQuote) {
      // Check for command separators
      if (char === ';' || char === '|') {
        if (current.trim()) {
          commands.push(current.trim())
        }
        current = ''
        continue
      }

      if (char === '&' && command[i + 1] === '&') {
        if (current.trim()) {
          commands.push(current.trim())
        }
        current = ''
        i++ // Skip next &
        continue
      }
    }

    current += char
  }

  if (current.trim()) {
    commands.push(current.trim())
  }

  return commands
}

/**
 * Validate heredoc usage for command smuggling.
 *
 * A malicious model could craft a heredoc where the content contains the
 * delimiter token, terminating the heredoc early and injecting additional
 * commands. For example:
 *
 *   cat <<'EOF'
 *   hello
 *   EOF
 *   rm -rf /  ← injected after premature EOF
 *   EOF
 *
 * We detect this by extracting every heredoc block and checking whether its
 * content contains the delimiter on a line by itself (which would terminate
 * the heredoc prematurely when the shell processes it).
 *
 * @param {string} command
 * @returns {{ safe: boolean, message?: string }}
 */
export function validateHeredocs(command) {
  // Match both quoted (<<'EOF') and unquoted (<<EOF) delimiters
  const heredocPattern = /<<-?['"]?(\w+)['"]?\s*\n([\s\S]*?)^\1$/gm

  let match
  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[1]
    const body = match[2]

    // Check if the body contains a line that is exactly the delimiter
    // (possibly with leading whitespace for <<-)
    const lines = body.split('\n')
    for (const line of lines) {
      if (line.trim() === delimiter) {
        return {
          safe: false,
          message: `Heredoc body contains the delimiter '${delimiter}' — potential command injection blocked.`
        }
      }
    }
  }

  return { safe: true }
}

/**
 * Validate a command for security
 * Returns { result: boolean, message?: string }
 */
export function validateCommand(command, originalWorkingDir, currentWorkingDir, resolvePathFn) {
  // Security: validate heredoc delimiters before anything else
  const heredocCheck = validateHeredocs(command)
  if (!heredocCheck.safe) {
    return { result: false, message: heredocCheck.message }
  }

  const commands = parseCommands(command)

  for (const cmd of commands) {
    const parts = cmd.split(' ')
    const executable = parts[0]

    // Check against blocked commands
    if (executable && BLOCKED_COMMANDS.includes(executable.toLowerCase())) {
      return {
        result: false,
        message: `Command '${executable}' is not allowed for security reasons`
      }
    }

    // Check cd commands for directory traversal
    if (executable === 'cd' && parts[1]) {
      const targetDir = parts[1].replace(/^['"]|['"]$/g, '')
      const resolvedPath = resolvePathFn ? resolvePathFn(targetDir, currentWorkingDir) : targetDir

      // Ensure we're not escaping the original working directory
      if (!resolvedPath.startsWith(originalWorkingDir)) {
        return {
          result: false,
          message: `ERROR: cd to '${resolvedPath}' was blocked. For security, Open Claude Code may only change directories to child directories of the original working directory (${originalWorkingDir}) for this session.`
        }
      }
    }
  }

  return { result: true }
}

/**
 * Create the Bash tool definition
 */
export function createBashTool(dependencies) {
  const {
    executeCommand,
    getDescription,
    getCurrentDir,
    getOriginalDir,
    resolvePath,
    isAbsolutePath,
    logError,
    logEvent,
    React // For rendering
  } = dependencies

  return {
    name: 'Bash',

    async description({ command }) {
      if (getDescription) {
        try {
          return await getDescription(command)
        } catch (err) {
          logError?.(err)
          return 'Executes a bash command'
        }
      }
      return 'Executes a bash command'
    },

    async prompt() {
      return BASH_PROMPT
    },

    isReadOnly() {
      return false
    },

    inputSchema: bashInputSchema,

    userFacingName() {
      return 'Bash'
    },

    async isEnabled() {
      return true
    },

    needsPermissions() {
      return true
    },

    async validateInput({ command }) {
      return validateCommand(
        command,
        getOriginalDir(),
        getCurrentDir(),
        (target, cwd) => {
          if (isAbsolutePath(target)) return target
          return resolvePath(cwd, target)
        }
      )
    },

    renderToolUseMessage({ command } = {}) {
      // Clean up heredoc formatting for display
      if (command.includes(`"$(cat <<'EOF'`)) {
        const match = command.match(/^(.*?)"?\$\(cat <<'EOF'\n([\s\S]*?)\n\s*EOF\n\s*\)"(.*)$/)
        if (match && match[1] && match[2]) {
          const prefix = match[1]
          const content = match[2]
          const suffix = match[3] || ''
          return `${prefix.trim()} "${content.trim()}"${suffix.trim()}`
        }
      }
      return command
    },

    renderToolUseRejectedMessage() {
      // Return rejection UI component
      return React?.createElement?.('span', { style: { color: 'red' } }, 'Command rejected')
    },

    renderToolResultMessage(result, { verbose }) {
      // Return result UI component
      return React?.createElement?.('pre', null,
        result.stdout + (result.stderr ? '\n' + result.stderr : '')
      )
    },

    renderResultForAssistant({ interrupted, stdout, stderr }) {
      let output = stderr.trim()
      if (interrupted) {
        if (stderr) output += '\n'
        output += '<error>Command was aborted before completion</error>'
      }
      const hasStdout = stdout.trim() && output
      return `${stdout.trim()}${hasStdout ? '\n' : ''}${output.trim()}`
    },

    async *call({ command, timeout = 120000 }, { abortController, readFileTimestamps }) {
      let stdout = ''
      let stderr = ''

      const result = await executeCommand(command, abortController.signal, timeout)

      stdout += (result.stdout || '').trim() + '\n'
      stderr += (result.stderr || '').trim() + '\n'

      if (result.code !== 0) {
        stderr += `Exit code ${result.code}`
      }

      // Reset cwd if we've escaped the original directory
      if (getCurrentDir() !== getOriginalDir()) {
        const originalDir = getOriginalDir()
        if (!getCurrentDir().startsWith(originalDir)) {
          // Reset to original directory
          stderr = `${stderr.trim()}\nShell cwd was reset to ${originalDir}`
          logEvent?.('bash_tool_reset_to_original_dir', {})
        }
      }

      // Track file modifications
      // (Implementation would track files modified by the command)

      yield {
        type: 'result',
        resultForAssistant: this.renderResultForAssistant({
          interrupted: result.interrupted,
          stdout,
          stderr
        }),
        data: {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          interrupted: result.interrupted
        }
      }
    }
  }
}

export default createBashTool
