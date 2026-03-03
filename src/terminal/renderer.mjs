/**
 * Terminal Renderer Module
 * Converts markdown content to colorized terminal output
 *
 * - Po -> TextRenderer class
 * - VU -> renderToTerminal function
 * - EW -> renderToken function (recursive)
 * - n5 -> parseMarkdown (from marked.js)
 * - JK1 -> sanitizeMarkdown (removes context tags)
 *
 * Dependencies used in original:
 * - uu -> highlight.js for syntax highlighting
 * - j0 -> chalk for terminal colors
 * - vW -> EOL from os module
 * - n5.lexer -> marked.js lexer for tokenizing
 */

import { EOL } from 'os'

// Lazy-load dependencies to avoid import errors
let chalk = null
let hljs = null

/**
 * Get chalk module (lazy loaded)
 */
async function getChalk() {
  if (chalk) return chalk
  try {
    const module = await import('chalk')
    chalk = module.default || module
    return chalk
  } catch (error) {
    // Fallback: return identity functions
    const identity = (s) => s
    identity.dim = identity
    identity.italic = identity
    identity.bold = identity
    identity.underline = identity
    identity.blue = identity
    chalk = identity
    return chalk
  }
}

/**
 * Get highlight.js module (lazy loaded)
 */
async function getHljs() {
  if (hljs) return hljs
  try {
    const module = await import('highlight.js')
    hljs = module.default || module
    return hljs
  } catch (error) {
    // Fallback: return text as-is
    hljs = {
      supportsLanguage: () => false,
      highlight: (text) => text
    }
    return hljs
  }
}

// Initialize chalk synchronously if possible
try {
  const chalkModule = await import('chalk')
  chalk = chalkModule.default || chalkModule
} catch (e) {
  // Will use lazy loading
}

// ============================================================================
// ALPHABETIC LIST MARKERS
// ============================================================================

/**
 * Alphabetic markers for nested ordered lists (a, b, c, ...)
 * Used at list depth level 2
 */
export const ALPHA_MARKERS = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'ai', 'aj',
  'ak', 'al', 'am', 'an', 'ao', 'ap', 'aq', 'ar', 'as', 'at',
  'au', 'av', 'aw', 'ax', 'ay', 'az'
]

/**
 * Roman numeral markers for nested ordered lists (i, ii, iii, ...)
 * Used at list depth level 3
 */
export const ROMAN_MARKERS = [
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx',
  'xxi', 'xxii', 'xxiii', 'xxiv', 'xxv', 'xxvi', 'xxvii', 'xxviii',
  'xxix', 'xxx', 'xxxi', 'xxxii', 'xxxiii', 'xxxiv', 'xxxv', 'xxxvi',
  'xxxvii', 'xxxviii', 'xxxix', 'xl'
]

// ============================================================================
// TEXT RENDERER CLASS (Original: Po)
// ============================================================================

/**
 * TextRenderer - Extracts plain text from markdown tokens
 * Used for contexts where only the text content is needed
 * without any formatting or markup.
 *
 * All methods return just the text content, stripping formatting.
 */
export class TextRenderer {
  /**
   * Render strong/bold text - returns plain text
   * @param {Object} token - Token with text property
   * @returns {string} Plain text content
   */
  strong({ text }) {
    return text
  }

  /**
   * Render emphasized/italic text - returns plain text
   * @param {Object} token - Token with text property
   * @returns {string} Plain text content
   */
  em({ text }) {
    return text
  }

  /**
   * Render inline code - returns plain text
   * @param {Object} token - Token with text property
   * @returns {string} Plain text content
   */
  codespan({ text }) {
    return text
  }

  /**
   * Render deleted/strikethrough text - returns plain text
   * @param {Object} token - Token with text property
   * @returns {string} Plain text content
   */
  del({ text }) {
    return text
  }

  /**
   * Render raw HTML - returns as plain text
   * @param {Object} token - Token with text property
   * @returns {string} Plain text content
   */
  html({ text }) {
    return text
  }

  /**
   * Render plain text - passes through unchanged
   * @param {Object} token - Token with text property
   * @returns {string} Plain text content
   */
  text({ text }) {
    return text
  }

  /**
   * Render link - returns link text
   * @param {Object} token - Token with text property
   * @returns {string} Link text content
   */
  link({ text }) {
    return '' + text
  }

  /**
   * Render image - returns alt text
   * @param {Object} token - Token with text property (alt text)
   * @returns {string} Image alt text
   */
  image({ text }) {
    return '' + text
  }

  /**
   * Render line break - returns empty string
   * @returns {string} Empty string
   */
  br() {
    return ''
  }
}

// ============================================================================
// LIST MARKER FORMATTER (Original: KB9)
// ============================================================================

