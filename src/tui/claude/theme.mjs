/**
 * Dario Code Theme
 *
 * Visual style for Dario Code
 */

/**
 * Light theme color palette
 */
export const CLAUDE_COLORS = {
  // Brand colors
  claude: '#CC9B7A',           // Claude brand orange/tan
  claudeLight: '#E5C4A8',      // Lighter variant
  claudeDark: '#A67C5D',       // Darker variant

  // Semantic colors
  success: '#10B981',          // Green for success
  error: '#EF4444',            // Red for errors
  warning: '#F59E0B',          // Orange for warnings
  info: '#3B82F6',             // Blue for info

  // Text colors (light theme)
  text: '#1F2937',             // Primary text
  textSecondary: '#6B7280',    // Secondary/dim text
  textTertiary: '#9CA3AF',     // Very dim text

  // Background colors
  background: '#FFFFFF',       // Main background
  backgroundSecondary: '#F9FAFB', // Secondary background
  border: '#E5E7EB',           // Border color

  // Tool use colors
  toolBorder: '#CC9B7A',       // Tool card border (claude color)
  toolBackground: '#FFF7ED',   // Tool card background (warm white)

  // Thinking block colors
  thinkingBorder: '#9CA3AF',   // Thinking block border (gray)
  thinkingBackground: '#F3F4F6', // Thinking background (light gray)
  thinkingCollapsed: '#D1D5DB', // Collapsed indicator

  // Status line
  statusBackground: '#1F2937',  // Dark background
  statusText: '#F9FAFB',        // Light text
  statusAccent: '#CC9B7A',      // Claude accent

  // Syntax highlighting (for code blocks)
  syntax: {
    keyword: '#D73A49',         // Red
    string: '#032F62',          // Blue
    function: '#6F42C1',        // Purple
    comment: '#6A737D',         // Gray
    number: '#005CC5',          // Blue
    operator: '#D73A49',        // Red
    variable: '#E36209'         // Orange
  }
}

/**
 * Dark theme color palette (terminal-appropriate)
 */
export const DARK_COLORS = {
  // Brand colors (same across themes)
  claude: '#CC9B7A',
  claudeLight: '#E5C4A8',
  claudeDark: '#A67C5D',

  // Semantic colors (same across themes)
  success: '#10B981',
  error: '#EF4444',
  warning: '#F59E0B',
  info: '#3B82F6',

  // Text colors (light on dark)
  text: '#E5E7EB',
  textSecondary: '#9CA3AF',
  textTertiary: '#6B7280',

  // Background colors (dark)
  background: '#1F2937',
  backgroundSecondary: '#111827',
  border: '#374151',

  // Tool use colors
  toolBorder: '#CC9B7A',
  toolBackground: '#292524',

  // Thinking block colors
  thinkingBorder: '#6B7280',
  thinkingBackground: '#1F2937',
  thinkingCollapsed: '#4B5563',

  // Status line
  statusBackground: '#111827',
  statusText: '#F9FAFB',
  statusAccent: '#CC9B7A',

  // Syntax highlighting (adjusted for dark backgrounds)
  syntax: {
    keyword: '#F97583',
    string: '#9ECBFF',
    function: '#B392F0',
    comment: '#6A737D',
    number: '#79B8FF',
    operator: '#F97583',
    variable: '#FFAB70'
  }
}

/**
 * Get theme colors based on user's theme setting
 *
 * @param {string} theme - Theme name (dark, light, dark-daltonized, light-daltonized)
 * @returns {Object} Color palette
 */
export function getThemeColors(theme = 'dark') {
  switch (theme) {
    case 'light':
    case 'light-daltonized':
      return CLAUDE_COLORS
    case 'dark':
    case 'dark-daltonized':
    default:
      return DARK_COLORS
  }
}

/**
 * ANSI color codes for terminal rendering
 */
export const ANSI = {
  // Reset
  reset: '\x1b[0m',

  // Text styles
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Claude brand
  claude: '\x1b[38;2;204;155;122m',

  // Semantic
  success: '\x1b[38;2;16;185;129m',
  error: '\x1b[38;2;239;68;68m',
  warning: '\x1b[38;2;245;158;11m',
  info: '\x1b[38;2;59;130;246m',

  // Text
  text: '\x1b[38;2;31;41;55m',
  textSecondary: '\x1b[38;2;107;114;128m',
  textTertiary: '\x1b[38;2;156;163;175m'
}

/**
 * Box drawing characters for borders
 */
export const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  leftT: '├',
  rightT: '┤',
  topT: '┬',
  bottomT: '┴',
  cross: '┼',

  // Rounded corners
  roundTopLeft: '╭',
  roundTopRight: '╮',
  roundBottomLeft: '╰',
  roundBottomRight: '╯',

  // Heavy variants
  heavyHorizontal: '━',
  heavyVertical: '┃'
}

/**
 * Unicode symbols
 */
export const SYMBOLS = {
  // Status indicators
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  thinking: '🤔',
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',

  // Tool indicators
  toolUse: '⚙',
  toolResult: '→',

  // Navigation
  arrow: '→',
  bullet: '•',
  ellipsis: '…'
}

export default {
  CLAUDE_COLORS,
  DARK_COLORS,
  ANSI,
  BOX_CHARS,
  SYMBOLS,
  getThemeColors
}
