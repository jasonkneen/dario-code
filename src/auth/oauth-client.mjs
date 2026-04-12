/**
 * Anthropic OAuth Client
 * Adapted from @anthropic-ai/anthropic-oauth
 */

import { generatePKCE } from '@openauthjs/openauth/pkce'

const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZATION_ENDPOINT_MAX = 'https://claude.com/cai/oauth/authorize'
const AUTHORIZATION_ENDPOINT_CONSOLE = 'https://platform.claude.com/oauth/authorize'
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token'
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
const CREATE_API_KEY_ENDPOINT = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key'
const CONSOLE_SCOPES = 'org:create_api_key user:profile'
const CLAUDE_AI_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

const DEFAULT_TIMEOUT_MS = 30000

/**
 * Generate a cryptographically secure random state string for CSRF protection
 */
async function generateState() {
  const array = new Uint8Array(32)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array)
  } else {
    // Fallback for Node.js
    const cryptoNode = await import('crypto')
    cryptoNode.randomFillSync(array)
  }
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Anthropic OAuth Client
 */
export class AnthropicOAuthClient {
  constructor(options = {}) {
    this.clientId = options.clientId?.trim() || DEFAULT_CLIENT_ID
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    if (!this.clientId) {
      throw new Error('Client ID must not be empty')
    }
  }

  /**
   * Generate PKCE challenge and verifier
   */
  async generatePKCEChallenge() {
    const pkce = await generatePKCE()
    return {
      challenge: pkce.challenge,
      verifier: pkce.verifier
    }
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthorizationUrl(mode, pkce, state) {
    const baseUrl = mode === 'max' ? AUTHORIZATION_ENDPOINT_MAX : AUTHORIZATION_ENDPOINT_CONSOLE
    const scope = mode === 'max' ? CLAUDE_AI_SCOPES : CONSOLE_SCOPES
    const params = new URLSearchParams({
      code: 'true',
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: state
    })

    return `${baseUrl}?${params.toString()}`
  }

  /**
   * Start OAuth login flow
   */
  async startLogin(mode = 'console') {
    const pkce = await this.generatePKCEChallenge()
    const state = await generateState()
    const authUrl = this.getAuthorizationUrl(mode, pkce, state)

    return {
      authUrl,
      verifier: pkce.verifier,
      state
    }
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code, verifier, expectedState) {
    // Code might contain state appended with #
    const [authCode, callbackState] = code.split('#')

    // Validate state for CSRF protection
    if (callbackState && callbackState !== expectedState) {
      throw new Error('State mismatch: potential CSRF attack')
    }

    if (!authCode?.trim()) {
      throw new Error('Invalid authorization code')
    }

    const body = {
      code: authCode,
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    }

    // Include state if present
    if (callbackState) {
      body.state = callbackState
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Token exchange failed: ${response.status} ${error}`)
    }

    const data = await response.json()

    return {
      type: 'oauth',
      refresh: data.refresh_token,
      access: data.access_token,
      expires: Date.now() + data.expires_in * 1000
    }
  }

  /**
   * Create API key from OAuth access token
   */
  async createApiKey(accessToken) {
    if (!accessToken?.trim()) {
      throw new Error('Access token required')
    }

    const response = await fetch(CREATE_API_KEY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${accessToken}`
      }
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`API key creation failed: ${response.status} ${error}`)
    }

    const data = await response.json()
    return data.raw_key
  }

  /**
   * Complete OAuth login
   */
  async completeLogin(code, verifier, state, createKey = false) {
    if (!code || typeof code !== 'string') {
      throw new Error('Authorization code required')
    }

    if (!verifier || typeof verifier !== 'string') {
      throw new Error('PKCE verifier required')
    }

    if (!state || typeof state !== 'string') {
      throw new Error('State required for CSRF protection')
    }

    const tokens = await this.exchangeCodeForTokens(code.trim(), verifier.trim(), state.trim())

    if (createKey) {
      try {
        const apiKey = await this.createApiKey(tokens.access)
        return { tokens, apiKey }
      } catch (err) {
        // If API key creation fails, return tokens without key
        console.error('[OAuth] API key creation failed:', err.message)
        return { tokens, apiKey: null }
      }
    }

    return { tokens }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new Error('Refresh token required')
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken.trim(),
        client_id: this.clientId
      })
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Token refresh failed: ${response.status} ${error}`)
    }

    const data = await response.json()

    return {
      type: 'oauth',
      refresh: data.refresh_token,
      access: data.access_token,
      expires: Date.now() + data.expires_in * 1000
    }
  }
}