/**
 * Get the appropriate list marker based on nesting depth
 *
 * @param {number} depth - Current list nesting depth (0-based)
 * @param {number} index - Current item index (1-based for ordered lists)
 * @returns {string} Formatted list marker
 *
 * Depth 0-1: Numbers (1, 2, 3, ...)
 * Depth 2:   Letters (a, b, c, ...)
 * Depth 3:   Roman numerals (i, ii, iii, ...)
 * Depth 4+:  Falls back to numbers
 */
export function getListMarker(depth, index) {
  switch (depth) {
    case 0:
    case 1:
      return index.toString()
    case 2:
      return ALPHA_MARKERS[index - 1]
    case 3:
      return ROMAN_MARKERS[index - 1]
    default:
      return index.toString()
  }
}

// ============================================================================
// RECURSIVE TOKEN RENDERER (Original: EW)
// ============================================================================

/**
 * Recursively render a markdown token to terminal-formatted text
 *
 * Original function: EW(I, d = 0, G = null, Z = null)
 * Where:
 * - I = token
 * - d = depth (for list nesting)
 * - G = orderedIndex (for ordered list markers)
 * - Z = parentToken (for context, e.g., list_item parent)
 *
 * @param {Object} token - Parsed markdown token from marked.js lexer
 * @param {number} [depth=0] - Current nesting depth for lists
 * @param {number|null} [orderedIndex=null] - Index for ordered list items
 * @param {Object|null} [parentToken=null] - Parent token for context
 * @returns {string} Terminal-formatted text with ANSI colors
 *
 * Supports token types:
 * - blockquote: Dim italic text
 * - code: Syntax highlighted with highlight.js
 * - codespan: Blue inline code
 * - em: Italic text
 * - strong: Bold text
 * - heading: Various heading styles by depth
 * - hr: Horizontal rule
 * - image: Image placeholder
 * - link: Blue URL
 * - list: Ordered/unordered lists
 * - list_item: List item with marker
 * - paragraph: Text followed by newline
 * - space: Newline
 * - text: Plain text or nested tokens
 */
export function renderToken(token, depth = 0, orderedIndex = null, parentToken = null) {
  // Ensure chalk is available (use identity function if not)
  const c = chalk || ((s) => s)

  switch (token.type) {
    // Blockquote - rendered as dim italic
    // Original: j0.dim.italic((I.tokens ?? []).map((C) => EW(C)).join(""))
    case 'blockquote':
      return (c.dim?.italic || c.dim || c)(
        (token.tokens ?? []).map(childToken => renderToken(childToken)).join('')
      )

    // Code block with syntax highlighting
    // Original: if (I.lang && uu.supportsLanguage(I.lang)) return uu.highlight(I.text, { language: I.lang }) + vW
    case 'code':
      if (hljs && token.lang && hljs.supportsLanguage(token.lang)) {
        return hljs.highlight(token.text, { language: token.lang }) + EOL
      } else {
        // Unsupported language — silently fall back to markdown highlighting
        // (Original used an internal trace logger, not console output)
        if (hljs) {
          return hljs.highlight(token.text, { language: 'markdown' }) + EOL
        }
        return token.text + EOL
      }

    // Inline code - blue text
    // Original: j0.blue(I.text)
    case 'codespan':
      return (c.blue || c)(token.text)

    // Emphasis/italic
    // Original: j0.italic((I.tokens ?? []).map((C) => EW(C)).join(""))
    case 'em':
      return (c.italic || c)(
        (token.tokens ?? []).map(childToken => renderToken(childToken)).join('')
      )

    // Strong/bold
    // Original: j0.bold((I.tokens ?? []).map((C) => EW(C)).join(""))
    case 'strong':
      return (c.bold || c)(
        (token.tokens ?? []).map(childToken => renderToken(childToken)).join('')
      )

    // Headings with different styles by depth
    // Original switch on I.depth
    case 'heading':
      switch (token.depth) {
        case 1:
          // H1: Bold, italic, underlined
          // Original: j0.bold.italic.underline(...) + vW + vW
          return (c.bold?.italic?.underline || c.bold || c)(
            (token.tokens ?? []).map(childToken => renderToken(childToken)).join('')
          ) + EOL + EOL
        case 2:
          // H2: Bold
          // Original: j0.bold(...) + vW + vW
          return (c.bold || c)(
            (token.tokens ?? []).map(childToken => renderToken(childToken)).join('')
          ) + EOL + EOL
        default:
          // H3+: Bold and dim
          // Original: j0.bold.dim(...) + vW + vW
          return (c.bold?.dim || c.bold || c)(
            (token.tokens ?? []).map(childToken => renderToken(childToken)).join('')
          ) + EOL + EOL
      }

    // Horizontal rule
    // Original: return "---"
    case 'hr':
      return '---'

    // Image placeholder
    // Original: return `[Image: ${I.title}: ${I.href}]`
    case 'image':
      return `[Image: ${token.title}: ${token.href}]`

    // Link - show URL in blue
    // Original: j0.blue(I.href)
    case 'link':
      return (c.blue || c)(token.href)

    // List container - render all items
    // Original: I.items.map((C, W) => EW(C, d, I.ordered ? I.start + W : null, I)).join("")
    case 'list':
      return token.items.map((itemToken, itemIndex) => {
        // For ordered lists, pass the start number + current index
        const listIndex = token.ordered ? token.start + itemIndex : null
        return renderToken(itemToken, depth, listIndex, token)
      }).join('')

    // List item with proper indentation and marker
    // Original: (I.tokens ?? []).map((C) => `${"  ".repeat(d)}${EW(C,d+1,G,I)}`).join("")
    case 'list_item':
      return (token.tokens ?? []).map(childToken => {
        const indent = '  '.repeat(depth)
        return `${indent}${renderToken(childToken, depth + 1, orderedIndex, token)}`
      }).join('')

    // Paragraph - add newline after
    // Original: (I.tokens ?? []).map((C) => EW(C)).join("") + vW
    case 'paragraph':
      return (token.tokens ?? []).map(childToken => renderToken(childToken)).join('') + EOL

    // Space/blank line
    // Original: return vW
    case 'space':
      return EOL

    // Text content
    // Original complex handling for list items vs regular text
    case 'text':
      // Special handling for text inside list items
      // Original: if (Z?.type === "list_item") return `${G===null?"-":KB9(d,G)+"."} ${...}`
      if (parentToken?.type === 'list_item') {
        const marker = orderedIndex === null
          ? '-'
          : getListMarker(depth, orderedIndex) + '.'

        // If token has nested tokens, render them
        if (token.tokens) {
          return `${marker} ${token.tokens.map(childToken =>
            renderToken(childToken, depth, orderedIndex, token)
          ).join('')}${EOL}`
        }

        return `${marker} ${token.text}${EOL}`
      }

      // Regular text - just return as-is
      // Original: return I.text
      return token.text
  }

  // Unknown token type - return empty string
  return ''
}

