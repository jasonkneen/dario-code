/**
 * History search module
 * Implements reverse-i-search style history searching
 */

import { keyboardManager } from './index.mjs'

class HistorySearch {
  constructor() {
    this.searchActive = false
    this.searchQuery = ''
    this.currentIndex = -1
    this.history = []
    this.searchResults = []
    this.searchCallbacks = {
      onSearch: null,
      onSelect: null,
      onCancel: null,
      onUpdate: null
    }
  }

  /**
   * Initialize history search with history array
   */
  init(history) {
    this.history = history || []
  }

  /**
   * Start interactive history search
   */
  start(onSearch, onSelect, onCancel, onUpdate) {
    this.searchActive = true
    this.searchQuery = ''
    this.currentIndex = -1
    this.searchResults = []

    // Store callbacks
    this.searchCallbacks.onSearch = onSearch
    this.searchCallbacks.onSelect = onSelect
    this.searchCallbacks.onCancel = onCancel
    this.searchCallbacks.onUpdate = onUpdate

    // Display search prompt
    this.displaySearchPrompt()
  }

  /**
   * Display search prompt and handle input
   */
  displaySearchPrompt() {
    if (!this.searchActive) return

    const prompt =
      `(reverse-i-search)\`${this.searchQuery}': ` +
      (this.searchResults.length > 0 ? this.searchResults[0] : '')

    if (this.searchCallbacks.onUpdate) {
      this.searchCallbacks.onUpdate(prompt, this.searchResults)
    }
  }

  /**
   * Add character to search query
   */
  addChar(char) {
    if (!this.searchActive) return

    this.searchQuery += char
    this.performSearch()
    this.displaySearchPrompt()
  }

  /**
   * Remove last character from search query
   */
  backspace() {
    if (!this.searchActive) return

    this.searchQuery = this.searchQuery.slice(0, -1)
    this.performSearch()
    this.displaySearchPrompt()
  }

  /**
   * Perform search in history
   */
  performSearch() {
    if (!this.searchQuery) {
      this.searchResults = []
      this.currentIndex = -1
      return
    }

    // Search history in reverse order
    this.searchResults = []
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i]
      if (entry.toLowerCase().includes(this.searchQuery.toLowerCase())) {
        this.searchResults.push(entry)
        if (this.searchResults.length >= 10) {
          // Limit to 10 results for performance
          break
        }
      }
    }

    this.currentIndex = 0
  }

  /**
   * Move to next search result
   */
  nextResult() {
    if (!this.searchActive) return

    if (this.searchResults.length > 0) {
      this.currentIndex = (this.currentIndex + 1) % this.searchResults.length
      this.displaySearchPrompt()
    }
  }

  /**
   * Move to previous search result
   */
  previousResult() {
    if (!this.searchActive) return

    if (this.searchResults.length > 0) {
      this.currentIndex =
        (this.currentIndex - 1 + this.searchResults.length) %
        this.searchResults.length
      this.displaySearchPrompt()
    }
  }

  /**
   * Select current search result and close search
   */
  selectCurrent() {
    if (!this.searchActive) return

    const selected =
      this.searchResults.length > 0 ? this.searchResults[this.currentIndex] : ''

    this.searchActive = false

    if (this.searchCallbacks.onSelect) {
      this.searchCallbacks.onSelect(selected)
    }

    return selected
  }

  /**
   * Cancel search and close
   */
  cancel() {
    this.searchActive = false
    this.searchQuery = ''
    this.searchResults = []
    this.currentIndex = -1

    if (this.searchCallbacks.onCancel) {
      this.searchCallbacks.onCancel()
    }
  }

  /**
   * Check if search is active
   */
  isActive() {
    return this.searchActive
  }

  /**
   * Get current search status
   */
  getStatus() {
    return {
      active: this.searchActive,
      query: this.searchQuery,
      results: this.searchResults,
      currentIndex: this.currentIndex,
      current:
        this.searchResults.length > 0 ? this.searchResults[this.currentIndex] : null
    }
  }

  /**
   * Tab completion: find the most recent history entry that starts with `partial`.
   * (CC 2.1.14 parity — bash history Tab autocomplete)
   *
   * @param {string} partial - The current input text to complete
   * @returns {string|null} The completed command, or null if no match
   */
  getTabCompletion(partial) {
    if (!partial || !partial.trim()) return null
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].startsWith(partial)) return this.history[i]
    }
    return null
  }
}

// Export singleton instance
export const historySearch = new HistorySearch()

/**
 * Create a readline-compatible history search
 */
export function createHistorySearch(rl, history) {
  historySearch.init(history)

  return {
    /**
     * Start history search
     */
    start() {
      historySearch.start(
        (results) => {
          // onSearch callback
        },
        (selected) => {
          // onSelect callback - selected text
          if (selected && rl) {
            rl.line = selected
            rl.cursor = selected.length
            rl._refreshLine()
          }
        },
        () => {
          // onCancel callback
          if (rl) {
            rl._refreshLine()
          }
        },
        (prompt, results) => {
          // onUpdate callback
          if (rl) {
            process.stdout.write(`\r${prompt}`)
          }
        }
      )
    },

    /**
     * Handle input during search
     */
    handleInput(char) {
      if (char === '\x1b') {
        // ESC to cancel
        historySearch.cancel()
        return false
      } else if (char === '\r' || char === '\n') {
        // ENTER to select
        historySearch.selectCurrent()
        return false
      } else if (char === '\x08' || char === '\x7f') {
        // BACKSPACE
        historySearch.backspace()
        return true
      } else if (char === '\x12') {
        // Ctrl+R to next result
        historySearch.nextResult()
        return true
      } else if (char === '\x10') {
        // Ctrl+P to previous result
        historySearch.previousResult()
        return true
      } else if (char >= ' ' && char <= '~') {
        // Printable character
        historySearch.addChar(char)
        return true
      }

      return false
    },

    /**
     * Get search status
     */
    getStatus() {
      return historySearch.getStatus()
    },

    /**
     * Check if search is active
     */
    isActive() {
      return historySearch.isActive()
    }
  }
}
