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

function buildOpenAICompatClient(providerEntry) {
  const baseURL = providerEntry.baseURL.replace(/\/$/, '')
  const apiKey = providerEntry.apiKey

  return {
    messages: {
      /**
       * Stream a chat completion request.
       * Converts Anthropic-style request to OpenAI Chat format.
       * Returns an async iterable that yields Anthropic-compatible SSE events.
       */
      stream(anthropicRequest, { signal } = {}) {
        // Convert Anthropic messages format to OpenAI format
        const messages = []

        // Add system prompt(s) as a system message
        if (anthropicRequest.system) {
          const systemText = Array.isArray(anthropicRequest.system)
            ? anthropicRequest.system.map(b => (typeof b === 'string' ? b : b.text)).join('\n')
            : anthropicRequest.system
          messages.push({ role: 'system', content: systemText })
        }

        for (const msg of anthropicRequest.messages) {
          if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content })
          } else if (Array.isArray(msg.content)) {
            // Flatten content blocks to text (tool results → text)
            const parts = msg.content.map(block => {
              if (block.type === 'text') return { type: 'text', text: block.text }
              if (block.type === 'tool_use') {
                return {
                  type: 'text',
                  text: `[Tool call: ${block.name}(${JSON.stringify(block.input)})]`,
                }
              }
              if (block.type === 'tool_result') {
                const content = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content)
                return { type: 'text', text: `[Tool result: ${content}]` }
              }
              return { type: 'text', text: '' }
            })

            const textContent = parts.map(p => p.text).join('\n').trim()
            messages.push({ role: msg.role, content: textContent })
          }
        }

        // Return async iterable that yields Anthropic-compatible events
        return {
          [Symbol.asyncIterator]() {
            let buffer = ''
            let reader = null
            let done = false
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

              const headers = {
                'Content-Type': 'application/json',
              }
              if (apiKey) {
                headers.Authorization = `Bearer ${apiKey}`
              }

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

              yield {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              }

              const textDecoder = new TextDecoder()
              reader = response.body.getReader()
              let chunkIndex = 0

              while (true) {
                const { value, done: streamDone } = await reader.read()
                if (streamDone) break

                buffer += textDecoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() // Keep incomplete line

                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue
                  const data = line.slice(6).trim()
                  if (data === '[DONE]') {
                    done = true
                    continue
                  }

                  let chunk
                  try {
                    chunk = JSON.parse(data)
                  } catch {
                    continue
                  }

                  // Extract delta text
                  const delta = chunk.choices?.[0]?.delta?.content
                  if (delta) {
                    outputTokens++
                    yield {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: delta },
                    }
                    chunkIndex++
                  }

                  // Capture usage if provided
                  if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0
                    outputTokens = chunk.usage.completion_tokens || outputTokens
                  }
                }
              }

              yield { type: 'content_block_stop', index: 0 }

              yield {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: outputTokens },
              }

              yield {
                type: 'message_stop',
                message: {
                  id: messageId,
                  usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                  },
                },
              }
            }

            const gen = fetchStream()

            return {
              async next() {
                return gen.next()
              },
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
