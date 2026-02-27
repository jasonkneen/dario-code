/**
 * Auto Memories — cross-session fact extraction and persistence
 * (CC 2.1.32 parity)
 *
 * Extracts durable facts from conversation history and stores them in
 * .claude/memory/ (project-level) or ~/.claude/memory/ (global).
 * These memories are injected into every new session's system prompt.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const MEMORY_DIR_NAME = 'memory'
const CLAUDE_DIR_NAME = '.claude'

/**
 * Get the memory directory path for a given scope
 */
export function getMemoryDir(scope = 'project', cwd = process.cwd()) {
  if (scope === 'global') {
    return path.join(os.homedir(), CLAUDE_DIR_NAME, MEMORY_DIR_NAME)
  }
  return path.join(cwd, CLAUDE_DIR_NAME, MEMORY_DIR_NAME)
}

/**
 * Ensure a memory directory exists
 */
function ensureMemoryDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Sanitize a key for use as a filename (lowercase, hyphens, no special chars)
 */
function sanitizeKey(key) {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

/**
 * Save a memory fact to disk.
 * File format: YAML frontmatter + markdown body.
 *
 * @param {{ key: string, value: string, source?: string, timestamp?: string }} fact
 * @param {'project'|'global'} scope
 * @param {string} cwd
 */
export function saveMemory(fact, scope = 'project', cwd = process.cwd()) {
  const dir = getMemoryDir(scope, cwd)
  ensureMemoryDir(dir)

  const safeKey = sanitizeKey(fact.key)
  const filePath = path.join(dir, `${safeKey}.md`)

  const timestamp = fact.timestamp || new Date().toISOString()
  const source = fact.source || 'auto'

  const content = `---
key: ${fact.key}
source: ${source}
timestamp: ${timestamp}
scope: ${scope}
---
${fact.value}
`

  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * Load all memories from the memory directories.
 *
 * @param {string} cwd
 * @returns {Map<string, { key, value, source, timestamp, scope, filePath }>}
 */
export function loadMemories(cwd = process.cwd()) {
  const memories = new Map()

  // Global first (lower priority)
  const globalDir = getMemoryDir('global', cwd)
  loadMemoriesFromDir(globalDir, 'global', memories)

  // Project second (higher priority — overwrites global if same key)
  const projectDir = getMemoryDir('project', cwd)
  loadMemoriesFromDir(projectDir, 'project', memories)

  return memories
}

function loadMemoriesFromDir(dir, scope, memories) {
  if (!fs.existsSync(dir)) return

  let files
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
  } catch {
    return
  }

  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseMemoryFile(raw, filePath, scope)
      if (parsed) {
        memories.set(parsed.key, parsed)
      }
    } catch {
      // Skip unreadable files
    }
  }
}

function parseMemoryFile(content, filePath, scope) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const frontmatter = match[1]
  const body = match[2].trim()

  const meta = {}
  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.+)$/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }

  return {
    key: meta.key || path.basename(filePath, '.md'),
    value: body,
    source: meta.source || 'auto',
    timestamp: meta.timestamp || '',
    scope: meta.scope || scope,
    filePath,
  }
}

/**
 * Delete a memory fact by key.
 *
 * @param {string} key
 * @param {'project'|'global'|'all'} scope
 * @param {string} cwd
 * @returns {boolean} true if deleted
 */
export function deleteMemory(key, scope = 'all', cwd = process.cwd()) {
  const safeKey = sanitizeKey(key)
  let deleted = false

  const scopes = scope === 'all' ? ['project', 'global'] : [scope]
  for (const s of scopes) {
    const filePath = path.join(getMemoryDir(s, cwd), `${safeKey}.md`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      deleted = true
    }
  }

  return deleted
}

/**
 * Clear all auto-extracted memories from a scope.
 *
 * @param {'project'|'global'|'all'} scope
 * @param {string} cwd
 * @returns {number} number of files deleted
 */
