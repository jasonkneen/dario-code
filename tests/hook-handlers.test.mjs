/**
 * Tests for multi-type hook handler dispatch (HTYP-01 through HTYP-04)
 *
 * HTYP-01: HTTP handler POSTs event JSON to URL
 * HTYP-02: Prompt handler sends prompt to Claude for allow/deny
 * HTYP-03: Agent handler spawns read-only subagent
 * HTYP-04: Async mode fires command without blocking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock config.mjs so loadSettings returns controlled data
vi.mock('../src/core/config.mjs', () => ({
  loadSettings: vi.fn(() => ({})),
}))

// Mock the API client
vi.mock('../src/api/client.mjs', () => ({
  getClient: vi.fn(),
}))

// Mock the subagent module
vi.mock('../src/agents/subagent.mjs', () => ({
  createAgentConfig: vi.fn((opts) => ({ ...opts, _mock: true })),
  spawnAgent: vi.fn(),
  AgentType: { EXPLORE: 'explore' },
}))

import { loadSettings } from '../src/core/config.mjs'
import { getClient } from '../src/api/client.mjs'
import { createAgentConfig, spawnAgent, AgentType } from '../src/agents/subagent.mjs'
import {
  normalizeHookConfig,
  clearOnceState,
  clearHookSnapshot,
} from '../src/core/hooks.mjs'

beforeEach(() => {
  vi.clearAllMocks()
  clearOnceState()
  clearHookSnapshot()
})

// ============================================================================
// normalizeHandler: preserve new fields (async, url, prompt, model)
// ============================================================================
describe('normalizeHandler preserves new fields', () => {
  it('preserves async field', () => {
    const input = [{ matcher: 'Bash', hooks: [{ command: ['./x.sh'], async: true }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].async).toBe(true)
  })

  it('defaults async to false', () => {
    const input = [{ matcher: 'Bash', hooks: [{ command: ['./x.sh'] }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].async).toBe(false)
  })

  it('preserves url field for HTTP hooks', () => {
    const input = [{ matcher: 'Bash', hooks: [{ type: 'http', url: 'https://example.com/hook' }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].url).toBe('https://example.com/hook')
  })

  it('defaults url to null', () => {
    const input = [{ matcher: 'Bash', hooks: [{ command: ['./x.sh'] }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].url).toBeNull()
  })

  it('preserves prompt field for prompt hooks', () => {
    const input = [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Is this safe?' }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].prompt).toBe('Is this safe?')
  })

  it('defaults prompt to null', () => {
    const input = [{ matcher: 'Bash', hooks: [{ command: ['./x.sh'] }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].prompt).toBeNull()
  })

  it('preserves model field for prompt hooks', () => {
    const input = [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'check', model: 'claude-sonnet-4-20250514' }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].model).toBe('claude-sonnet-4-20250514')
  })

  it('defaults model to null', () => {
    const input = [{ matcher: 'Bash', hooks: [{ command: ['./x.sh'] }] }]
    const result = normalizeHookConfig(input)
    expect(result[0].hooks[0].model).toBeNull()
  })
})

// ============================================================================
// HTYP-01: HTTP handler
// ============================================================================
describe('HTYP-01: executeHttpHook', () => {
  let executeHttpHook

  beforeEach(async () => {
    const hooks = await import('../src/core/hooks.mjs')
    executeHttpHook = hooks.executeHttpHook
  })

  it('is exported as a function', () => {
    expect(typeof executeHttpHook).toBe('function')
  })

  it('POSTs JSON to handler.url', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ action: 'continue' }) }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const handler = { url: 'https://example.com/hook', timeout: 5000 }
    const context = { hookType: 'PreToolUse', toolName: 'Bash', input: { cmd: 'ls' }, sessionId: 'sess-1' }

    const result = await executeHttpHook(handler, context)

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )

    // Verify request body includes expected fields
    const callArgs = global.fetch.mock.calls[0]
    const body = JSON.parse(callArgs[1].body)
    expect(body.hookType).toBe('PreToolUse')
    expect(body.toolName).toBe('Bash')
    expect(body.input).toEqual({ cmd: 'ls' })
    expect(body.sessionId).toBe('sess-1')
  })

  it('falls back to command[0] when url not set', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ action: 'continue' }) }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const handler = { command: ['https://fallback.com/hook'] }
    const context = { hookType: 'PreToolUse' }

    await executeHttpHook(handler, context)
    expect(global.fetch).toHaveBeenCalledWith('https://fallback.com/hook', expect.anything())
  })

  it('parses action/message/reason from JSON response', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ action: 'block', message: 'Blocked!', reason: 'unsafe' }),
    }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const result = await executeHttpHook({ url: 'https://example.com' }, { hookType: 'PreToolUse' })
    expect(result.action).toBe('block')
    expect(result.message).toBe('Blocked!')
    expect(result.reason).toBe('unsafe')
  })

  it('parses modifiedInput from response', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({ action: 'modify', modifiedInput: { cmd: 'ls -la' } }),
    }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const result = await executeHttpHook({ url: 'https://example.com' }, { hookType: 'PreToolUse' })
    expect(result.action).toBe('modify')
    expect(result.modifiedInput).toEqual({ cmd: 'ls -la' })
  })

  it('returns success:false action:continue on fetch error', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('Network error')))

    const result = await executeHttpHook({ url: 'https://example.com' }, { hookType: 'PreToolUse' })
    expect(result.success).toBe(false)
    expect(result.action).toBe('continue')
  })

  it('uses AbortController for timeout', async () => {
    // Slow fetch that never resolves quickly
    global.fetch = vi.fn((_url, opts) => {
      return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'))
        })
      })
    })

    const result = await executeHttpHook({ url: 'https://example.com', timeout: 50 }, { hookType: 'PreToolUse' })
    expect(result.success).toBe(false)
    expect(result.action).toBe('continue')
  })

  afterEach(() => {
    delete global.fetch
  })
})

// ============================================================================
// HTYP-02: Prompt handler
// ============================================================================
describe('HTYP-02: executePromptHook', () => {
  let executePromptHook

  beforeEach(async () => {
    const hooks = await import('../src/core/hooks.mjs')
    executePromptHook = hooks.executePromptHook
  })

  it('is exported as a function', () => {
    expect(typeof executePromptHook).toBe('function')
  })

  it('sends prompt to Claude and maps allow to continue', async () => {
    const mockClient = {
      messages: {
        create: vi.fn(() => Promise.resolve({
          content: [{ text: '{"decision": "allow"}' }],
        })),
      },
    }
    getClient.mockResolvedValue(mockClient)

    const handler = { prompt: 'Is this tool call safe?', model: 'claude-haiku-4-5-20251001' }
    const context = { hookType: 'PreToolUse', toolName: 'Bash', input: { cmd: 'rm -rf /' } }

    const result = await executePromptHook(handler, context)
    expect(result.success).toBe(true)
    expect(result.action).toBe('continue')
    expect(mockClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
      })
    )
  })

  it('maps deny to block with reason', async () => {
    const mockClient = {
      messages: {
        create: vi.fn(() => Promise.resolve({
          content: [{ text: '{"decision": "deny", "reason": "dangerous command"}' }],
        })),
      },
    }
    getClient.mockResolvedValue(mockClient)

    const handler = { prompt: 'Is this safe?' }
    const context = { hookType: 'PreToolUse', toolName: 'Bash' }

    const result = await executePromptHook(handler, context)
    expect(result.success).toBe(true)
    expect(result.action).toBe('block')
    expect(result.reason).toBe('dangerous command')
  })

  it('falls back to command[0] when prompt not set', async () => {
    const mockClient = {
      messages: {
        create: vi.fn(() => Promise.resolve({
          content: [{ text: '{"decision": "allow"}' }],
        })),
      },
    }
    getClient.mockResolvedValue(mockClient)

    const handler = { command: ['Check if this is safe'] }
    const context = { hookType: 'PreToolUse' }

    await executePromptHook(handler, context)

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    expect(callArgs.messages[0].content).toContain('Check if this is safe')
  })

  it('defaults model to claude-haiku-4-5-20251001', async () => {
    const mockClient = {
      messages: {
        create: vi.fn(() => Promise.resolve({
          content: [{ text: '{"decision": "allow"}' }],
        })),
      },
    }
    getClient.mockResolvedValue(mockClient)

    const handler = { prompt: 'check' }
    const context = { hookType: 'PreToolUse' }

    await executePromptHook(handler, context)

    const callArgs = mockClient.messages.create.mock.calls[0][0]
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001')
  })

  it('returns success:false action:continue on API error', async () => {
    getClient.mockRejectedValue(new Error('No API key'))

    const handler = { prompt: 'check' }
    const context = { hookType: 'PreToolUse' }

    const result = await executePromptHook(handler, context)
    expect(result.success).toBe(false)
    expect(result.action).toBe('continue')
  })
})

// ============================================================================
// HTYP-03: Agent handler
// ============================================================================
describe('HTYP-03: executeAgentHook', () => {
  let executeAgentHook

  beforeEach(async () => {
    const hooks = await import('../src/core/hooks.mjs')
    executeAgentHook = hooks.executeAgentHook
  })

  it('is exported as a function', () => {
    expect(typeof executeAgentHook).toBe('function')
  })

  it('spawns a read-only subagent with EXPLORE type', async () => {
    spawnAgent.mockResolvedValue({ message: 'Analysis complete' })

    const handler = { command: ['Analyze this code for security issues'] }
    const context = { hookType: 'PreToolUse', toolName: 'Bash' }

    const result = await executeAgentHook(handler, context)

    expect(createAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AgentType.EXPLORE,
      })
    )
    expect(spawnAgent).toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.action).toBe('continue')
    expect(result.message).toBe('Analysis complete')
  })

  it('uses command[0] as system prompt', async () => {
    spawnAgent.mockResolvedValue({ message: 'done' })

    const handler = { command: ['Review this for issues'] }
    const context = { hookType: 'PreToolUse' }

    await executeAgentHook(handler, context)

    expect(createAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'Review this for issues',
      })
    )
  })

  it('returns success:false action:continue on error', async () => {
    spawnAgent.mockRejectedValue(new Error('Agent spawn failed'))

    const handler = { command: ['analyze'] }
    const context = { hookType: 'PreToolUse' }

    const result = await executeAgentHook(handler, context)
    expect(result.success).toBe(false)
    expect(result.action).toBe('continue')
  })
})

// ============================================================================
// HTYP-04: Async mode
// ============================================================================
describe('HTYP-04: Async mode', () => {
  let dispatchHook

  beforeEach(async () => {
    const hooks = await import('../src/core/hooks.mjs')
    dispatchHook = hooks.dispatchHook
  })

  it('dispatchHook is exported as a function', () => {
    expect(typeof dispatchHook).toBe('function')
  })

  it('async command hook returns immediately with success:true action:continue', async () => {
    const handler = { type: 'command', command: ['echo', 'background'], async: true }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)

    expect(result.success).toBe(true)
    expect(result.action).toBe('continue')
  })

  it('async flag is ignored for non-command types (runs sync)', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ action: 'block' }) }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const handler = { type: 'http', url: 'https://example.com', async: true }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    // Should run synchronously and return the actual HTTP result
    expect(result.action).toBe('block')

    delete global.fetch
  })
})

// ============================================================================
// dispatchHook: type-based routing
// ============================================================================
describe('dispatchHook type routing', () => {
  let dispatchHook

  beforeEach(async () => {
    const hooks = await import('../src/core/hooks.mjs')
    dispatchHook = hooks.dispatchHook
  })

  it('routes type:http to executeHttpHook', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ action: 'continue' }) }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const handler = { type: 'http', url: 'https://example.com/hook' }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    expect(global.fetch).toHaveBeenCalled()
    expect(result.action).toBe('continue')

    delete global.fetch
  })

  it('routes type:prompt to executePromptHook', async () => {
    const mockClient = {
      messages: {
        create: vi.fn(() => Promise.resolve({
          content: [{ text: '{"decision": "allow"}' }],
        })),
      },
    }
    getClient.mockResolvedValue(mockClient)

    const handler = { type: 'prompt', prompt: 'Is this safe?' }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    expect(mockClient.messages.create).toHaveBeenCalled()
    expect(result.action).toBe('continue')
  })

  it('routes type:agent to executeAgentHook', async () => {
    spawnAgent.mockResolvedValue({ message: 'done' })

    const handler = { type: 'agent', command: ['analyze'] }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    expect(spawnAgent).toHaveBeenCalled()
    expect(result.action).toBe('continue')
  })

  it('routes type:command to existing executeHook', async () => {
    // command type with a simple echo — will attempt spawn
    const handler = { type: 'command', command: ['echo', 'hello'] }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    // Should complete (echo is fast)
    expect(result).toBeDefined()
    expect(result.action).toBeDefined()
  })

  it('defaults to command handler when type missing', async () => {
    const handler = { command: ['echo', 'hello'] }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    expect(result).toBeDefined()
  })

  it('attaches statusMessage to result', async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ action: 'continue' }) }
    global.fetch = vi.fn(() => Promise.resolve(mockResponse))

    const handler = { type: 'http', url: 'https://example.com', statusMessage: 'Checking webhook...' }
    const context = { hookType: 'PreToolUse' }

    const result = await dispatchHook(handler, context)
    expect(result.statusMessage).toBe('Checking webhook...')

    delete global.fetch
  })
})
