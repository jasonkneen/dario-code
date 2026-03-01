/**
 * Provider Config
 * Persists user provider settings to ~/.dario/providers.json
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { BUILTIN_PROVIDERS, getProvider } from './registry.mjs'

const CONFIG_PATH = path.join(os.homedir(), '.dario', 'providers.json')

/**
 * Discover installed models from local OpenAI-compatible providers
 * (e.g. Ollama / LM Studio via /v1/models).
 * Synchronous by design so model listing remains synchronous.
 */
function discoverLocalModels(provider) {
  if (!provider?.isLocal || !provider?.baseURL) return []

  try {
    const base = provider.baseURL.replace(/\/$/, '')
    const body = execFileSync('curl', ['-sS', '--max-time', '1.5', `${base}/models`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const parsed = JSON.parse(body)
    const modelIds = (parsed?.data || [])
      .map(m => m?.id)
      .filter(Boolean)

    return modelIds.map(id => ({
      id,
      name: id,
      category: 'local',
    }))
  } catch {
    return []
  }
}

/**
 * Load provider config from disk.
 * Returns { providers: [...] }
 */
export function loadProviderConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    }
  } catch {
    // Ignore parse errors — return empty
  }
  return { providers: [] }
}

/**
 * Save provider config to disk.
 * @param {Object} config - { providers: [...] }
 */
export function saveProviderConfig(config) {
  const dir = path.dirname(CONFIG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

/**
 * Get enabled provider entries (merged with built-in definitions).
 * Anthropic is always included.
 * @returns {Array} Provider objects with config overlaid
 */
export function getEnabledProviders() {
  const config = loadProviderConfig()
  const configMap = new Map(config.providers.map(p => [p.id, p]))

  return BUILTIN_PROVIDERS.filter(p => {
    if (p.isBuiltin) return true // Anthropic always enabled
    const entry = configMap.get(p.id)
    return entry?.enabled === true
  }).map(p => {
    const entry = configMap.get(p.id) || {}
    return {
      ...p,
      apiKey: entry.apiKey || process.env[p.apiKeyEnv] || null,
      baseURL: entry.baseURL || p.baseURL,
      enabledModels: entry.enabledModels || [],
    }
  })
}

/**
 * Get all enabled models as a flat list.
 * Format: { id: 'providerId:modelId', name, provider }
 * Anthropic models use plain IDs (no prefix).
 * @returns {Array}
 */
export function getEnabledModels() {
  const providers = getEnabledProviders()
  const models = []

  for (const provider of providers) {
    if (provider.isBuiltin) {
      // Anthropic — expose with plain IDs
      for (const m of provider.models) {
        models.push({ ...m, provider: provider.id, prefixedId: m.id })
      }
      continue
    }

    // Local providers (Ollama / LM Studio): prefer installed models from runtime.
    if (provider.isLocal) {
      const discovered = discoverLocalModels(provider)
      if (discovered.length > 0) {
        for (const m of discovered) {
          models.push({
            ...m,
            provider: provider.id,
            prefixedId: `${provider.id}:${m.id}`,
          })
        }
        continue
      }
    }

    // Other providers — only expose explicitly enabled models.
    const enabled = new Set(provider.enabledModels)
    const known = new Map((provider.models || []).map(m => [m.id, m]))

    // Include known model definitions that are enabled.
    for (const m of provider.models || []) {
      if (enabled.has(m.id)) {
        models.push({
          ...m,
          provider: provider.id,
          prefixedId: `${provider.id}:${m.id}`,
        })
      }
    }

    // Include custom enabled model IDs not present in built-in definitions.
    for (const modelId of enabled) {
      if (!known.has(modelId)) {
        models.push({
          id: modelId,
          name: modelId,
          category: 'custom',
          provider: provider.id,
          prefixedId: `${provider.id}:${modelId}`,
        })
      }
    }
  }

  return models
}

/**
 * Set API key for a provider.
 * @param {string} id - Provider ID
 * @param {string} key - API key
 */
export function setProviderKey(id, key) {
  const config = loadProviderConfig()
  let entry = config.providers.find(p => p.id === id)
  if (!entry) {
    entry = { id }
    config.providers.push(entry)
  }
  entry.apiKey = key
  saveProviderConfig(config)
}

/**
 * Toggle a model on/off for a provider.
 * @param {string} providerId
 * @param {string} modelId - The model's own ID (without provider prefix)
 */
export function toggleModel(providerId, modelId) {
  const config = loadProviderConfig()
  let entry = config.providers.find(p => p.id === providerId)
  if (!entry) {
    entry = { id: providerId, enabled: true, enabledModels: [] }
    config.providers.push(entry)
  }
  if (!entry.enabledModels) entry.enabledModels = []

  const idx = entry.enabledModels.indexOf(modelId)
  if (idx === -1) {
    entry.enabledModels.push(modelId)
  } else {
    entry.enabledModels.splice(idx, 1)
  }
  saveProviderConfig(config)
}

/**
 * Enable a provider.
 * @param {string} id - Provider ID
 */
export function enableProvider(id) {
  const config = loadProviderConfig()
  let entry = config.providers.find(p => p.id === id)
  if (!entry) {
    entry = { id }
    config.providers.push(entry)
  }
  entry.enabled = true
  saveProviderConfig(config)
}

/**
 * Disable a provider.
 * @param {string} id - Provider ID
 */
export function disableProvider(id) {
  if (id === 'anthropic') return // Cannot disable Anthropic
  const config = loadProviderConfig()
  let entry = config.providers.find(p => p.id === id)
  if (!entry) {
    entry = { id }
    config.providers.push(entry)
  }
  entry.enabled = false
  saveProviderConfig(config)
}
