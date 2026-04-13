/**
 * Claude API client
 * Handles communication with the API
 */

import { createHash } from 'crypto'
import { ApiError, ConfigError } from '../utils/errors.mjs'
import { getApiKey, VERSION } from '../core/config.mjs'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Cached client instance
let clientInstance = null

/**
 * Get OAuth token from any known credential store.
 * Uses getValidToken() which handles refresh automatically.
 * Falls back to synchronous reads if async isn't available.
 *
 * Priority:
 *   1. ~/.dario/oauth-token.json  (Dario's own token file)
 *   2. ~/.dario/config.json       (oauthTokens field)
 *   3. ~/.claude/.credentials.json     (shared credentials)
 */
function setupOAuthToken() {
  const BUFFER_MS = 5 * 60 * 1000 // 5 minute expiry buffer

  try {
    const configPath = path.join(os.homedir(), '.dario', 'config.json')
    let configMode = null
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      configMode = config.oauthMode || null
    }

    // 1. Dario token file
    const tokenPath = path.join(os.homedir(), '.dario', 'oauth-token.json')
    if (fs.existsSync(tokenPath)) {
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
      const tokenMode = tokenData.oauth_mode || configMode
      if (tokenMode === 'claude' && tokenData.access_token) {
        const expiresAt = tokenData.expires || (tokenData.savedAt + 3600000)
        if (Date.now() < expiresAt - BUFFER_MS) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = tokenData.access_token
          return tokenData.access_token
        }
        // Expired but has refresh token — trigger async refresh
        if (tokenData.refresh_token) {
          return 'needs-refresh'
        }
      }
    }

    // 2. Dario config
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (config.oauthMode === 'claude' && config.oauthTokens?.access) {
        const expiresAt = config.oauthTokens.expires || 0
        if (Date.now() < expiresAt - BUFFER_MS) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthTokens.access
          return config.oauthTokens.access
        }
        // Expired but has refresh token — trigger async refresh
        if (config.oauthTokens.refresh) {
          return 'needs-refresh'
        }
      }
    }

    // 3. Shared credentials (~/.claude/.credentials.json)
    const claudeCredsPath = path.join(os.homedir(), '.claude', '.credentials.json')
    if (fs.existsSync(claudeCredsPath)) {
      const creds = JSON.parse(fs.readFileSync(claudeCredsPath, 'utf8'))
      const oauth = creds?.claudeAiOauth
      if (oauth?.accessToken) {
        if (oauth.expiresAt && oauth.expiresAt > Date.now() + BUFFER_MS) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth.accessToken
          return oauth.accessToken
        }
        // Token expired but has refresh token — mark as needing refresh
        if (oauth.refreshToken) {
          return 'needs-refresh'
        }
      }
    }
  } catch (e) {
    // Ignore errors — fall through to API key auth
  }
  return null
}

/**
 * Ensure we have a valid (non-expired) OAuth token.
 * Performs async refresh if needed.
 */
async function ensureValidToken() {
  try {
    const { getValidToken } = await import('../auth/oauth.mjs')
    const token = await getValidToken()
    if (token) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = token
      return token
    }
  } catch (err) {
    if (process.env.DEBUG_OAUTH) {
      console.error('[Client] Token refresh failed:', err.message)
    }
  }
  return null
}

/**
 * Create an OAuth API client using the SDK's native authToken support.
 * Uses the SDK's built-in Bearer auth (authToken) instead of a custom fetch hack.
 * The SDK handles Authorization: Bearer headers correctly when apiKey is null
 * and authToken is set.
 */
function createOAuthClient(oauthToken) {
  return new Anthropic({
    apiKey: null,
    authToken: oauthToken,
    defaultHeaders: {
      'User-Agent': 'claude-code/1.0',       // DO NOT CHANGE — must identify as Claude Code to Anthropic
      'X-App-Name': 'claude-code',            // DO NOT CHANGE
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    }
  })
}

/**
 * Check if the current OAuth token is near expiry by examining token files.
 * Returns true if we should proactively refresh.
 */
function isTokenNearExpiry() {
  const BUFFER_MS = 5 * 60 * 1000
  try {
    const tokenPath = path.join(os.homedir(), '.dario', 'oauth-token.json')
    if (fs.existsSync(tokenPath)) {
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
      const expiresAt = tokenData.expires || (tokenData.savedAt + 3600000)
      return Date.now() > expiresAt - BUFFER_MS
    }
  } catch {}
  return false
}

/**
 * Get or create API client
 * Used by streaming.mjs for conversation streaming
 * Supports both OAuth tokens and API keys
 *
 * Now async to support token refresh on startup.
 */
export async function getClient() {
  // If we have an OAuth client and the token is near expiry, reset so we
  // create a new client with a fresh token.
  if (clientInstance && clientInstance.authToken && isTokenNearExpiry()) {
    const refreshed = await ensureValidToken()
    if (refreshed) {
      clientInstance = createOAuthClient(refreshed)
      return clientInstance
    }
  }

  if (!clientInstance) {
    // Explicit API keys take precedence over OAuth tokens.
    // This avoids a stale/broken OAuth login masking a valid key.
    const apiKey = getApiKey()
    if (apiKey) {
      clientInstance = new Anthropic({
        apiKey,
        defaultHeaders: {
          'User-Agent': 'claude-code/1.0',     // DO NOT CHANGE — must identify as Claude Code to Anthropic
          'X-App-Name': 'claude-code',          // DO NOT CHANGE
        }
      })
      return clientInstance
    }

    // Try OAuth next (sync check)
    let oauthToken = setupOAuthToken()

    // If token needs refresh, do it async
    if (oauthToken === 'needs-refresh' || !oauthToken) {
      const refreshed = await ensureValidToken()
      if (refreshed) {
        oauthToken = refreshed
      } else if (oauthToken === 'needs-refresh') {
        oauthToken = null
      }
    }

    if (oauthToken && oauthToken !== 'needs-refresh') {
      clientInstance = createOAuthClient(oauthToken)
      return clientInstance
    }

    throw new ConfigError(
      'ANTHROPIC_API_KEY not set. Please add it to your environment or saved config.\n\nOr use /login to authenticate with OAuth.',
      'ANTHROPIC_API_KEY'
    )
  }
  return clientInstance
}

/**
 * Reset the cached client (useful after auth changes)
 */
export function resetClient() {
  clientInstance = null
}

/**
 * Sends a non-streaming request to Claude AI
 * Uses the SDK client which supports both OAuth and API key auth
 */
export async function sendRequest(messages, options = {}) {
  const client = await getClient()
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'
  const maxTokens = parseInt(process.env.CLAUDE_MAX_TOKENS || '4096', 10)

  // Compute attribution fingerprint from first user message
  const SALT = '59cf53e54c78'
  let firstText = ''
  for (const m of messages) {
    if (m.role === 'user') {
      firstText = typeof m.content === 'string' ? m.content : ''
      break
    }
  }
  const chars = [4, 7, 20].map(i => firstText[i] || '0').join('')
  const fp = createHash('sha256').update(`${SALT}${chars}${VERSION}`).digest('hex').slice(0, 3)
  const attribution = `x-anthropic-billing-header: cc_version=${VERSION}.${fp}; cc_entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'};`

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: attribution }],
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))
    })

    return {
      response: response.content[0].text,
      usage: response.usage
    }
  } catch (error) {
    if (error instanceof ApiError || error instanceof ConfigError) throw error
    throw new ApiError(
      `API error: ${error.message}`,
      null,
      { originalError: error.message }
    )
  }
}