export function clearMemories(scope = 'project', cwd = process.cwd()) {
  let count = 0
  const scopes = scope === 'all' ? ['project', 'global'] : [scope]

  for (const s of scopes) {
    const dir = getMemoryDir(s, cwd)
    if (!fs.existsSync(dir)) continue

    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(dir, file))
          count++
        } catch {}
      }
    } catch {}
  }

  return count
}

/**
 * Format loaded memories as a system prompt section.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function buildMemoryContext(cwd = process.cwd()) {
  const memories = loadMemories(cwd)
  if (memories.size === 0) return ''

  const lines = ['# Memories', '']
  for (const { key, value } of memories.values()) {
    lines.push(`## ${key}`)
    lines.push(value)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Determine whether extraction should run.
 * Returns true if >5 new assistant turns since last extraction, or >10 min elapsed.
 *
 * @param {Array} messages - current message array
 * @param {number} lastExtractedAt - epoch ms of last extraction (0 = never)
 * @param {number} lastExtractedTurnCount - assistant turn count at last extraction
 * @returns {boolean}
 */
export function shouldExtract(messages, lastExtractedAt = 0, lastExtractedTurnCount = 0) {
  const assistantTurns = messages.filter(m =>
    (m.role || m.message?.role) === 'assistant'
  ).length

  const newTurns = assistantTurns - lastExtractedTurnCount
  if (newTurns >= 5) return true

  const elapsedMs = Date.now() - lastExtractedAt
  if (lastExtractedAt > 0 && elapsedMs >= 10 * 60 * 1000) return true

  return false
}

const EXTRACTION_PROMPT = `You are a memory extractor for an AI coding assistant session.
Your task is to analyze the conversation and extract durable, reusable facts about the user's project, preferences, or recurring patterns.

Rules:
- Only extract facts that would be useful across multiple future sessions.
- Do not extract ephemeral task details or one-off instructions.
- Each fact should have a short unique key (snake_case) and a concise value (1-3 sentences max).
- Skip facts already covered by the existing memories listed below.
- Return a JSON array of objects: [{"key": "...", "value": "..."}]
- Return an empty array [] if there are no new durable facts to extract.
- Return ONLY valid JSON, no explanation.

Existing memories (skip these):
EXISTING_MEMORIES

Conversation to analyze:
CONVERSATION
`

/**
 * Extract new memories from recent messages using AI.
 * Calls the Anthropic API via the project's streaming module.
 *
 * @param {Array} messages - conversation messages
 * @param {Map} existingMemories - already-saved memories
 * @returns {Promise<Array<{ key, value }>>} new facts to save
 */
export async function extractMemories(messages, existingMemories = new Map()) {
  // Only send a bounded slice to the summarization call
  const MAX_MESSAGES = 40
  const recent = messages.slice(-MAX_MESSAGES)

  const conversationText = recent.map(m => {
    const role = m.role || m.message?.role || 'unknown'
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content).slice(0, 500)
    return `${role}: ${content}`
  }).join('\n\n')

  const existingText = existingMemories.size === 0
    ? '(none)'
    : Array.from(existingMemories.values())
        .map(({ key, value }) => `- ${key}: ${value}`)
        .join('\n')

  const prompt = EXTRACTION_PROMPT
    .replace('EXISTING_MEMORIES', existingText)
    .replace('CONVERSATION', conversationText)

  try {
    // Dynamic import to avoid circular deps at module level
    const { runQuery } = await import('../api/streaming.mjs')
    const result = await runQuery(prompt, [], {
      model: process.env.OPENCLAUDE_COMPACT_MODEL || 'claude-haiku-4-5-20251001',
    })

    const text = result[0]?.message?.content?.[0]?.text || '[]'

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const facts = JSON.parse(jsonMatch[0])
    if (!Array.isArray(facts)) return []

    return facts.filter(f => f && typeof f.key === 'string' && typeof f.value === 'string')
  } catch {
    return []
  }
}

export default {
  getMemoryDir,
  saveMemory,
  loadMemories,
  deleteMemory,
  clearMemories,
  buildMemoryContext,
  shouldExtract,
  extractMemories,
}
