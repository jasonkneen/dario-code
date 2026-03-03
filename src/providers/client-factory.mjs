/**
 * Client Factory
 * Returns the appropriate API client for a given model ID.
 *
 * Model ID format:
 *   - Plain ID (e.g. 'claude-sonnet-4-6') → Anthropic
 *   - 'anthropic:modelId' → Anthropic
 *   - 'providerId:modelId' → OpenAI-compat provider (native fetch)
 */

import { getClient } from '../api/client.mjs'
import { getProvider } from './registry.mjs'
import { getEnabledProviders } from './config.mjs'

/**
 * Parse a prefixed model ID into { providerId, modelId }.
 * Plain IDs (no colon) default to 'anthropic'.
 */
function parseModelId(prefixedId) {
  const colon = prefixedId.indexOf(':')
  if (colon === -1) return { providerId: 'anthropic', modelId: prefixedId }
  return {
    providerId: prefixedId.slice(0, colon),
    modelId: prefixedId.slice(colon + 1),
  }
}

/**
 * Build an OpenAI-compat streaming client using native fetch.
 * Returns an object that mimics the Anthropic SDK streaming interface.
 *
 * @param {Object} providerEntry - Provider with apiKey + baseURL
 * @returns {Object} Fake client with messages.stream()
 */
const localModelCache = new Map()

/**
 * Resolve local provider model aliases (e.g. "qwen2.5-coder" -> "qwen2.5-coder:7b").
 * Only applied for local providers (Ollama / LM Studio) and only when the
 * requested model has no explicit tag suffix.
 */
