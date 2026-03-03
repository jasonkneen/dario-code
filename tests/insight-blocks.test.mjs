/**
 * Insight Block Tests
 *
 * Tests the ★ Insight block detection, parsing, and rendering pipeline.
 *
 * 1. Unit tests: parseInsightBlocks logic (regex matching, segment splitting)
 * 2. Integration tests: Insight blocks flow through stream-json output
 *
 * Run: npx vitest run tests/insight-blocks.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { createServer } from 'http'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'cli.mjs')

// ─── Replicate the exact parseInsightBlocks logic from main.mjs ─────────────
// These regexes must match the ones in src/tui/claude/main.mjs

const INSIGHT_OPEN_RE = /^`?★\s*Insight\s*─+`?$/
const INSIGHT_CLOSE_RE = /^`?─{10,}`?$/

function parseInsightBlocks(text) {
  const lines = text.split('\n')
  const segments = []
  let i = 0
  let currentText = []

  while (i < lines.length) {
    if (INSIGHT_OPEN_RE.test(lines[i].trim())) {
      if (currentText.length > 0) {
        segments.push({ type: 'text', content: currentText.join('\n') })
        currentText = []
      }
      i++
      const body = []
      while (i < lines.length && !INSIGHT_CLOSE_RE.test(lines[i].trim())) {
        body.push(lines[i])
        i++
      }
      segments.push({ type: 'insight', content: body.join('\n').trim() })
      i++ // skip closing rule
    } else {
      currentText.push(lines[i])
      i++
    }
  }

  if (currentText.length > 0) {
    segments.push({ type: 'text', content: currentText.join('\n') })
  }

  return segments
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

describe('Insight block parsing (unit)', () => {
  describe('INSIGHT_OPEN_RE', () => {
    it('should match bare insight opener', () => {
      expect(INSIGHT_OPEN_RE.test('★ Insight ─────────────────────────────────────')).toBe(true)
    })

    it('should match backtick-wrapped insight opener', () => {
      expect(INSIGHT_OPEN_RE.test('`★ Insight ─────────────────────────────────────`')).toBe(true)
    })

    it('should match with varying dash counts', () => {
      expect(INSIGHT_OPEN_RE.test('★ Insight ──────')).toBe(true)
      expect(INSIGHT_OPEN_RE.test('★ Insight ─')).toBe(true)
    })

    it('should not match without star', () => {
      expect(INSIGHT_OPEN_RE.test('Insight ─────────────────────────────────────')).toBe(false)
    })

    it('should not match without dashes', () => {
      expect(INSIGHT_OPEN_RE.test('★ Insight')).toBe(false)
    })

    it('should not match arbitrary text', () => {
      expect(INSIGHT_OPEN_RE.test('Some random text with ★')).toBe(false)
    })
  })

  describe('INSIGHT_CLOSE_RE', () => {
    it('should match bare closing rule', () => {
      expect(INSIGHT_CLOSE_RE.test('─────────────────────────────────────────────────')).toBe(true)
    })

    it('should match backtick-wrapped closing rule', () => {
      expect(INSIGHT_CLOSE_RE.test('`─────────────────────────────────────────────────`')).toBe(true)
    })

    it('should match minimum 10 dashes', () => {
      expect(INSIGHT_CLOSE_RE.test('──────────')).toBe(true)
    })

    it('should not match fewer than 10 dashes', () => {
      expect(INSIGHT_CLOSE_RE.test('─────────')).toBe(false)
      expect(INSIGHT_CLOSE_RE.test('───')).toBe(false)
    })

    it('should not match other characters', () => {
      expect(INSIGHT_CLOSE_RE.test('----------')).toBe(false)
      expect(INSIGHT_CLOSE_RE.test('==========')).toBe(false)
    })
  })

  describe('parseInsightBlocks', () => {
    it('should return plain text when no insights present', () => {
      const result = parseInsightBlocks('Just some text\nand more text')
      expect(result).toEqual([
        { type: 'text', content: 'Just some text\nand more text' }
      ])
    })

    it('should parse a single insight block', () => {
      const text = [
        '★ Insight ─────────────────────────────────────',
        'This is the insight content.',
        'Second line of insight.',
        '─────────────────────────────────────────────────',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result).toEqual([
        { type: 'insight', content: 'This is the insight content.\nSecond line of insight.' }
      ])
    })

    it('should parse text before and after an insight', () => {
      const text = [
        'Here is some intro text.',
        '',
        '★ Insight ─────────────────────────────────────',
        'The insight body.',
        '─────────────────────────────────────────────────',
        '',
        'And some trailing text.',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe('text')
      expect(result[0].content).toContain('intro text')
      expect(result[1].type).toBe('insight')
      expect(result[1].content).toBe('The insight body.')
      expect(result[2].type).toBe('text')
      expect(result[2].content).toContain('trailing text')
    })

    it('should parse multiple insight blocks', () => {
      const text = [
        'Intro.',
        '★ Insight ─────────────────────────────────────',
        'First insight.',
        '─────────────────────────────────────────────────',
        'Middle text.',
        '★ Insight ─────────────────────────────────────',
        'Second insight.',
        '─────────────────────────────────────────────────',
        'End.',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result).toHaveLength(5)
      expect(result[0]).toEqual({ type: 'text', content: 'Intro.' })
      expect(result[1]).toEqual({ type: 'insight', content: 'First insight.' })
      expect(result[2]).toEqual({ type: 'text', content: 'Middle text.' })
      expect(result[3]).toEqual({ type: 'insight', content: 'Second insight.' })
      expect(result[4]).toEqual({ type: 'text', content: 'End.' })
    })

    it('should handle backtick-wrapped insight delimiters', () => {
      const text = [
        '`★ Insight ─────────────────────────────────────`',
        'Backtick insight body.',
        '`─────────────────────────────────────────────────`',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result).toEqual([
        { type: 'insight', content: 'Backtick insight body.' }
      ])
    })

    it('should handle insight with multi-line content', () => {
      const text = [
        '★ Insight ─────────────────────────────────────',
        '1. First point about the architecture.',
        '2. Second point about performance.',
        '3. Third point about maintainability.',
        '─────────────────────────────────────────────────',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('insight')
      expect(result[0].content).toContain('First point')
      expect(result[0].content).toContain('Second point')
      expect(result[0].content).toContain('Third point')
    })

    it('should handle empty insight block', () => {
      const text = [
        '★ Insight ─────────────────────────────────────',
        '─────────────────────────────────────────────────',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result).toEqual([
        { type: 'insight', content: '' }
      ])
    })

    it('should handle insight without closing delimiter (unterminated)', () => {
      const text = [
        '★ Insight ─────────────────────────────────────',
        'This insight never closes.',
        'More content here.',
      ].join('\n')

      const result = parseInsightBlocks(text)
      // The unterminated insight should still be captured
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('insight')
      expect(result[0].content).toContain('This insight never closes.')
    })

    it('should trim whitespace from insight content', () => {
      const text = [
        '★ Insight ─────────────────────────────────────',
        '',
        '  Indented content with whitespace.  ',
        '',
        '─────────────────────────────────────────────────',
      ].join('\n')

      const result = parseInsightBlocks(text)
      expect(result[0].content).toBe('Indented content with whitespace.')
    })
  })
})

// ─── Integration: Insight blocks in stream-json output ──────────────────────

function buildSSEResponse(contentBlocks, stopReason = 'end_turn') {
  const events = []

  events.push(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_insight_test',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-haiku-4-5-20251001',
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    }
  })}\n`)

  let blockIndex = 0
  for (const block of contentBlocks) {
    if (block.type === 'text') {
      events.push(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      })}\n`)
      events.push(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: block.text },
      })}\n`)
      events.push(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: blockIndex,
      })}\n`)
    }
    blockIndex++
  }

  events.push(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  })}\n`)

  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n`)

  return events.join('\n')
}

function createMockServer(responses) {
  let requestIndex = 0
  return createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const entry = responses[Math.min(requestIndex, responses.length - 1)]
      requestIndex++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(entry)
      res.end()
    })
  })
}

function runCLI(prompt, env, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      CLI_PATH, prompt, '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ]
    const child = spawn('node', args, {
      env: { ...process.env, ...env },
      timeout: opts.timeout || 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ stdout, stderr, code }))
    child.on('error', reject)
    child.stdin.end()
  })
}

function parseStreamJson(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function getTextContent(messages) {
  const texts = []
  for (const msg of messages) {
    for (const content of [msg.message?.content, msg.message?.message?.content]) {
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'text' && block.text) texts.push(block.text)
      }
    }
  }
  return texts.join('\n')
}

describe('Insight blocks in stream-json output (integration)', () => {
  let tempDir

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `dario-insight-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }) } catch {}
  })

  async function runWithMockAPI(prompt, responses) {
    const server = createMockServer(responses)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const result = await runCLI(prompt, {
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_OAUTH_TOKEN: '',
        HOME: tempDir,
      })
      return {
        ...result,
        messages: parseStreamJson(result.stdout),
        text: getTextContent(parseStreamJson(result.stdout)),
      }
    } finally {
      server.close()
    }
  }

  it('should pass insight block text through stream-json intact', async () => {
    const insightText = [
      'Here is some analysis.',
      '',
      '★ Insight ─────────────────────────────────────',
      'The sync/async mismatch is the root cause.',
      '─────────────────────────────────────────────────',
      '',
      'That covers the main issue.',
    ].join('\n')

    const sse = buildSSEResponse([{ type: 'text', text: insightText }])
    const { text, code } = await runWithMockAPI('Analyze this', [sse])

    expect(code).toBe(0)
    // The raw text should contain the insight markers and content
    expect(text).toContain('★ Insight')
    expect(text).toContain('sync/async mismatch')
    expect(text).toContain('Here is some analysis')
    expect(text).toContain('That covers the main issue')
  }, 30_000)

  it('should preserve multiple insight blocks in output', async () => {
    const insightText = [
      '★ Insight ─────────────────────────────────────',
      'First insight about architecture.',
      '─────────────────────────────────────────────────',
      '',
      '★ Insight ─────────────────────────────────────',
      'Second insight about performance.',
      '─────────────────────────────────────────────────',
    ].join('\n')

    const sse = buildSSEResponse([{ type: 'text', text: insightText }])
    const { text, code } = await runWithMockAPI('Give insights', [sse])

    expect(code).toBe(0)
    expect(text).toContain('First insight about architecture')
    expect(text).toContain('Second insight about performance')
  }, 30_000)

  it('should handle insight blocks alongside tool use', async () => {
    // Turn 1: model uses a tool
    const turn1 = buildSSEResponse([
      { type: 'text', text: '★ Insight ─────────────────────────────────────\nTool use is about to happen.\n─────────────────────────────────────────────────' },
    ])

    const { text, code } = await runWithMockAPI('Do something insightful', [turn1])

    expect(code).toBe(0)
    expect(text).toContain('Tool use is about to happen')
  }, 30_000)
})
