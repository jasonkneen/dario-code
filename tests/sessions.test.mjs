/**
 * Test suite for session management module
 *
 * Sessions now use ~/.claude/projects/<encoded-cwd>/ with JSONL files
 * and a sessions-index.json, matching real Claude Code layout.
 *
 * Tests use a temporary directory as CWD to avoid touching real session data.
 */

import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import * as sessions from '../src/sessions/index.mjs'

let TEST_CWD
let PROJECT_DIR
let originalCwd

/**
 * We override process.cwd() to point at a temp dir so sessions
 * are created in an isolated project folder, not the real one.
 */
beforeAll(async () => {
  TEST_CWD = await fs.mkdtemp(path.join(os.tmpdir(), 'dario-test-sessions-'))
  PROJECT_DIR = sessions.getProjectDir(TEST_CWD)
  originalCwd = process.cwd
  process.cwd = () => TEST_CWD
})

afterAll(async () => {
  process.cwd = originalCwd
  // Remove temp project dir and its contents
  try {
    await fs.rm(PROJECT_DIR, { recursive: true, force: true })
  } catch {}
  try {
    await fs.rm(TEST_CWD, { recursive: true, force: true })
  } catch {}
})

async function cleanupSessions() {
  try {
    const files = await fs.readdir(PROJECT_DIR)
    for (const file of files) {
      if (file.endsWith('.jsonl') || file === 'sessions-index.json') {
        await fs.unlink(path.join(PROJECT_DIR, file)).catch(() => {})
      }
    }
  } catch {
    // Directory might not exist yet
  }
}

beforeEach(async () => {
  await cleanupSessions()
  await sessions.initSessions()
})

afterEach(async () => {
  await cleanupSessions()
})

test('should create a new session', async () => {
  const session = await sessions.createSession('Test Session')

  expect(session).toBeDefined()
  expect(session.id).toBeDefined()
  expect(session.name).toBe('Test Session')
  expect(session.messages).toEqual([])
  expect(session.created).toBeDefined()
  expect(session.updated).toBeDefined()
})

test('should create session with auto-generated name', async () => {
  const session = await sessions.createSession()

  expect(session.name).toMatch(/^Session /)
})

test('should store session as JSONL file', async () => {
  const session = await sessions.createSession('JSONL Test')
  const jsonlPath = path.join(PROJECT_DIR, `${session.id}.jsonl`)

  const content = await fs.readFile(jsonlPath, 'utf8')
  const lines = content.trim().split('\n')
  expect(lines.length).toBeGreaterThanOrEqual(1)

  const firstEvent = JSON.parse(lines[0])
  expect(firstEvent.type).toBe('session-start')
  expect(firstEvent.sessionId).toBe(session.id)
  expect(firstEvent.name).toBe('JSONL Test')
})

test('should update sessions-index.json on create', async () => {
  const session = await sessions.createSession('Indexed')
  const indexPath = path.join(PROJECT_DIR, 'sessions-index.json')

  const content = await fs.readFile(indexPath, 'utf8')
  const index = JSON.parse(content)
  expect(index.version).toBe(1)
  expect(index.entries.some(e => e.sessionId === session.id)).toBe(true)
})

test('should retrieve a session by ID', async () => {
  const created = await sessions.createSession('Test')
  const retrieved = await sessions.getSession(created.id)

  expect(retrieved.id).toBe(created.id)
  expect(retrieved.name).toBe('Test')
})

test('should retrieve a session by partial ID', async () => {
  const created = await sessions.createSession('Test')
  const partial = created.id.substring(0, 8)
  const retrieved = await sessions.getSession(partial)

  expect(retrieved.id).toBe(created.id)
})

test('should return null for non-existent session', async () => {
  const session = await sessions.getSession('nonexistent')
  expect(session).toBeNull()
})

test('should update a session', async () => {
  const session = await sessions.createSession('Original')
  // Small delay so updated timestamp differs from created timestamp
  await new Promise(resolve => setTimeout(resolve, 10))
  const updated = await sessions.updateSession(session.id, {
    name: 'Updated'
  })

  expect(updated.name).toBe('Updated')
  expect(updated.updated).not.toEqual(session.updated)
})

test('should add messages to a session', async () => {
  const session = await sessions.createSession('Test')

  await sessions.addMessage(session.id, 'user', 'Hello')
  await sessions.addMessage(session.id, 'assistant', 'Hi there')

  const retrieved = await sessions.getSession(session.id)
  expect(retrieved.messages).toHaveLength(2)
  expect(retrieved.messages[0].role).toBe('user')
  expect(retrieved.messages[0].content).toBe('Hello')
  expect(retrieved.messages[1].role).toBe('assistant')
  expect(retrieved.messages[1].content).toBe('Hi there')
})

