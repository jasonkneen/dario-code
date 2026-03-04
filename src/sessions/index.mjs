/**
 * Session Management Module
 *
 * Compatible session layout:
 *   ~/.claude/projects/<encoded-cwd>/
 *     <sessionId>.jsonl   – append-only event log
 *     sessions-index.json – cached metadata for fast listing
 *
 * Path encoding: CWD slashes → dashes, e.g.
 *   /Users/jkneen/myproject → -Users-jkneen-myproject
 */

import fs from 'fs/promises'
import path from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

const CLAUDE_DIR = path.join(homedir(), '.claude')
const DARIO_DIR = process.env.DARIO_CONFIG_DIR || path.join(homedir(), '.dario')
const PROJECTS_DIR = path.join(DARIO_DIR, 'projects')        // Primary: write here
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')     // Secondary: read-only

/**
 * Encode a CWD path into the project folder name.
 * Replaces path separators and underscores with dashes for folder encoding.
 * Also strips the Windows drive-letter colon to keep names valid.
 * /Users/jkneen/my_project → -Users-jkneen-my-project
 * C:\Users\jkneen\my_project → C-Users-jkneen-my-project
 */
export function encodeProjectPath(cwd) {
  const normalized = String(cwd || '').replace(/\\/g, '/')
  const withoutDriveColon = normalized.replace(/^([A-Za-z]):(?=\/|$)/, '$1')
  return withoutDriveColon.replace(/[/_:]/g, '-')
}

/**
 * Get the project directory for a given CWD.
 */
export function getProjectDir(cwd = process.cwd()) {
  return path.join(PROJECTS_DIR, encodeProjectPath(cwd))
}

/**
 * Get the sessions-index.json path for a project.
 */
function getIndexPath(cwd = process.cwd()) {
  return path.join(getProjectDir(cwd), 'sessions-index.json')
}

/**
 * Get the JSONL file path for a session.
 */
function getSessionPath(sessionId, cwd = process.cwd()) {
  return path.join(getProjectDir(cwd), `${sessionId}.jsonl`)
}

/**
 * Ensure the project directory exists.
 */
export async function initSessions(cwd = process.cwd()) {
  await fs.mkdir(getProjectDir(cwd), { recursive: true })
}

// ─── Index Operations ──────────────────────────────────────────────

/**
 * Read the sessions-index.json for a project.
 * Returns { version, entries[] } or a fresh empty index.
 */
async function readIndex(cwd = process.cwd()) {
  try {
    const raw = await fs.readFile(getIndexPath(cwd), 'utf8')
    return JSON.parse(raw)
  } catch {
    return { version: 1, entries: [] }
  }
}

/**
 * Write the sessions-index.json for a project.
 */
async function writeIndex(index, cwd = process.cwd()) {
  await initSessions(cwd)
  await fs.writeFile(getIndexPath(cwd), JSON.stringify(index, null, 2))
}

/**
 * Upsert a session entry in the index (by sessionId).
 */
async function upsertIndexEntry(entry, cwd = process.cwd()) {
  const index = await readIndex(cwd)
  const existing = index.entries.findIndex(e => e.sessionId === entry.sessionId)
  if (existing >= 0) {
    index.entries[existing] = { ...index.entries[existing], ...entry }
  } else {
    index.entries.push(entry)
  }
  await writeIndex(index, cwd)
}

/**
 * Remove a session entry from the index.
 */
async function removeIndexEntry(sessionId, cwd = process.cwd()) {
  const index = await readIndex(cwd)
  index.entries = index.entries.filter(e => e.sessionId !== sessionId)
  await writeIndex(index, cwd)
}

// ─── JSONL Operations ──────────────────────────────────────────────

/**
 * Append a JSONL event to a session file.
 */
async function appendEvent(sessionId, event, cwd = process.cwd()) {
  await initSessions(cwd)
  const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n'
  await fs.appendFile(getSessionPath(sessionId, cwd), line)
}

/**
 * Read all events from a session JSONL file.
 */