// ============================================================================
// RENDER TO TERMINAL (Original: VU)
// ============================================================================

// Import marked.js lexer for tokenizing markdown
// Note: This assumes marked.js is available in the vendor directory
let markedLexer = null

/**
 * Initialize the marked lexer
 * Lazy initialization to avoid issues with ESM imports
 *
 * @returns {Promise<Function>} The marked lexer function
 */
export async function getMarkedLexer() {
  if (markedLexer) return markedLexer

  try {
    // Try to import from the vendor SDK path
    const marked = await import('../../vendor/sdk/node_modules/marked/lib/marked.esm.js')
    markedLexer = marked.lexer
  } catch (error) {
    // Fallback: try direct marked import
    try {
      const marked = await import('marked')
      markedLexer = marked.lexer
    } catch (fallbackError) {
      console.error('Failed to load marked.js:', fallbackError)
      // Return a simple fallback that just returns raw text
      markedLexer = (text) => [{ type: 'text', text, raw: text }]
    }
  }

  return markedLexer
}

/**
 * Context tag names that should be stripped from markdown
 * These are special XML-like tags used for internal context
 *
 * Original: Ew9 = ["commit_analysis", "context", "function_analysis", "pr_analysis"]
 */
export const CONTEXT_TAG_NAMES = [
  'commit_analysis',
  'context',
  'function_analysis',
  'pr_analysis'
]

/**
 * Sanitize markdown input before parsing
 * Removes special context XML-like tags that shouldn't be rendered
 *
 * Original function: JK1(I)
 * Original implementation:
 *   let d = new RegExp(`<(${Ew9.join("|")})>.*?</\\1>\n?`, "gs")
 *   return I.replace(d, "").trim()
 *
 * @param {string} markdown - Raw markdown text
 * @returns {string} Sanitized markdown with context tags removed
 */
export function sanitizeMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return ''
  }

  // Build regex to match context tags like <context>...</context>
  // The 's' flag makes . match newlines, 'g' for global replacement
  const tagPattern = new RegExp(
    `<(${CONTEXT_TAG_NAMES.join('|')})>.*?</\\1>\n?`,
    'gs'
  )

  return markdown.replace(tagPattern, '').trim()
}