test('should update index firstPrompt on first user message', async () => {
  const session = await sessions.createSession('Test')
  await sessions.addMessage(session.id, 'user', 'What is the meaning of life?')

  const indexPath = path.join(PROJECT_DIR, 'sessions-index.json')
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  const entry = index.entries.find(e => e.sessionId === session.id)
  expect(entry.firstPrompt).toBe('What is the meaning of life?')
})

test('should list all sessions', async () => {
  await sessions.createSession('Session 1')
  await sessions.createSession('Session 2')
  await sessions.createSession('Session 3')

  const list = await sessions.listSessions()

  expect(list).toHaveLength(3)
  expect(list[0].name).toBeDefined()
  expect(list[0].id).toBeDefined()
})

test('should list sessions with limit', async () => {
  await sessions.createSession('Session 1')
  await sessions.createSession('Session 2')
  await sessions.createSession('Session 3')

  const list = await sessions.listSessions({ limit: 2 })

  expect(list).toHaveLength(2)
})

test('should search sessions by name', async () => {
  await sessions.createSession('Bug Fix Session')
  await sessions.createSession('Feature Work')
  await sessions.createSession('Bug Investigation')

  const list = await sessions.listSessions({ search: 'Bug' })

  expect(list).toHaveLength(2)
  expect(list.some(s => s.name.includes('Bug'))).toBe(true)
})

test('should get latest session', async () => {
  const session1 = await sessions.createSession('First')
  await new Promise(resolve => setTimeout(resolve, 10))
  const session2 = await sessions.createSession('Second')

  const latest = await sessions.getLatestSession()

  expect(latest.id).toBe(session2.id)
})

test('should sort sessions by updated date (newest first)', async () => {
  const session1 = await sessions.createSession('Old')
  await new Promise(resolve => setTimeout(resolve, 10))
  const session2 = await sessions.createSession('New')

  const list = await sessions.listSessions()

  expect(list[0].id).toBe(session2.id)
  expect(list[1].id).toBe(session1.id)
})

test('should delete a session', async () => {
  const session = await sessions.createSession('To Delete')
  await sessions.deleteSession(session.id)

  const retrieved = await sessions.getSession(session.id)
  expect(retrieved).toBeNull()
})

test('should format session list for display', () => {
  const sessionList = [
    {
      id: 'abc123',
      name: 'Test Session',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd: '/test',
      messageCount: 5,
      firstPrompt: 'Hello world'
    }
  ]

  const formatted = sessions.formatSessionList(sessionList)

  expect(formatted).toContain('Test Session')
  expect(formatted).toContain('abc123')
  expect(formatted).toContain('Hello world')
})

test('should handle empty session list in format', () => {
  const formatted = sessions.formatSessionList([])
  expect(formatted).toBe('No sessions found')
})

test('should export session to markdown', async () => {
  const session = await sessions.createSession('Test')
  await sessions.addMessage(session.id, 'user', 'Hello')
  await sessions.addMessage(session.id, 'assistant', 'Hi')

  const exportPath = await sessions.exportSessionMarkdown(session.id)

  expect(exportPath).toBeDefined()
  const content = await fs.readFile(exportPath, 'utf8')
  expect(content).toContain('Test')
  expect(content).toContain('Hello')
  expect(content).toContain('Hi')
  expect(content).toContain('# ')

  await fs.unlink(exportPath)
})

test('should export session to json', async () => {
  const session = await sessions.createSession('Test')
  await sessions.addMessage(session.id, 'user', 'Hello')
  await sessions.addMessage(session.id, 'assistant', 'Hi')

  const exportPath = await sessions.exportSessionJSON(session.id)

  expect(exportPath).toBeDefined()
  const content = await fs.readFile(exportPath, 'utf8')
  const json = JSON.parse(content)
  expect(json.name).toBe('Test')
  expect(json.messages).toHaveLength(2)

  await fs.unlink(exportPath)
})

test('should maintain message timestamps', async () => {
  const session = await sessions.createSession('Test')
  const before = new Date()
  await sessions.addMessage(session.id, 'user', 'Hello')
  const after = new Date()

  const retrieved = await sessions.getSession(session.id)
  const msgTime = new Date(retrieved.messages[0].timestamp)

  expect(msgTime.getTime()).toBeGreaterThanOrEqual(before.getTime())
  expect(msgTime.getTime()).toBeLessThanOrEqual(after.getTime())
})

