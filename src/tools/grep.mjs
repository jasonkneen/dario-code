/**
 * Grep Tool - Fast content search using ripgrep
 *
 * This tool allows Claude to search file contents using regular expressions.
 * Uses ripgrep (rg) for fast searching across any codebase size.
 * Results are sorted by modification time (most recent first).
 */

import { z } from 'zod'

// Configuration constants
export const MAX_RESULTS = 100

// Input schema for the Grep tool
export const grepInputSchema = z.strictObject({
  pattern: z.string().describe('The regular expression pattern to search for in file contents'),
  path: z.string().optional().describe('File or directory to search in (rg PATH). Defaults to current working directory.'),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
  type: z.string().optional().describe('File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".'),
  '-i': z.boolean().optional().describe('Case insensitive search (rg -i)'),
  '-n': z.boolean().optional().describe('Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.'),
  '-A': z.number().optional().describe('Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.'),
  '-B': z.number().optional().describe('Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.'),
  '-C': z.number().optional().describe('Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.'),
  head_limit: z.number().optional().describe('Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes.'),
  offset: z.number().optional().describe('Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.'),
  multiline: z.boolean().optional().describe('Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.')
})

// Prompt/documentation for the Grep tool
export const GREP_PROMPT = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Task tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`

/**
 * Build ripgrep arguments from options
 */
export function buildRipgrepArgs(pattern, options = {}) {
  const args = []

  // Case insensitive
  if (options['-i']) {
    args.push('-i')
  }

  // Output mode
  if (options.output_mode === 'files_with_matches' || !options.output_mode) {
    args.push('-l')
  } else if (options.output_mode === 'count') {
    args.push('-c')
  }

  // Line numbers (default true for content mode)
  if (options.output_mode === 'content' && options['-n'] !== false) {
    args.push('-n')
  }

  // Context lines
  if (options.output_mode === 'content') {
    if (options['-A']) args.push('-A', String(options['-A']))
    if (options['-B']) args.push('-B', String(options['-B']))
    if (options['-C']) args.push('-C', String(options['-C']))
  }

  // Glob filter
  if (options.glob) {
    args.push('--glob', options.glob)
  }

  // File type - use --type-add to define it first, so unknown
  // extensions (e.g. "mjs") don't fail with "unrecognized file type"
  if (options.type) {
    args.push('--type-add', `${options.type}:*.${options.type}`, '--type', options.type)
  }

  // Multiline mode
  if (options.multiline) {
    args.push('-U', '--multiline-dotall')
  }

  // Add the pattern
  args.push(pattern)

  return args
}

/**
 * Create the Grep tool definition
 */
export function createGrepTool(dependencies) {
  const {
    fs,
    path,
    getCurrentDir,
    resolvePath,
    isInAllowedDirectory,
    runRipgrep,
    getFileStats,
    logError,
    React
  } = dependencies

  return {
    name: 'GrepTool', // Internal name

    async description() {
      return GREP_PROMPT
    },

    userFacingName() {
      return 'Grep'
    },

    inputSchema: grepInputSchema,

    isReadOnly() {
      return true
    },

    async isEnabled() {
      return true
    },

    needsPermissions({ path: searchPath }) {
      return !isInAllowedDirectory?.(searchPath || getCurrentDir())
    },

    async prompt() {
      return GREP_PROMPT
    },

    renderToolUseMessage({ pattern, path: searchPath, glob } = {}, { verbose } = {}) {
      const cwd = getCurrentDir()
      let absolutePath, relativePath

      if (searchPath) {
        absolutePath = path.isAbsolute(searchPath)
          ? searchPath
          : path.resolve(cwd, searchPath)
        relativePath = path.relative(cwd, absolutePath)
      }

      let msg = `pattern: "${pattern}"`
      if (relativePath || verbose) {
        msg += `, path: "${verbose ? absolutePath : relativePath}"`
      }
      if (glob) {
        msg += `, glob: "${glob}"`
      }

      return msg
    },

    renderToolUseRejectedMessage() {
      if (!React) return null
      return React.createElement('span', { style: { color: 'red' } }, 'Grep search rejected')
    },

    renderToolResultMessage(result) {
      if (!React) return null

      // Handle string result
      const data = typeof result === 'string' ? { numFiles: 0, filenames: [] } : result

      return React.createElement('div', {
        style: { justifyContent: 'space-between', width: '100%' }
      },
        React.createElement('div', { style: { flexDirection: 'row' } },
          React.createElement('span', null, '  ⎿  Found '),
          React.createElement('span', { style: { fontWeight: 'bold' } }, data.numFiles, ' '),
          React.createElement('span', null, data.numFiles === 0 || data.numFiles > 1 ? 'files' : 'file')
        )
      )
    },

    renderResultForAssistant({ numFiles, filenames }) {
      if (numFiles === 0) {
        return 'No files found'
      }

      let output = `Found ${numFiles} file${numFiles === 1 ? '' : 's'}\n${filenames.slice(0, MAX_RESULTS).join('\n')}`

      if (numFiles > MAX_RESULTS) {
        output += '\n(Results are truncated. Consider using a more specific path or pattern.)'
      }

      return output
    },

    async *call({ pattern, path: searchPath, glob, ...options }, { abortController }) {
      const startTime = Date.now()
      const cwd = getCurrentDir()
      const targetDir = resolvePath(searchPath) || cwd

      // Build ripgrep arguments
      const args = buildRipgrepArgs(pattern, { glob, ...options })

      // Run ripgrep
      const matchingFiles = await runRipgrep(args, targetDir, abortController.signal)

      // Get file stats for sorting by modification time
      // getFileStats is synchronous (statSync), so wrap in try/catch instead of .catch()
      const fileStats = matchingFiles.map(file => {
        try {
          return getFileStats(file)
        } catch {
          return { mtimeMs: 0 }
        }
      })

      // Sort by modification time (most recent first), then by name
      const sortedFiles = matchingFiles
        .map((file, index) => [file, fileStats[index]])
        .sort((a, b) => {
          const timeDiff = (b[1].mtimeMs || 0) - (a[1].mtimeMs || 0)
          if (timeDiff === 0) {
            return a[0].localeCompare(b[0])
          }
          return timeDiff
        })
        .map(item => item[0])

      const result = {
        filenames: sortedFiles,
        durationMs: Date.now() - startTime,
        numFiles: sortedFiles.length
      }

      yield {
        type: 'result',
        resultForAssistant: this.renderResultForAssistant(result),
        data: result
      }
    }
  }
}

export default createGrepTool
