/**
 * Keyboard shortcuts and input handling module
 * Provides support for keyboard shortcuts, history search, and input modes
 */

import readline from 'readline'
import { EventEmitter } from 'events'

class KeyboardManager extends EventEmitter {
  constructor() {
    super()
    this.mode = 'normal'
    this.vimMode = false
    this.emacsMode = false
    this.historyIndex = -1
    this.history = []
    this.searchQuery = ''
    this.searchResults = []
    this.suspendedOperations = []
    this.rl = null
    // Current input text — updated by callers so Tab completion has context
    this._currentInput = ''
  }

  /**
   * Update the current input text (call this when the prompt input changes).
   * Required for Tab history completion to know what partial text to match.
   * @param {string} input
   */
  setCurrentInput(input) {
    this._currentInput = input || ''
  }

  /**
   * Find the most recent history entry that starts with `partial`.
   * Delegates to HistorySearch.getTabCompletion if available.
   * @param {string} partial
   * @returns {string|null}
   */
  _getTabCompletion(partial) {
    if (!partial) return null
    // Try in-class history first
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].startsWith(partial)) return this.history[i]
    }
    return null
  }

  /**
   * Initialize keyboard manager with readline interface
   */
  init(rl) {
    this.rl = rl
    this.attachKeyHandlers()
  }

  /**
   * Attach key handlers to stdin
   */
  attachKeyHandlers() {
    if (!process.stdin.isTTY) return

    // Save original raw mode setting
    const originalRawMode = process.stdin.isRaw

    // Enable raw mode to capture all keystrokes
    process.stdin.setRawMode(true)
    process.stdin.resume()

    // Handle keyboard input
    process.stdin.on('data', (buffer) => {
      const input = buffer.toString()

      // Check for special key combinations
      if (this.handleSpecialKeys(input)) {
        return
      }
    })

    // Restore on exit
    process.on('exit', () => {
      process.stdin.setRawMode(originalRawMode)
    })
  }

  /**
   * Handle special key combinations
   * Returns true if the key was handled
   */
  handleSpecialKeys(input) {
    // Ctrl+R: History search
    if (input === '\x12') {
      // \x12 is Ctrl+R
      this.emit('history-search')
      return true
    }

    // Ctrl+Z: Suspend operation
    if (input === '\x02') {
      // \x02 is Ctrl+B — unified background (CC 2.1 parity)
      // Backgrounds both the current bash command AND any running agent simultaneously.
      this.emit('background-all')
    }

    if (input === '\x1a') {
      // \x1a is Ctrl+Z
      this.emit('suspend')
      return true
    }

    // Tab: history completion if input is non-empty and matches history,
    // otherwise fall through to thinking toggle.
    // (CC 2.1.14 parity — bash history Tab autocomplete)
    if (input === '\t') {
      if (this._currentInput && this._currentInput.trim()) {
        const completion = this._getTabCompletion(this._currentInput)
        if (completion) {
          this.emit('tab-complete', completion)
          return true
        }
      }
      this.emit('toggle-thinking')
      return true
    }

    // Shift+Tab: Mode cycling (already implemented)
    if (input === '\x1b[Z') {
      // \x1b[Z is Shift+Tab
      this.emit('cycle-mode')
      return true
    }

    // Emacs shortcuts
    if (this.emacsMode || !this.vimMode) {
      // Ctrl+A: Beginning of line
      if (input === '\x01') {
        this.emit('emacs-begin-line')
        return true
      }

      // Ctrl+E: End of line
      if (input === '\x05') {
        this.emit('emacs-end-line')
        return true
      }

      // Ctrl+K: Kill to end of line
      if (input === '\x0b') {
        this.emit('emacs-kill-line')
        return true
      }

      // Ctrl+U: Kill to beginning of line
      if (input === '\x15') {
        this.emit('emacs-kill-start')
        return true
      }

      // Ctrl+W: Delete word backward
      if (input === '\x17') {
        this.emit('emacs-delete-word')
        return true
      }

      // Alt+F: Forward word
      if (input === '\x1bf') {
        this.emit('emacs-forward-word')
        return true
      }

      // Alt+B: Backward word
      if (input === '\x1bb') {
        this.emit('emacs-backward-word')
        return true
      }
    }

    // Vim mode shortcuts
    if (this.vimMode) {
      // ESC: Switch to normal mode
      if (input === '\x1b') {
        this.emit('vim-normal-mode')
        return true
      }

      // Normal mode navigation: hjkl, w, b, e
      // These would be handled in normal mode context
    }

    return false
  }

  /**
   * Set keyboard mode
   */
  setMode(mode) {
    if (mode === 'vim') {
      this.vimMode = true
      this.emacsMode = false
      this.mode = 'vim'
    } else if (mode === 'emacs') {
      this.emacsMode = true
      this.vimMode = false
      this.mode = 'emacs'
    } else {
      this.vimMode = false
      this.emacsMode = false
      this.mode = 'normal'
    }
    this.emit('mode-changed', this.mode)
  }

  /**
   * Add entry to history
   */
  addToHistory(entry) {
    this.history.push(entry)
    this.historyIndex = -1
  }

  /**
   * Search history for query
   */
  searchHistory(query) {
    this.searchQuery = query
    this.searchResults = this.history.filter((entry) =>
      entry.toLowerCase().includes(query.toLowerCase())
    )
    return this.searchResults
  }

  /**
   * Get history at index
   */
  getHistoryEntry(index) {
    if (index >= 0 && index < this.history.length) {
      return this.history[index]
    }
    return null
  }

  /**
   * Suspend current operation
   */
  suspend(operation) {
    this.suspendedOperations.push({
      operation,
      timestamp: Date.now(),
      paused: true
    })
    this.emit('operation-suspended', operation)
  }

  /**
   * Resume suspended operation
   */
  resume(index = 0) {
    if (index >= 0 && index < this.suspendedOperations.length) {
      const suspended = this.suspendedOperations[index]
      suspended.paused = false
      this.emit('operation-resumed', suspended.operation)
      return suspended.operation
    }
    return null
  }

  /**
   * Get list of suspended operations
   */
  listSuspended() {
    return this.suspendedOperations
  }

  /**
   * Clear keyboard manager
   */
  destroy() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.removeAllListeners('data')
    this.removeAllListeners()
  }
}