test('should preserve message order', async () => {
  const session = await sessions.createSession('Test')
  const messages = [
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Second' },
    { role: 'user', content: 'Third' },
    { role: 'assistant', content: 'Fourth' }
  ]

  for (const msg of messages) {
    await sessions.addMessage(session.id, msg.role, msg.content)
  }

  const retrieved = await sessions.getSession(session.id)
  expect(retrieved.messages.map(m => m.content)).toEqual([
    'First',
    'Second',
    'Third',
    'Fourth'
  ])
})

test('should encode project path correctly', () => {
  expect(sessions.encodeProjectPath('/Users/jkneen/myproject')).toBe('-Users-jkneen-myproject')
  expect(sessions.encodeProjectPath('/foo/bar/baz')).toBe('-foo-bar-baz')
  // Underscores also become dashes (matching real Claude Code)
  expect(sessions.encodeProjectPath('/Users/jkneen/my_project')).toBe('-Users-jkneen-my-project')
  expect(sessions.encodeProjectPath('C:\\Users\\jkneen\\my_project')).toBe('C-Users-jkneen-my-project')
})

test('sessions are project-scoped (per CWD)', () => {
  const dir1 = sessions.getProjectDir('/Users/alice/project-a')
  const dir2 = sessions.getProjectDir('/Users/alice/project-b')
  expect(dir1).not.toBe(dir2)
  expect(dir1).toContain('-Users-alice-project-a')
  expect(dir2).toContain('-Users-alice-project-b')
})

test('should read real Claude Code JSONL format (no session-start event)', async () => {
  // Simulate a real Claude Code session: queue-operation → user → assistant
  const sessionId = 'real-cc-test-' + Date.now()
  const jsonlPath = path.join(PROJECT_DIR, `${sessionId}.jsonl`)

  const events = [
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-01-27T00:07:03.307Z', sessionId },
    {
      type: 'user',
      sessionId,
      cwd: '/Users/test/project',
      gitBranch: 'main',
      version: '2.1.19',
      message: { role: 'user', content: [{ type: 'text', text: 'How do I fix this bug?' }] },
      timestamp: '2026-01-27T00:07:03.311Z',
    },
    {
      type: 'assistant',
      sessionId,
      cwd: '/Users/test/project',
      gitBranch: 'main',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the fix...' }],
        model: 'claude-opus-4-5-20251101',
      },
      timestamp: '2026-01-27T00:07:05.067Z',
    },
  ]

  // Write the JSONL file directly (simulating real CC output)
  await fs.writeFile(jsonlPath, events.map(e => JSON.stringify(e)).join('\n') + '\n')

  const session = await sessions.getSession(sessionId)
  expect(session).not.toBeNull()
  expect(session.id).toBe(sessionId)
  expect(session.messages).toHaveLength(2)
  expect(session.messages[0].role).toBe('user')
  expect(session.messages[0].content).toBe('How do I fix this bug?')
  expect(session.messages[1].role).toBe('assistant')
  expect(session.messages[1].content).toBe('Here is the fix...')
  expect(session.cwd).toBe('/Users/test/project')
  expect(session.gitBranch).toBe('main')
  // Name should be derived from first prompt
  expect(session.name).toContain('How do I fix this bug?')
})

test('should list sessions from existing real CC index entries', async () => {
  // Write an index with a real CC entry (no name field, has fileMtime/isSidechain)
  const indexPath = path.join(PROJECT_DIR, 'sessions-index.json')
  const fakeIndex = {
    version: 1,
    entries: [
      {
        sessionId: 'real-cc-abc123',
        fullPath: '/fake/path.jsonl',
        fileMtime: Date.now(),
        firstPrompt: 'explain this error message',
        messageCount: 42,
        created: '2026-01-15T10:00:00.000Z',
        modified: '2026-01-15T11:30:00.000Z',
        gitBranch: 'feature-branch',
        projectPath: '/Users/test/project',
        isSidechain: false,
      },
    ],
  }
  await fs.writeFile(indexPath, JSON.stringify(fakeIndex, null, 2))

  const list = await sessions.listSessions()
  expect(list).toHaveLength(1)
  expect(list[0].id).toBe('real-cc-abc123')
  expect(list[0].name).toBe('explain this error message')
  expect(list[0].messageCount).toBe(42)
  expect(list[0].gitBranch).toBe('feature-branch')
  expect(list[0].firstPrompt).toBe('explain this error message')
})
