/**
 * Memory Watcher — background extraction loop for Auto Memories
 * (CC 2.1.32 parity)
 *
 * Periodically checks whether new conversation turns warrant extracting
 * new durable facts and persisting them to .claude/memory/.
 */

import {
  shouldExtract,
  extractMemories,
  saveMemory,
  loadMemories,
} from './auto-memory.mjs'

const INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

let _watcherTimer = null
let _lastExtractedAt = 0
let _lastExtractedTurnCount = 0

/**
 * Start the memory watcher.
 *
 * @param {Function} getMessages - returns the current message array (sync)
 * @param {string} cwd - working directory for project-level memory
 * @returns {Function} stop — call to tear down the watcher
 */
export function startMemoryWatcher(getMessages, cwd = process.cwd()) {
  stopMemoryWatcher()

  async function runExtraction() {
    const messages = getMessages()
    if (!messages || messages.length === 0) return

    if (!shouldExtract(messages, _lastExtractedAt, _lastExtractedTurnCount)) return

    const existing = loadMemories(cwd)
    const newFacts = await extractMemories(messages, existing)

    for (const fact of newFacts) {
      saveMemory(fact, 'project', cwd)
    }

    // Update watermarks
    _lastExtractedAt = Date.now()
    _lastExtractedTurnCount = messages.filter(m =>
      (m.role || m.message?.role) === 'assistant'
    ).length
  }

  _watcherTimer = setInterval(() => {
    runExtraction().catch(() => {
      // Silently ignore extraction errors — memory is best-effort
    })
  }, INTERVAL_MS)

  // Unref so the timer won't keep Node alive past the main process
  if (_watcherTimer.unref) _watcherTimer.unref()

  return stopMemoryWatcher
}

/**
 * Stop the memory watcher.
 */
export function stopMemoryWatcher() {
  if (_watcherTimer) {
    clearInterval(_watcherTimer)
    _watcherTimer = null
  }
}

/**
 * Manually trigger an extraction cycle (e.g., on session end).
 *
 * @param {Function} getMessages
 * @param {string} cwd
 */
export async function triggerExtraction(getMessages, cwd = process.cwd()) {
  const messages = getMessages()
  if (!messages || messages.length === 0) return

  const existing = loadMemories(cwd)
  const newFacts = await extractMemories(messages, existing)

  for (const fact of newFacts) {
    saveMemory(fact, 'project', cwd)
  }
}

export default {
  startMemoryWatcher,
  stopMemoryWatcher,
  triggerExtraction,
}