async function resolveLocalModelId(providerEntry, baseURL, apiKey, requestedModel) {
  if (!providerEntry?.isLocal) return requestedModel
  if (!requestedModel || requestedModel.includes(':')) return requestedModel

  const now = Date.now()
  const cacheKey = `${providerEntry.id}:${baseURL}`
  const cached = localModelCache.get(cacheKey)

  let installedModels = []
  if (cached && now - cached.timestamp < 15_000) {
    installedModels = cached.models
  } else {
    try {
      const headers = {}
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`

      const res = await fetch(`${baseURL}/models`, { headers })
      if (res.ok) {
        const json = await res.json()
        installedModels = (json?.data || [])
          .map(m => m?.id)
          .filter(Boolean)
      }
    } catch {
      // Ignore lookup failures; we'll use the requested model as-is.
    }
    localModelCache.set(cacheKey, { timestamp: now, models: installedModels })
  }

  if (installedModels.length === 0) return requestedModel

  // Exact match available as-is.
  if (installedModels.includes(requestedModel)) return requestedModel

  // Best-effort alias: pick installed tag variant (prefer :latest).
  const prefixMatches = installedModels.filter(id => id.startsWith(`${requestedModel}:`))
  if (prefixMatches.length === 0) return requestedModel

  const latest = prefixMatches.find(id => id.endsWith(':latest'))
  return latest || prefixMatches[0]
}

/**
 * Convert Anthropic-format messages to OpenAI-format messages.
 * Handles text, tool_use (→ assistant tool_calls), and tool_result (→ tool role).
 */
function convertMessagesToOpenAI(anthropicRequest) {
  const messages = []

  // System prompt
  if (anthropicRequest.system) {
    const systemText = Array.isArray(anthropicRequest.system)
      ? anthropicRequest.system.map(b => (typeof b === 'string' ? b : b.text)).join('\n')
      : anthropicRequest.system
    messages.push({ role: 'system', content: systemText })
  }

  for (const msg of anthropicRequest.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'assistant') {
      // Collect text parts + tool_use blocks separately
      const textParts = []
      const toolCalls = []

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          })
        }
      }

      const assistantMsg = { role: 'assistant', content: textParts.join('\n') || null }
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      messages.push(assistantMsg)
    } else if (msg.role === 'user') {
      // tool_result blocks → individual 'tool' role messages
      // other blocks → user text message
      const toolResults = msg.content.filter(b => b.type === 'tool_result')
      const otherBlocks = msg.content.filter(b => b.type !== 'tool_result')

      for (const result of toolResults) {
        const content = typeof result.content === 'string'
          ? result.content
          : Array.isArray(result.content)
            ? result.content.map(c => (typeof c === 'string' ? c : c.text || JSON.stringify(c))).join('\n')
            : JSON.stringify(result.content ?? '')
        messages.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content,
        })
      }

      if (otherBlocks.length > 0) {
        const textContent = otherBlocks
          .map(b => (b.type === 'text' ? b.text : ''))
          .join('\n')
          .trim()
        if (textContent) messages.push({ role: 'user', content: textContent })
      }
    }
  }

  return messages
}

/**
 * Convert Anthropic tool definitions to OpenAI function tool format.
 */
function convertToolsToOpenAI(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return []

  return anthropicTools.map(tool => {
    // Strip Anthropic-only fields like cache_control from the schema
    const schema = { ...(tool.input_schema || { type: 'object', properties: {} }) }
    delete schema.cache_control

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: schema,
      },
    }
  })
}

/**
 * Parse XML-style tool calls emitted by some models (e.g. Qwen) as plain text.
 * Supports:
 *   <tool_call>{"name":"foo","arguments":{...}}</tool_call>
 *   <tool_call>{"name":"foo","parameters":{...}}</tool_call>
 *
 * Returns { textBefore, calls: [{name, args}], textAfter } or null if none found.
 */
function parseXmlToolCalls(text) {
  const xmlPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  const calls = []
  let lastIndex = 0
  let firstMatchIndex = -1
  let lastMatchEnd = 0
  let match

  while ((match = xmlPattern.exec(text)) !== null) {
    if (firstMatchIndex === -1) firstMatchIndex = match.index
    lastMatchEnd = match.index + match[0].length
    try {
      const parsed = JSON.parse(match[1])
      const name = parsed.name
      const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {}
      if (name) calls.push({ name, args })
    } catch {
      // Ignore malformed blocks
    }
  }

  if (calls.length === 0) return null

  return {
    textBefore: text.slice(0, firstMatchIndex).trim(),
    calls,
    textAfter: text.slice(lastMatchEnd).trim(),
  }
}

function buildOpenAICompatClient(providerEntry) {
  const baseURL = providerEntry.baseURL.replace(/\/$/, '')
  const apiKey = providerEntry.apiKey

  return {
    messages: {
      /**
       * Stream a chat completion request.
       * Converts Anthropic-style request to OpenAI Chat format (including tools).
       * Returns an async iterable that yields Anthropic-compatible SSE events.
       *
       * Handles three tool-call response styles:
       *  1. Standard OpenAI delta.tool_calls (preferred)
       *  2. XML <tool_call>…</tool_call> in text (Qwen fallback)
       *  3. Plain text only (no tools)
       */
      stream(anthropicRequest, { signal } = {}) {
        const messages = convertMessagesToOpenAI(anthropicRequest)
        const openAITools = convertToolsToOpenAI(anthropicRequest.tools)

        // Return async iterable that yields Anthropic-compatible events
        return {
          [Symbol.asyncIterator]() {
            let buffer = ''
            let reader = null
            let messageId = null
            let inputTokens = 0
            let outputTokens = 0

            const fetchStream = async function* () {
              const resolvedModel = await resolveLocalModelId(
                providerEntry,
                baseURL,
                apiKey,
                anthropicRequest.model,
              )

              const openAIBody = {
                model: resolvedModel,
                max_tokens: anthropicRequest.max_tokens,
                messages,
                stream: true,
              }

              if (openAITools.length > 0) {
                openAIBody.tools = openAITools
                openAIBody.tool_choice = 'auto'
              }

              const headers = { 'Content-Type': 'application/json' }
              if (apiKey) headers.Authorization = `Bearer ${apiKey}`

              const response = await fetch(`${baseURL}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(openAIBody),
                signal,
              })

              if (!response.ok) {
                const text = await response.text()
                const err = new Error(`Provider error ${response.status}: ${text}`)
                err.status = response.status
                throw err
              }

              // Yield Anthropic-compatible message_start
              messageId = `msg_${Date.now()}`
              yield {
                type: 'message_start',
                message: {
                  id: messageId,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              }

              // --- Streaming state ---
              // Text block: index 0
              // Tool blocks: index 1, 2, … (one per tool call)
              let textBlockStarted = false
              let accumulatedText = ''
              // Map: openAI tool_call index → { blockIndex, id, name, argsJson }
              const toolCallMap = new Map()
              // Track last emitted content block index.
              // Start at -1 so tool-only responses begin at index 0.
              let nextBlockIndex = -1

              const textDecoder = new TextDecoder()
              reader = response.body.getReader()

              while (true) {
                const { value, done: streamDone } = await reader.read()
                if (streamDone) break

                buffer += textDecoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() // Keep incomplete line

                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue
                  const data = line.slice(6).trim()
                  if (data === '[DONE]') continue

                  let chunk
                  try { chunk = JSON.parse(data) } catch { continue }

                  const delta = chunk.choices?.[0]?.delta

                  // --- Text content ---
                  if (delta?.content) {
                    accumulatedText += delta.content
                    if (!textBlockStarted) {
                      textBlockStarted = true
                      nextBlockIndex = 0
                      yield {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' },
                      }
                    }
                    outputTokens++
                    yield {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: delta.content },
                    }
                  }

                  // --- OpenAI-style tool_calls deltas ---
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const tcIdx = tc.index ?? 0

                      if (!toolCallMap.has(tcIdx)) {
                        // New tool call — start a tool_use block
                        const blockIndex = nextBlockIndex + 1
                        nextBlockIndex = blockIndex
                        const callId = tc.id || `call_${Date.now()}_${tcIdx}`
                        const callName = tc.function?.name || ''
                        toolCallMap.set(tcIdx, { blockIndex, id: callId, name: callName, argsJson: '' })

                        yield {
                          type: 'content_block_start',
                          index: blockIndex,
                          content_block: { type: 'tool_use', id: callId, name: callName, input: {} },
                        }
                      }

                      const entry = toolCallMap.get(tcIdx)

                      // Update name if we get it late
                      if (tc.function?.name && !entry.name) entry.name = tc.function.name
                      if (tc.id && !entry.id) entry.id = tc.id

                      // Accumulate argument JSON fragments
                      if (tc.function?.arguments) {
                        entry.argsJson += tc.function.arguments
                        outputTokens++
                        yield {
                          type: 'content_block_delta',
                          index: entry.blockIndex,
                          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                        }
                      }
                    }
                  }

                  // Capture usage if provided
                  if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0
                    outputTokens = chunk.usage.completion_tokens || outputTokens
                  }
                }
              }

              // --- Post-stream: handle XML tool calls embedded in text ---
              if (toolCallMap.size === 0 && accumulatedText) {
                const xmlResult = parseXmlToolCalls(accumulatedText)
                if (xmlResult && xmlResult.calls.length > 0) {
                  // We need to rewind the text block and re-emit only textBefore
                  // Since we already streamed the text, close that block and emit tool_use blocks

                  // Close text block (already started above)
                  if (textBlockStarted) {
                    yield { type: 'content_block_stop', index: 0 }
                    textBlockStarted = false
                  }

                  // Emit tool_use blocks for each XML call
                  for (let i = 0; i < xmlResult.calls.length; i++) {
                    const { name, args } = xmlResult.calls[i]
                    const blockIndex = i + 1
                    const callId = `call_xml_${Date.now()}_${i}`
                    const argsJson = JSON.stringify(args)

                    yield {
                      type: 'content_block_start',
                      index: blockIndex,
                      content_block: { type: 'tool_use', id: callId, name, input: {} },
                    }
                    yield {
                      type: 'content_block_delta',
                      index: blockIndex,
                      delta: { type: 'input_json_delta', partial_json: argsJson },
                    }
                    yield { type: 'content_block_stop', index: blockIndex }
                  }

                  yield {
                    type: 'message_delta',
                    delta: { stop_reason: 'tool_use' },
                    usage: { output_tokens: outputTokens },
                  }
                  yield {
                    type: 'message_stop',
                    message: { id: messageId, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
                  }
                  return
                }
              }

              // --- Close all open blocks ---
              if (textBlockStarted) {
                yield { type: 'content_block_stop', index: 0 }
              } else if (toolCallMap.size === 0) {
                // No content at all — emit an empty text block so the caller has something
                yield {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                }
                yield { type: 'content_block_stop', index: 0 }
              }

              for (const { blockIndex } of toolCallMap.values()) {
                yield { type: 'content_block_stop', index: blockIndex }
              }

              const stopReason = toolCallMap.size > 0 ? 'tool_use' : 'end_turn'

              yield {
                type: 'message_delta',
                delta: { stop_reason: stopReason },
                usage: { output_tokens: outputTokens },
              }

              yield {
                type: 'message_stop',
                message: { id: messageId, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
              }
            }

            const gen = fetchStream()

            return {
              async next() { return gen.next() },
              [Symbol.asyncIterator]() { return this },
            }
          },
        }
      },
    },
  }
}

