/**
 * Streaming API for Claude conversation
 * This handles the core message streaming loop
 */

import { getClient } from './client.mjs'
import { getClientForModel, stripProviderPrefix, getProviderIdForModel } from '../providers/client-factory.mjs'
import { executeToolUse } from '../tools/executor.mjs'
import { createMessage } from '../utils/messages.mjs'
import { formatError } from '../utils/errors.mjs'
import { isFastMode, loadConfig } from '../core/config.mjs'
import { StandardRetryStrategy } from './retry.mjs'

// Session-level shared readFileTimestamps so Read → Write/Edit can track across tool calls
const sessionReadFileTimestamps = {}

// Model pricing per million tokens (input / output)
const MODEL_PRICING = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-5-20250514': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5-20241022': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
  'claude-sonnet-3-5-20241022': { input: 3, output: 15 },
  'claude-haiku-3-5-20241022': { input: 0.25, output: 1.25 },
}

// Session-level token and cost tracking
const sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUSD: 0,
  turns: 0,
}

/**
 * Get session usage stats
 */
export function getSessionUsage() {
  return { ...sessionUsage }
}

/**
 * Reset session-level read file timestamps (call when starting new session)
 */
export function resetReadFileTimestamps() {
  for (const key of Object.keys(sessionReadFileTimestamps)) {
    delete sessionReadFileTimestamps[key]
  }
}

/**
 * Reset session usage tracking
 */
export function resetSessionUsage() {
  sessionUsage.inputTokens = 0
  sessionUsage.outputTokens = 0
  sessionUsage.cacheCreationTokens = 0
  sessionUsage.cacheReadTokens = 0
  sessionUsage.costUSD = 0
  sessionUsage.turns = 0
}

/**
 * Calculate cost for a given usage and model
 */
function calculateCost(usage, model) {
  // Find pricing - try exact match first, then prefix match
  let pricing = MODEL_PRICING[model]
  if (!pricing) {
    const key = Object.keys(MODEL_PRICING).find(k => model?.startsWith(k.split('-').slice(0, -1).join('-')))
    pricing = key ? MODEL_PRICING[key] : { input: 3, output: 15 } // Default to Sonnet pricing
  }

  const inputCost = ((usage.input_tokens || 0) / 1_000_000) * pricing.input
  const outputCost = ((usage.output_tokens || 0) / 1_000_000) * pricing.output
  const cacheCreationCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.input * 1.25
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.input * 0.1

  return inputCost + outputCost + cacheCreationCost + cacheReadCost
}

/**
 * Estimate token count for messages (rough: ~4 chars per token)
 */
function estimateTokenCount(messages) {
  let chars = 0
  for (const msg of messages) {
    const content = msg.message?.content || msg.content
    if (typeof content === 'string') {
      chars += content.length
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') chars += (block.text || '').length
        else if (block.type === 'tool_use') chars += JSON.stringify(block.input || {}).length
        else if (block.type === 'tool_result') chars += (typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content || '').length)
      }
    }
  }
  return Math.ceil(chars / 4)
}

// Context window limits per model family
const CONTEXT_LIMITS = {
  'opus': 200000,
  'sonnet': 200000,
  'haiku': 200000,
}

// Retry strategy instance
const retryStrategy = new StandardRetryStrategy(3)

/**
 * Stream a conversation turn with Claude
 * Core streaming loop for conversation turns with Claude
 *
 * @param {Array} messages - Conversation history
 * @param {Array} systemPrompts - System prompts to include
 * @param {Array} tools - Available tools
 * @param {Object} options - Configuration options
 * @param {AbortController} abortController - For cancellation
 * @yields {Object} - Progress updates and new messages
 */