async function readEvents(sessionId, cwd = process.cwd()) {
  try {
    const raw = await fs.readFile(getSessionPath(sessionId, cwd), 'utf8')
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Extract messages (user/assistant pairs) from JSONL events.
 */
function extractMessages(events) {
  return events
    .filter(e => e.type === 'user' || e.type === 'assistant')
    .map(e => ({
      role: e.type === 'user' ? 'user' : 'assistant',
      content: extractContent(e),
      timestamp: e.timestamp,
    }))
}

/**
 * Extract text content from a JSONL event.
 * Handles both simple string content and Claude API message format.
 */
function extractContent(event) {
  const msg = event.message
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Create a new session in the current project.
 */
export async function createSession(name = null) {
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const cwd = process.cwd()
  const sessionName = name || `Session ${now.split('T')[0]}`

  // Write initial event
  await appendEvent(sessionId, {
    type: 'session-start',
    sessionId,
    cwd,
    name: sessionName,
  }, cwd)

  // Update index
  await upsertIndexEntry({
    sessionId,
    fullPath: getSessionPath(sessionId, cwd),
    firstPrompt: '',
    messageCount: 0,
    created: now,
    modified: now,
    projectPath: cwd,
    name: sessionName,
  }, cwd)

  // Return a session object compatible with old API
  return {
    id: sessionId,
    name: sessionName,
    created: now,
    updated: now,
    cwd,
    messages: [],
    context: {},
    metadata: { messageCount: 0, lastMessage: null },
  }
}

/**
 * Get a session by ID. Reads from the current project directory.
 * Falls back to scanning all projects for partial ID matches.
 */
export async function getSession(sessionId, cwd = process.cwd()) {
  const encoded = encodeProjectPath(cwd)

  // Fast path: exact file in dario project dir
  const exactPath = getSessionPath(sessionId, cwd)
  try {
    await fs.access(exactPath)
    return await loadSessionFromJSONL(sessionId, cwd)
  } catch {
    // Not in dario project
  }

  // Check dario index for the session
  const index = await readIndex(cwd)
  const entry = index.entries.find(e =>
    e.sessionId === sessionId || e.sessionId.startsWith(sessionId)
  )
  if (entry) {
    return await loadSessionFromJSONL(entry.sessionId, cwd)
  }

  // Fallback: check claude projects dir
  const claudeProjectDir = path.join(CLAUDE_PROJECTS_DIR, encoded)
  const claudeSessionPath = path.join(claudeProjectDir, `${sessionId}.jsonl`)
  try {
    await fs.access(claudeSessionPath)
    return await loadSessionFromJSONLPath(claudeSessionPath, sessionId, cwd)
  } catch {
    // Not in claude project either
  }

  // Last resort: scan all claude project subdirs for this sessionId
  try {
    const projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR)
    for (const dir of projectDirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`)
      try {
        await fs.access(filePath)
        return await loadSessionFromJSONLPath(filePath, sessionId, cwd)
      } catch {
        // not in this dir
      }
    }
  } catch {
    // claude projects dir not accessible
  }

  return null
}

/**
 * Read events from an absolute JSONL file path.
 */
async function readEventsFromPath(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Load a full session from an absolute JSONL file path.
 */
async function loadSessionFromJSONLPath(filePath, sessionId, cwd = process.cwd()) {
  const events = await readEventsFromPath(filePath)
  if (events.length === 0) return null

  const startEvent = events.find(e => e.type === 'session-start')
  const firstUserEvent = events.find(e => e.type === 'user')
  const messages = extractMessages(events)
  const firstEvent = events[0]
  const lastEvent = events[events.length - 1]
  const firstPrompt = firstUserEvent ? extractContent(firstUserEvent) : ''

  return {
    id: sessionId,
    name: startEvent?.name || (firstPrompt ? firstPrompt.slice(0, 60) : `Session ${firstEvent?.timestamp?.split('T')[0] || 'Unknown'}`),
    created: firstEvent?.timestamp || new Date().toISOString(),
    updated: lastEvent?.timestamp || new Date().toISOString(),
    cwd: startEvent?.cwd || firstUserEvent?.cwd || cwd,
    gitBranch: firstUserEvent?.gitBranch || '',
    firstPrompt,
    messages,
    context: {},
    metadata: {
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1] || null,
    },
  }
}

/**
 * Load a full session object from its JSONL file.
 * Compatible with both Dario sessions (have session-start event)
 * and standard sessions (start with queue-operation/user events).
 */
async function loadSessionFromJSONL(sessionId, cwd = process.cwd()) {
  const events = await readEvents(sessionId, cwd)
  if (events.length === 0) return null

  const startEvent = events.find(e => e.type === 'session-start')
  // Standard sessions have cwd/gitBranch on user/assistant events
  const firstUserEvent = events.find(e => e.type === 'user')
  const messages = extractMessages(events)
  const firstEvent = events[0]
  const lastEvent = events[events.length - 1]

  // Extract first user prompt text for display
  const firstPrompt = firstUserEvent ? extractContent(firstUserEvent) : ''

  return {
    id: sessionId,
    name: startEvent?.name || (firstPrompt ? firstPrompt.slice(0, 60) : `Session ${firstEvent?.timestamp?.split('T')[0] || 'Unknown'}`),
    created: firstEvent?.timestamp || new Date().toISOString(),
    updated: lastEvent?.timestamp || new Date().toISOString(),
    cwd: startEvent?.cwd || firstUserEvent?.cwd || cwd,
    gitBranch: firstUserEvent?.gitBranch || '',
    firstPrompt,
    messages,
    context: {},
    metadata: {
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1] || null,
    },
  }
}

/**
 * Update a session's metadata.
 */
export async function updateSession(sessionId, updates) {
  const cwd = process.cwd()
  const session = await getSession(sessionId, cwd)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  // Append update event
  await appendEvent(sessionId, {
    type: 'session-update',
    sessionId,
    updates,
  }, cwd)

  // Update index
  const now = new Date().toISOString()
  await upsertIndexEntry({
    sessionId,
    modified: now,
    ...(updates.name ? { name: updates.name } : {}),
  }, cwd)

  return {
    ...session,
    ...updates,
    updated: now,
  }
}

/**
 * Add a message to a session.
 */
export async function addMessage(sessionId, role, content) {
  const cwd = process.cwd()
  const session = await getSession(sessionId, cwd)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const timestamp = new Date().toISOString()

  // Append message event (standard JSONL format)
  await appendEvent(sessionId, {
    type: role === 'user' ? 'user' : 'assistant',
    sessionId,
    message: { role, content },
  }, cwd)

  // Update index
  const newCount = session.messages.length + 1
  const isFirstUserMessage = role === 'user' && session.messages.filter(m => m.role === 'user').length === 0
  await upsertIndexEntry({
    sessionId,
    modified: timestamp,
    messageCount: newCount,
    ...(isFirstUserMessage ? { firstPrompt: typeof content === 'string' ? content.slice(0, 200) : '' } : {}),
  }, cwd)

  return { role, content, timestamp }
}

/**
 * Map a raw index entry to our standard session summary shape.
 */
function mapIndexEntry(e, defaultCwd) {
  return {
    id: e.sessionId,
    name: e.name || e.firstPrompt?.slice(0, 60) || `Session ${e.sessionId.slice(0, 8)}`,
    created: e.created,
    updated: e.modified,
    cwd: e.projectPath || defaultCwd,
    messageCount: e.messageCount || 0,
    firstPrompt: e.firstPrompt || '',
    gitBranch: e.gitBranch || '',
    fullPath: e.fullPath || '',
    fileSize: 0,
    lastMessage: null,
  }
}

/**
 * Add file sizes to session entries by stat-ing their JSONL files.
 */
async function addFileSizes(entries) {
  await Promise.all(entries.map(async (entry) => {
    if (entry.fullPath) {
      try {
        const stat = await fs.stat(entry.fullPath)
        entry.fileSize = stat.size
      } catch {
        entry.fileSize = 0
      }
    }
  }))
  return entries
}

/**
 * Read sessions index from a specific base dir (dario or claude).
 */
async function readIndexFromBase(baseProjectsDir, cwd) {
  try {
    const encoded = encodeProjectPath(cwd)
    const indexPath = path.join(baseProjectsDir, encoded, 'sessions-index.json')
    const raw = await fs.readFile(indexPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { version: 1, entries: [] }
  }
}

/**
 * Scan a project directory for .jsonl files not covered by the index.
 * Reads the first line of each file to extract sessionId, cwd, gitBranch,
 * and the first user message for display.
 */
async function scanUnindexedJSONL(projectDir, indexedIds, defaultCwd) {
  const entries = []
  let files = []
  try {
    files = (await fs.readdir(projectDir)).filter(f => f.endsWith('.jsonl'))
  } catch {
    return entries
  }

  await Promise.all(files.map(async (file) => {
    const sessionId = file.replace('.jsonl', '')
    if (indexedIds.has(sessionId)) return

    const filePath = path.join(projectDir, file)
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      if (lines.length === 0) return

      let cwd = defaultCwd
      let gitBranch = ''
      let firstPrompt = ''
      let created = null
      let modified = null

      // Scan events to extract metadata
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (!created && event.timestamp) created = event.timestamp
          if (event.timestamp) modified = event.timestamp
          if (!cwd && event.cwd) cwd = event.cwd
          if (!gitBranch && event.gitBranch) gitBranch = event.gitBranch

          // Extract first user prompt text
          if (!firstPrompt && event.type === 'user') {
            const msg = event.message
            if (typeof msg?.content === 'string') {
              firstPrompt = msg.content
            } else if (Array.isArray(msg?.content)) {
              firstPrompt = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      const stat = await fs.stat(filePath).catch(() => null)

      entries.push({
        id: sessionId,
        name: firstPrompt ? firstPrompt.slice(0, 60) : `Session ${sessionId.slice(0, 8)}`,
        created: created || new Date(stat?.mtime || 0).toISOString(),
        updated: modified || new Date(stat?.mtime || 0).toISOString(),
        cwd,
        messageCount: 0,
        firstPrompt: firstPrompt.slice(0, 200),
        gitBranch,
        fullPath: filePath,
        fileSize: stat?.size || 0,
        lastMessage: null,
      })
    } catch {
      // skip unreadable files
    }
  }))

  return entries
}

/**
 * List sessions for the current project.
 * Reads from both .dario and .claude session indexes, deduplicates by sessionId.
 * Items are tagged with `source` ('dario' | 'claude' | 'both').
 */
export async function listSessions(options = {}) {
  const cwd = process.cwd()
  try {
    await initSessions(cwd)

    const encoded = encodeProjectPath(cwd)

    // Read indexes from both locations
    const ocIndex = await readIndex(cwd)
    const ccIndex = await readIndexFromBase(CLAUDE_PROJECTS_DIR, cwd)

    // Build deduplicated entries — dario takes precedence
    const seen = new Set()
    const ccIds = new Set(ccIndex.entries.map(e => e.sessionId))
    let entries = []

    for (const e of ocIndex.entries) {
      seen.add(e.sessionId)
      const mapped = mapIndexEntry(e, cwd)
      mapped.source = ccIds.has(e.sessionId) ? 'both' : 'dario'
      entries.push(mapped)
    }

    for (const e of ccIndex.entries) {
      if (seen.has(e.sessionId)) continue
      seen.add(e.sessionId)
      const mapped = mapIndexEntry(e, cwd)
      mapped.source = 'claude'
      entries.push(mapped)
    }

    // Fallback: scan raw .jsonl files in both dirs for sessions not in any index
    const darioProjectDir = path.join(PROJECTS_DIR, encoded)
    const claudeProjectDir = path.join(CLAUDE_PROJECTS_DIR, encoded)

    const [darioUnindexed, claudeUnindexed] = await Promise.all([
      scanUnindexedJSONL(darioProjectDir, seen, cwd),
      scanUnindexedJSONL(claudeProjectDir, seen, cwd),
    ])

    for (const e of darioUnindexed) {
      seen.add(e.id)
      e.source = 'dario'
      entries.push(e)
    }
    for (const e of claudeUnindexed) {
      if (seen.has(e.id)) continue
      e.source = 'claude'
      entries.push(e)
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0))

    if (options.search) {
      const q = options.search.toLowerCase()
      entries = entries.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.id || '').toLowerCase().includes(q) ||
        (e.firstPrompt || '').toLowerCase().includes(q)
      )
    }

    if (options.limit) {
      entries = entries.slice(0, options.limit)
    }

    await addFileSizes(entries)
    return entries
  } catch (error) {
    console.error('Failed to list sessions:', error)
    return []
  }
}

/**
 * List sessions from ALL projects.
 * Scans both ~/.dario/projects/ and ~/.claude/projects/.
 * Items tagged with `source` ('dario' | 'claude' | 'both').
 */
export async function listAllProjectSessions(options = {}) {
  try {
    const seen = new Set()
    let allEntries = []

    // Helper to scan one projects dir (index + unindexed JSONL fallback)
    async function scanProjectsDir(projectsDir, sourceName) {
      const dirs = await fs.readdir(projectsDir).catch(() => [])
      for (const dir of dirs) {
        const dirPath = path.join(projectsDir, dir)
        const indexPath = path.join(dirPath, 'sessions-index.json')
        const indexedInDir = new Set()

        // First pass: read index if it exists
        try {
          const raw = await fs.readFile(indexPath, 'utf8')
          const index = JSON.parse(raw)
          const projectPath = index.entries[0]?.projectPath || dir
          for (const e of index.entries) {
            const id = e.sessionId
            indexedInDir.add(id)
            if (seen.has(id)) {
              const existing = allEntries.find(x => x.id === id)
              if (existing) existing.source = 'both'
              continue
            }
            seen.add(id)
            allEntries.push({
              ...mapIndexEntry(e, projectPath),
              projectDir: dir,
              source: sourceName,
            })
          }
        } catch {
          // No index — fall through to JSONL scan
        }

        // Second pass: pick up any .jsonl files not in the index
        const unindexed = await scanUnindexedJSONL(dirPath, seen, dir)
        for (const e of unindexed) {
          if (seen.has(e.id)) continue
          seen.add(e.id)
          allEntries.push({ ...e, projectDir: dir, source: sourceName })
        }
      }
    }

    // Scan dario first (primary)
    await scanProjectsDir(PROJECTS_DIR, 'dario')
    // Then claude (read-only, fills gaps)
    await scanProjectsDir(CLAUDE_PROJECTS_DIR, 'claude')

    // Sort newest first
    allEntries.sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0))

    if (options.search) {
      const q = options.search.toLowerCase()
      allEntries = allEntries.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.id || '').toLowerCase().includes(q) ||
        (e.firstPrompt || '').toLowerCase().includes(q) ||
        (e.cwd || '').toLowerCase().includes(q)
      )
    }

    if (options.limit) {
      allEntries = allEntries.slice(0, options.limit)
    }

    await addFileSizes(allEntries)
    return allEntries
  } catch (error) {
    console.error('Failed to list all project sessions:', error)
    return []
  }
}

/**
 * Get the most recent session.
 */
export async function getLatestSession() {
  const sessions = await listSessions({ limit: 1 })
  if (sessions.length === 0) return null
  return await getSession(sessions[0].id)
}

/**
 * Rename a session (CC 2.0.64+ parity).
 */
export async function renameSession(sessionId, newName) {
  const cwd = process.cwd()
  return await updateSession(sessionId, { name: newName })
}

/**
 * Delete a session (removes JSONL file and index entry).
 */
export async function deleteSession(sessionId) {
  const cwd = process.cwd()
  const session = await getSession(sessionId, cwd)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  try {
    await fs.unlink(getSessionPath(session.id, cwd))
  } catch {
    // File may already be gone
  }
  await removeIndexEntry(session.id, cwd)
  return true
}

/**
 * Export session to markdown format.
 */
export async function exportSessionMarkdown(sessionId, filename = null) {
  const session = await getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  let markdown = `# ${session.name}\n\n`
  markdown += `**Created**: ${new Date(session.created).toLocaleString()}\n`
  markdown += `**Updated**: ${new Date(session.updated).toLocaleString()}\n`
  markdown += `**Working Directory**: ${session.cwd}\n`
  markdown += `**Messages**: ${session.messages.length}\n\n`
  markdown += '---\n\n'

  for (const message of session.messages) {
    const role = message.role === 'user' ? 'You' : 'Claude'
    const timestamp = new Date(message.timestamp).toLocaleTimeString()
    markdown += `## ${role} (${timestamp})\n\n`
    markdown += `${message.content}\n\n`
  }

  const defaultFilename =
    filename || `${session.name.replace(/\s+/g, '_')}_${session.id.slice(0, 8)}.md`
  const exportPath = path.join(process.cwd(), defaultFilename)

  await fs.writeFile(exportPath, markdown)
  return exportPath
}

/**
 * Export session to JSON format.
 */
export async function exportSessionJSON(sessionId, filename = null) {
  const session = await getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  const defaultFilename =
    filename || `${session.name.replace(/\s+/g, '_')}_${session.id.slice(0, 8)}.json`
  const exportPath = path.join(process.cwd(), defaultFilename)

  await fs.writeFile(exportPath, JSON.stringify(session, null, 2))
  return exportPath
}

/**
 * Format session list for display.
 */
export function formatSessionList(sessions) {
  if (sessions.length === 0) {
    return 'No sessions found'
  }

  let output = '\nRecent Sessions:\n'
  output += '\u2500'.repeat(80) + '\n'

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    const created = new Date(session.created).toLocaleDateString()
    const updated = new Date(session.updated).toLocaleTimeString()
    const preview = session.firstPrompt || session.name || '(empty)'

    output += `${i + 1}. ${session.name}\n`
    output += `   ID: ${session.id}\n`
    output += `   Created: ${created} | Updated: ${updated}\n`
    output += `   Messages: ${session.messageCount} | ${preview.slice(0, 50)}...\n`
    output += '\u2500'.repeat(80) + '\n'
  }

  return output
}