/**
 * Get the appropriate client for a given model ID.
 * @param {string} prefixedModelId - e.g. 'claude-sonnet-4-6' or 'groq:llama-3.3-70b-versatile'
 * @returns {Promise<Object>} Client with messages.stream() interface
 */
export async function getClientForModel(prefixedModelId) {
  const { providerId, modelId } = parseModelId(prefixedModelId)

  // Anthropic (default)
  if (providerId === 'anthropic') {
    return getClient()
  }

  // Look up provider definition
  const providerDef = getProvider(providerId)
  if (!providerDef) {
    throw new Error(`Unknown provider: ${providerId}`)
  }

  // Get config entry for API key + baseURL overrides
  const enabledProviders = getEnabledProviders()
  const providerEntry = enabledProviders.find(p => p.id === providerId) || {
    ...providerDef,
    apiKey: process.env[providerDef.apiKeyEnv] || null,
  }

  if (!providerDef.noKeyRequired && !providerEntry.apiKey) {
    throw new Error(
      `No API key configured for ${providerDef.name}. ` +
      `Run: /providers key ${providerId} <your-key>`
    )
  }

  return buildOpenAICompatClient(providerEntry)
}

/**
 * Strip provider prefix from a model ID for use in API calls.
 * e.g. 'groq:llama-3.3-70b-versatile' → 'llama-3.3-70b-versatile'
 *      'claude-sonnet-4-6' → 'claude-sonnet-4-6'
 */
export function stripProviderPrefix(prefixedModelId) {
  return parseModelId(prefixedModelId).modelId
}

/**
 * Get the provider ID from a prefixed model ID.
 */
export function getProviderIdForModel(prefixedModelId) {
  return parseModelId(prefixedModelId).providerId
}