export async function* streamConversation(
  messages,
  systemPrompts,
  tools,
  options,
  abortController
) {
  const modelId = options.model || 'claude-sonnet-4-6'
  const providerId = getProviderIdForModel(modelId)
  const isAnthropicProvider = providerId === 'anthropic'

  const client = await getClientForModel(modelId)
  const maxRetries = options.maxRetries ?? 3

  // Iterative loop — avoids generator stack growth in long agentic sessions.
  // Tool-use continuation and auto-continue accumulate messages and loop;
  // bounded retry cases (401/429) still use recursion (max 3-4 levels).
  let currentMessages = messages
  let continueAttempt = options._continueAttempt || 0

  while (true) {
    let shouldLoop = false

    try {
    // Build API request — strip provider prefix for actual API call
    const request = {
      model: stripProviderPrefix(modelId),
      max_tokens: options.maxTokens || 8192,
      messages: currentMessages
        .filter(m => {
          const role = m.message?.role || m.role
          const content = m.message?.content || m.content
          // Only include messages with valid role and content
          return role && content !== undefined && content !== null
        })
        .map((m) => {
          const role = m.message?.role || m.role
          let content = m.message?.content || m.content

          // Clean up temp properties from content blocks
          if (Array.isArray(content)) {
            content = content.map(block => {
              const cleaned = { ...block }
              delete cleaned._partialJson
              delete cleaned.data
              return cleaned
            })
          }

          return { role, content }
        }),
    }

    // Add system prompts if provided, with cache breakpoints (Anthropic only)
    if (systemPrompts && systemPrompts.length > 0) {
      if (isAnthropicProvider) {
        request.system = systemPrompts.map((text, i) => {
          const block = {
            type: 'text',
            text: typeof text === 'string' ? text : text.text
          }
          // Add cache_control to the last system block for prompt caching
          if (i === systemPrompts.length - 1) {
            block.cache_control = { type: 'ephemeral' }
          }
          return block
        })
      } else {
        // Non-Anthropic: flatten to a plain string — the client factory handles the rest
        request.system = systemPrompts
          .map(t => (typeof t === 'string' ? t : t.text))
          .join('\n')
      }
    }

    // Add tools if provided and non-empty
    if (tools && tools.length > 0) {
      request.tools = await Promise.all(tools.map(async (t) => {
        let desc = 'No description'
        if (typeof t.description === 'function') {
          try {
            // Some tools have async description with prompt() method
            desc = typeof t.prompt === 'function' ? await t.prompt() : t.name
          } catch {
            desc = t.name
          }
        } else if (typeof t.description === 'string') {
          desc = t.description
        }

        // Convert Zod schema to JSON schema if needed
        let inputSchema = t.inputSchema || { type: 'object', properties: {} }
        if (inputSchema && typeof inputSchema._def !== 'undefined') {
          // It's a Zod schema - use zodToJsonSchema or extract the schema
          const zodToJsonSchema = (await import('zod-to-json-schema')).zodToJsonSchema
          inputSchema = zodToJsonSchema(inputSchema, { target: 'openApi3' })
          delete inputSchema.$schema
        }

        // Ensure input_schema always has type field (API requires it)
        if (inputSchema && !inputSchema.type) {
          inputSchema = { ...inputSchema, type: 'object' }
        }

        return {
          name: t.name,
          description: desc,
          input_schema: inputSchema,
        }
      }))
      // Add cache_control to last tool for prompt caching (Anthropic only)
      if (isAnthropicProvider && request.tools.length > 0) {
        request.tools[request.tools.length - 1].cache_control = { type: 'ephemeral' }
      }
    }

    if (process.env.DEBUG_TUI) {
      console.error('[Streaming] Request:', JSON.stringify({
        model: request.model,
        messageCount: request.messages.length,
        toolCount: request.tools?.length || 0,
        systemCount: request.system?.length || 0
      }))
      console.error('[Streaming] Messages:', JSON.stringify(request.messages, null, 2))
    }

    if (options.maxThinkingTokens > 0) {
      request.thinking = {
        type: 'enabled',
        budget_tokens: options.maxThinkingTokens,
      }
    }

    // Fast mode tracking (server-side feature for OAuth/subscription users)
    // The API routes fast mode based on authenticated user settings,
    // not via a request parameter. We track it locally for status display.
    const fastMode = options.fastMode ?? isFastMode()

    // Stream response
    const stream = await client.messages.stream(request, {
      signal: abortController?.signal,
    })

    const { randomUUID } = await import('crypto')
    let currentMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      message: {
        role: 'assistant',
        content: [],
        usage: {},
      },
      costUSD: 0,
      durationMs: 0,
      startTime: Date.now(),
    }

    // Process stream events
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          currentMessage.message.id = event.message.id
          currentMessage.message.usage = event.message.usage
          break

        case 'content_block_start':
          if (event.content_block.type === 'text') {
            currentMessage.message.content.push({
              type: 'text',
              text: '',
            })
          } else if (event.content_block.type === 'tool_use') {
            currentMessage.message.content.push({
              type: 'tool_use',
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            })
          } else if (event.content_block.type === 'thinking') {
            currentMessage.message.content.push({
              type: 'thinking',
              thinking: '',
            })
          }
          break

        case 'content_block_delta':
          const contentIndex = event.index
          const content = currentMessage.message.content[contentIndex]
          if (!content) break

          if (event.delta.type === 'text_delta') {
            content.text += event.delta.text
          } else if (event.delta.type === 'input_json_delta') {
            // Accumulate partial JSON string (don't parse until complete)
            if (!content._partialJson) content._partialJson = ''
            content._partialJson += event.delta.partial_json

            // Try to parse - if it fails, keep accumulating
            try {
              content.input = JSON.parse(content._partialJson)
            } catch {
              // Not yet complete, keep accumulating
            }
          } else if (event.delta.type === 'thinking_delta') {
            content.thinking += event.delta.thinking
          }

          // Yield progress
          yield {
            type: 'progress',
            message: currentMessage,
          }
          break

        case 'content_block_stop':
          // Content block complete
          break

        case 'message_delta':
          if (event.usage) {
            currentMessage.message.usage = {
              ...currentMessage.message.usage,
              ...event.usage,
            }
          }
          // Track stop reason for auto-continue (CC 2.1.0+)
          if (event.delta?.stop_reason) {
            currentMessage.stopReason = event.delta.stop_reason
          }
          break

        case 'message_stop':
          // Calculate cost and duration
          const usage = currentMessage.message.usage || {}
          currentMessage.costUSD = calculateCost(usage, request.model)
          currentMessage.durationMs = Date.now() - currentMessage.startTime

          // Update session totals
          sessionUsage.inputTokens += (usage.input_tokens || 0)
          sessionUsage.outputTokens += (usage.output_tokens || 0)
          sessionUsage.cacheCreationTokens += (usage.cache_creation_input_tokens || 0)
          sessionUsage.cacheReadTokens += (usage.cache_read_input_tokens || 0)
          sessionUsage.costUSD += currentMessage.costUSD
          sessionUsage.turns++

          // Message complete
          yield currentMessage
          break

        case 'error':
          throw new Error(event.error.message)
      }
    }

    // Handle tool uses if any
    const toolUses = currentMessage.message.content.filter(
      (c) => c.type === 'tool_use'
    )

    // Auto-continue if response was cut off due to output token limit (CC 2.1.0+)
    if (toolUses.length === 0 && currentMessage.stopReason === 'max_tokens' && continueAttempt < 3) {
      yield currentMessage
      const continueMessage = createMessage('user', '[Response was cut off due to output token limit. Please continue from where you left off.]')
      currentMessages = [...currentMessages, currentMessage, continueMessage]
      continueAttempt++
      shouldLoop = true
    }

    // Check max turns limit (--max-turns flag)
    const maxTurns = parseInt(process.env.DARIO_MAX_TURNS || '0', 10)
    if (maxTurns > 0 && sessionUsage.turns >= maxTurns) {
      // Hit turn limit — yield final message and stop
      if (toolUses.length > 0) {
        const limitMsg = createMessage('assistant', `[Reached maximum turn limit of ${maxTurns}. Stopping.]`)
        yield limitMsg
      }
      return
    }

    if (toolUses.length > 0) {
      // Execute tools and get results
      const toolResults = []

      const toolExecOptions = {
        ...options,
        readFileTimestamps: sessionReadFileTimestamps,
      }

      for (const toolUse of toolUses) {
        try {
          const result = await executeToolUse(toolUse, tools, toolExecOptions)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.is_error || false,
            data: result.data,
          })

          // Yield progress
          yield {
            type: 'progress',
            toolUseId: toolUse.id,
            status: 'complete',
          }
        } catch (error) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: formatError(error),
            is_error: true,
          })

          yield {
            type: 'progress',
            toolUseId: toolUse.id,
            status: 'error',
            error: formatError(error),
          }
        }
      }

      // Return tool results as user message and loop for next turn
      const toolResultMessage = createMessage('user', toolResults)
      yield toolResultMessage

      currentMessages = [...currentMessages, currentMessage, toolResultMessage]
      shouldLoop = true
    }
    } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Stream aborted')
    } else if (error.status === 401) {
      // OAuth token expired mid-session — try refresh and retry once
      const retryAttempt = options._retryAttempt || 0
      if (retryAttempt === 0) {
        console.error('[Auth] Token expired (401), refreshing and retrying...')
        try {
          const { getValidToken } = await import('../auth/oauth.mjs')
          const newToken = await getValidToken()
          if (newToken) {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = newToken
            // Reset client so it picks up new token
            const { resetClient } = await import('./client.mjs')
            resetClient()
            yield* streamConversation(
              currentMessages,
              systemPrompts,
              tools,
              { ...options, _retryAttempt: 1 },
              abortController
            )
            return
          }
        } catch (refreshErr) {
          console.error('[Auth] Token refresh failed:', formatError(refreshErr))
        }
      }
      console.error('Stream error: Authentication failed (401)')
      throw error
    } else if (error.status === 429 || error.status === 529 || error.status === 500 || error.status === 503) {
      // Retryable error - use retry strategy
      const retryAttempt = options._retryAttempt || 0
      if (retryAttempt < maxRetries) {
        const delay = Math.min(20000, Math.random() * (2 ** retryAttempt) * 500)
        const errorType = error.status === 429 ? 'THROTTLING' : 'TRANSIENT'
        console.error(`[Retry] ${errorType} error (${error.status}), attempt ${retryAttempt + 1}/${maxRetries}, waiting ${Math.round(delay)}ms`)
        await new Promise(resolve => setTimeout(resolve, delay))
        yield* streamConversation(
          currentMessages,
          systemPrompts,
          tools,
          { ...options, _retryAttempt: retryAttempt + 1 },
          abortController
        )
        return
      }
      console.error('Stream error (max retries exceeded):', formatError(error))
      throw error
    } else {
      const errorText = formatError(error)
      const config = loadConfig()
      const usingClaudeSubscriptionOAuth =
        config.oauthMode === 'claude' &&
        !config.primaryApiKey &&
        !config.apiKey &&
        !process.env.ANTHROPIC_API_KEY

      if (
        usingClaudeSubscriptionOAuth &&
        error.status === 400 &&
        errorText.includes('"type":"invalid_request_error"')
      ) {
        throw new Error(
          'Claude Max/Pro OAuth authenticated successfully, but Anthropic is rejecting direct public API requests from this app. Use Console OAuth or a saved ANTHROPIC_API_KEY instead.'
        )
      }

      console.error('Stream error:', errorText)
      throw error
    }
    } // end catch

    if (!shouldLoop) break
  } // end while(true)
}

/**
 * Run a single non-streaming query
 */
export async function runQuery(prompt, tools, options) {
  const messages = [createMessage('user', prompt)]
  const systemPrompts = options.systemPrompts || []
  const abortController = new AbortController()

  const results = []
  for await (const event of streamConversation(
    messages,
    systemPrompts,
    tools,
    options,
    abortController
  )) {
    if (event.type === 'assistant') {
      results.push(event)
    }
  }

  return results
}