// Export singleton instance
export const keyboardManager = new KeyboardManager()

/**
 * Format key sequence for display
 */
export function formatKeySequence(seq) {
  const map = {
    '\x01': 'Ctrl+A',
    '\x02': 'Ctrl+B',
    '\x05': 'Ctrl+E',
    '\x0b': 'Ctrl+K',
    '\x12': 'Ctrl+R',
    '\x15': 'Ctrl+U',
    '\x17': 'Ctrl+W',
    '\x1a': 'Ctrl+Z',
    '\x1bb': 'Alt+B',
    '\x1bf': 'Alt+F'
  }
  return map[seq] || seq
}

/**
 * Get available shortcuts help text
 */
export function getShortcutsHelp() {
  return `
Keyboard Shortcuts:
  Ctrl+R         - Search command history (reverse-i-search style)
  Ctrl+B         - Background all (bash command + agent simultaneously)
  Ctrl+Z         - Suspend current operation (background)
  Tab            - Toggle thinking animation
  Shift+Tab      - Cycle through display modes

Emacs Mode Shortcuts:
  Ctrl+A         - Move to beginning of line
  Ctrl+E         - Move to end of line
  Ctrl+K         - Kill (delete) to end of line
  Ctrl+U         - Kill (delete) to beginning of line
  Ctrl+W         - Delete word backward
  Alt+F          - Move forward one word
  Alt+B          - Move backward one word

Vim Mode Shortcuts:
  ESC            - Enter normal mode
  h/j/k/l        - Navigate (normal mode)
  w/b/e          - Word navigation (normal mode)
  dd             - Delete line (normal mode)
  yy             - Copy line (normal mode)
  p              - Paste (normal mode)
  x              - Delete character (normal mode)
  :q             - Quit (command mode)
  :set mode      - Set keyboard mode (normal, emacs, vim)
`
}