/**
 * Render markdown text to terminal output with colors and formatting
 *
 * Original function: VU(I)
 * Original implementation:
 *   return n5.lexer(JK1(I)).map((d) => EW(d)).join("").trim()
 *
 * This is the main entry point for converting markdown to terminal-ready text.
 * It tokenizes the markdown using marked.js, then recursively renders each
 * token with appropriate terminal formatting (colors, styles).
 *
 * @param {string} markdown - Raw markdown text to render
 * @returns {string} Terminal-formatted text with ANSI colors
 *
 * @example
 * const output = renderToTerminal('**Bold** and *italic*')
 * // Returns chalk-formatted string with bold and italic ANSI codes
 */
export function renderToTerminal(markdown) {
  if (!markedLexer) {
    // Initialize lexer synchronously
    initializeMarkedLexer()
  }

  const sanitized = sanitizeMarkdown(markdown)
  const tokens = markedLexer(sanitized)

  return tokens
    .map(token => renderToken(token))
    .join('')
    .trim()
}

/**
 * Async version of renderToTerminal
 * Ensures lexer is properly initialized before use
 *
 * @param {string} markdown - Raw markdown text to render
 * @returns {Promise<string>} Terminal-formatted text with ANSI colors
 */
export async function renderToTerminalAsync(markdown) {
  const lexer = await getMarkedLexer()
  const sanitized = sanitizeMarkdown(markdown)
  const tokens = lexer(sanitized)

  return tokens
    .map(token => renderToken(token))
    .join('')
    .trim()
}

/**
 * Initialize the marked lexer synchronously
 * This is called lazily when renderToTerminal is first invoked
 */
function initializeMarkedLexer() {
  if (markedLexer) return

  // Try to find marked.js - it should be bundled with the SDK
  try {
    // Use a fallback simple tokenizer if marked isn't available
    markedLexer = createSimpleTokenizer()
  } catch (error) {
    console.error('Failed to initialize markdown lexer:', error)
    // Ultimate fallback: just return text as a single token
    markedLexer = (text) => [{ type: 'text', text, raw: text }]
  }
}

/**
 * Create a simple markdown tokenizer as fallback
 * This handles basic markdown without full marked.js
 *
 * @returns {Function} Tokenizer function
 */
function createSimpleTokenizer() {
  return (text) => {
    const tokens = []
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Heading
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        tokens.push({
          type: 'heading',
          depth: headingMatch[1].length,
          text: headingMatch[2],
          tokens: [{ type: 'text', text: headingMatch[2] }]
        })
        continue
      }

      // Code block start
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim()
        const codeLines = []
        i++
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i])
          i++
        }
        tokens.push({
          type: 'code',
          lang: lang || null,
          text: codeLines.join('\n')
        })
        continue
      }

      // Horizontal rule
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
        tokens.push({ type: 'hr' })
        continue
      }

      // Empty line
      if (line.trim() === '') {
        tokens.push({ type: 'space' })
        continue
      }

      // Regular paragraph
      tokens.push({
        type: 'paragraph',
        text: line,
        tokens: parseInlineTokens(line)
      })
    }

    return tokens
  }
}

/**
 * Parse inline markdown tokens (bold, italic, code, links)
 *
 * @param {string} text - Line of text to parse
 * @returns {Array} Array of inline tokens
 */
function parseInlineTokens(text) {
  const tokens = []
  let remaining = text
  let match

  while (remaining.length > 0) {
    // Bold **text**
    if ((match = remaining.match(/^\*\*(.+?)\*\*/))) {
      tokens.push({
        type: 'strong',
        text: match[1],
        tokens: [{ type: 'text', text: match[1] }]
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Italic *text*
    if ((match = remaining.match(/^\*(.+?)\*/))) {
      tokens.push({
        type: 'em',
        text: match[1],
        tokens: [{ type: 'text', text: match[1] }]
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Inline code `text`
    if ((match = remaining.match(/^`([^`]+)`/))) {
      tokens.push({
        type: 'codespan',
        text: match[1]
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Link [text](url)
    if ((match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/))) {
      tokens.push({
        type: 'link',
        text: match[1],
        href: match[2]
      })
      remaining = remaining.slice(match[0].length)
      continue
    }

    // Regular character
    const nextSpecial = remaining.search(/[\*`\[]/)
    if (nextSpecial === -1) {
      tokens.push({ type: 'text', text: remaining })
      break
    } else if (nextSpecial === 0) {
      // Special char that didn't match a pattern - treat as text
      tokens.push({ type: 'text', text: remaining[0] })
      remaining = remaining.slice(1)
    } else {
      tokens.push({ type: 'text', text: remaining.slice(0, nextSpecial) })
      remaining = remaining.slice(nextSpecial)
    }
  }

  return tokens
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  TextRenderer,
  renderToken,
  renderToTerminal,
  renderToTerminalAsync,
  sanitizeMarkdown,
  getListMarker,
  getMarkedLexer,
  ALPHA_MARKERS,
  ROMAN_MARKERS,
  CONTEXT_TAG_NAMES
}
