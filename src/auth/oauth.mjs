/**
 * Claude OAuth Authentication
 * Uses proper OAuth client to create API keys
 */

import * as http from 'http'
import * as url from 'url'
import open from 'open'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { AnthropicOAuthClient } from './oauth-client.mjs'

// Base config
const BASE_CONFIG = {
  REDIRECT_PORT: 54545,
  MANUAL_REDIRECT_URL: '/oauth/code/callback',
  SCOPES: ['org:create_api_key', 'user:profile']
}

// Console OAuth (creates API key)
const ANTHROPIC_CONFIG = {
  ...BASE_CONFIG,
  AUTHORIZE_URL: 'https://platform.claude.com/oauth/authorize',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  API_KEY_URL: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
  SUCCESS_URL: 'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
}

// Claude Max/Pro OAuth (zero-cost inference)
const CLAUDE_MAX_CONFIG = {
  REDIRECT_PORT: 54545,
  MANUAL_REDIRECT_URL: '/oauth/code/callback',
  SCOPES: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
  AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  SUCCESS_URL: 'https://platform.claude.com/oauth/code/success?app=claude-code',
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
}

// Active config
let activeConfig = ANTHROPIC_CONFIG
let oauthMode = 'anthropic'

// Token storage
const TOKEN_PATH = path.join(os.homedir(), '.dario', 'oauth-token.json')

// Config functions (will be set by caller)
let getConfig = () => {
  try {
    const configPath = path.join(os.homedir(), '.dario', 'config.json')
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch {}
  return {}
}

let saveConfig = (config) => {
  try {
    const configPath = path.join(os.homedir(), '.dario', 'config.json')
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('[OAuth] Failed to save config:', err.message)
  }
}

// Base64URL encode
function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// Generate code verifier
function generateCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(32))
}

// Generate code challenge
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(Buffer.from(hash))
}

export function setOAuthMode(mode) {
  oauthMode = mode
  if (mode === 'claude') {
    activeConfig = CLAUDE_MAX_CONFIG
  } else {
    activeConfig = ANTHROPIC_CONFIG
  }
}

// OAuth handler
class OAuthHandler {
  server = null
  codeVerifier
  expectedState = null
  pendingCodePromise = null

  constructor() {
    this.codeVerifier = generateCodeVerifier()
  }

  generateAuthUrls(codeChallenge, state) {
    const makeUrl = (useManual) => {
      const authUrl = new URL(activeConfig.AUTHORIZE_URL)
      authUrl.searchParams.append('client_id', activeConfig.CLIENT_ID)
      authUrl.searchParams.append('response_type', 'code')
      authUrl.searchParams.append('redirect_uri',
        useManual ? activeConfig.MANUAL_REDIRECT_URL : `http://localhost:${activeConfig.REDIRECT_PORT}/callback`)
      authUrl.searchParams.append('scope', activeConfig.SCOPES.join(' '))
      authUrl.searchParams.append('code_challenge', codeChallenge)
      authUrl.searchParams.append('code_challenge_method', 'S256')
      authUrl.searchParams.append('state', state)
      return authUrl.toString()
    }
    return {
      autoUrl: makeUrl(false),
      manualUrl: makeUrl(true)
    }
  }

  async startOAuthFlow(showManualUrl) {
    const codeChallenge = await generateCodeChallenge(this.codeVerifier)
    const state = base64UrlEncode(crypto.randomBytes(32))
    this.expectedState = state

    const { autoUrl, manualUrl } = this.generateAuthUrls(codeChallenge, state)

    const startServer = async () => {
      if (showManualUrl) await showManualUrl(manualUrl)
      await open(autoUrl)
    }

    const { authorizationCode, useManualRedirect } = await new Promise((resolve, reject) => {
      this.pendingCodePromise = { resolve, reject }
      this.startLocalServer(state, startServer)
    })

    const { access_token, account, organization } = await this.exchangeCodeForTokens(
      authorizationCode, state, useManualRedirect
    )

    // Save account info
    if (account) {
      const config = getConfig()
      config.oauthAccount = {
        accountUuid: account.uuid,
        emailAddress: account.email_address,
        organizationUuid: organization?.uuid
      }
      saveConfig(config)
    }

    return { accessToken: access_token }
  }

  startLocalServer(expectedState, onReady) {
    if (this.server) this.closeServer()

    this.server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || '', true)

      if (parsedUrl.pathname === '/callback') {
        const code = parsedUrl.query.code
        const state = parsedUrl.query.state

        // Debug logging
        if (process.env.DEBUG_OAUTH) {
          console.error('[OAuth] Callback received')
          console.error('[OAuth] Expected state:', expectedState)
          console.error('[OAuth] Received state:', state)
          console.error('[OAuth] State match:', state === expectedState)
        }

        if (!code) {
          res.writeHead(400)
          res.end('Authorization code not found')
          if (this.pendingCodePromise) {
            this.pendingCodePromise.reject(new Error('No authorization code received'))
          }
          return
        }

        // Decode state if URL-encoded (some OAuth providers encode it)
        const decodedState = typeof state === 'string' ? decodeURIComponent(state) : state
        const statesMatch = state === expectedState || decodedState === expectedState

        if (!statesMatch) {
          console.error('[OAuth] State mismatch!')
          console.error('[OAuth] Expected:', expectedState)
          console.error('[OAuth] Got:', state)
          console.error('[OAuth] Decoded:', decodedState)
          res.writeHead(400)
          res.end('Invalid state parameter')
          if (this.pendingCodePromise) {
            this.pendingCodePromise.reject(new Error('Invalid state parameter'))
          }
          return
        }

        // Redirect to success page
        res.writeHead(302, { Location: activeConfig.SUCCESS_URL })
        res.end()

        this.processCallback({
          authorizationCode: code,
          state: expectedState,
          useManualRedirect: false
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    this.server.listen(activeConfig.REDIRECT_PORT, async () => {
      if (onReady) await onReady()
    })

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const error = new Error(`Port ${activeConfig.REDIRECT_PORT} is already in use`)
        this.closeServer()
        if (this.pendingCodePromise) this.pendingCodePromise.reject(error)
      } else {
        this.closeServer()
        if (this.pendingCodePromise) this.pendingCodePromise.reject(err)
      }
    })
  }

  async exchangeCodeForTokens(code, state, useManualRedirect = false) {
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: useManualRedirect
        ? activeConfig.MANUAL_REDIRECT_URL
        : `http://localhost:${activeConfig.REDIRECT_PORT}/callback`,
      client_id: activeConfig.CLIENT_ID,
      code_verifier: this.codeVerifier,
      state
    }

    const response = await fetch(activeConfig.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.statusText}`)
    }

    return await response.json()
  }

  processCallback({ authorizationCode, state, useManualRedirect }) {
    this.closeServer()

    // Flexible state matching (handle URL encoding)
    const decodedState = typeof state === 'string' ? decodeURIComponent(state) : state
    const statesMatch = state === this.expectedState || decodedState === this.expectedState

    if (!statesMatch) {
      if (this.pendingCodePromise) {
        this.pendingCodePromise.reject(new Error('Invalid state parameter'))
        this.pendingCodePromise = null
      }
      return
    }

    if (this.pendingCodePromise) {
      this.pendingCodePromise.resolve({ authorizationCode, useManualRedirect })
      this.pendingCodePromise = null
    }
  }

  closeServer() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}

// OAuth client instance
const oauthClient = new AnthropicOAuthClient()

// Main auth function
export async function authenticateWithOAuth(getCallbackUrl) {

  // Determine mode based on oauthMode setting
  const mode = oauthMode === 'claude' ? 'max' : 'console'

  // Start OAuth flow
  const { authUrl, verifier, state } = await oauthClient.startLogin(mode)

  console.error('\n🔐 Opening browser for authentication...')
  console.error('\nIf browser does not open, visit this URL:')
  console.error(authUrl)

  // Open browser
  try {
    await open(authUrl)
  } catch (err) {
    console.error('Could not open browser automatically')
  }

  console.error('\nAfter authorizing, you will see a code on the page.')
  console.error('Copy the authorization code and paste it below.\n')

  // Get code from user
  let code
  if (getCallbackUrl) {
    code = await getCallbackUrl()
  } else {
    // FORCEFULLY take control of stdin from Ink
    const wasRaw = process.stdin.isRaw
    const allListeners = process.stdin.eventNames().reduce((acc, event) => {
      acc[event] = process.stdin.listeners(event)
      return acc
    }, {})

    // Remove ALL listeners and disable raw mode
    process.stdin.removeAllListeners()
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
    process.stdin.resume()

    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false
    })

    code = await new Promise(resolve => {
      rl.question('Paste authorization code: ', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })

    // Restore everything
    if (process.stdin.setRawMode && wasRaw) {
      process.stdin.setRawMode(true)
    }

    // Restore all listeners
    Object.keys(allListeners).forEach(event => {
      allListeners[event].forEach(listener => {
        process.stdin.on(event, listener)
      })
    })
  }

  if (!code) {
    throw new Error('No authorization code provided')
  }


  // Claude subscriptions use bearer inference tokens.
  // Console OAuth must be exchanged into an API key instead.
  const createApiKey = oauthMode !== 'claude'
  const result = await oauthClient.completeLogin(code, verifier, state, createApiKey)

  // Save OAuth tokens
  const config = getConfig()
  config.oauthMode = oauthMode
  config.oauthTokens = result.tokens
  if (result.apiKey) {
    config.primaryApiKey = result.apiKey
  }
  saveConfig(config)

  // Save to token file
  saveToken({
    access_token: result.tokens.access,
    refresh_token: result.tokens.refresh,
    expires: result.tokens.expires,
    api_key: result.apiKey || undefined
  })

  // Verify token was persisted
  const verified = loadToken()
  if (!verified) {
    console.error('[OAuth] WARNING: Token save succeeded but loadToken() returned null!')
    console.error('[OAuth] TOKEN_PATH:', TOKEN_PATH)
    console.error('[OAuth] File exists:', fs.existsSync(TOKEN_PATH))
  } else if (process.env.DEBUG_OAUTH) {
    console.error('[OAuth] Token persisted successfully to', TOKEN_PATH)
  }

  return result.tokens.access
}

// Token persistence
export function saveToken(token) {
  const dir = path.dirname(TOKEN_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    ...token,
    savedAt: Date.now(),
    oauth_mode: oauthMode,
    oauth_config_version: 2
  }, null, 2))
}

export function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
  } catch {
    return null
  }
}

export function deleteToken() {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH)
}

export async function getValidToken() {
  // 1. Check our own token file
  const token = loadToken()
  if (token) {
    const tokenMode = token.oauth_mode || getConfig().oauthMode || 'anthropic'
    if (tokenMode === 'claude') {
      const expiresAt = token.expires || (token.savedAt + (token.expires_in || 3600) * 1000)
      const bufferMs = 5 * 60 * 1000 // 5 minute buffer

      if (Date.now() <= expiresAt - bufferMs) {
        // Token is still valid
        return token.access_token
      }

      // Token expired — try refresh
      if (token.refresh_token) {
        try {
          const refreshed = await oauthClient.refreshAccessToken(token.refresh_token)
          const newToken = {
            access_token: refreshed.access,
            refresh_token: refreshed.refresh,
            expires: refreshed.expires,
          }
          saveToken(newToken)

          // Also update config
          const config = getConfig()
          if (config.oauthTokens) {
            config.oauthTokens = { ...config.oauthTokens, access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires }
            saveConfig(config)
          }

          return refreshed.access
        } catch (err) {
          if (process.env.DEBUG_OAUTH) {
            console.error('[OAuth] Token refresh failed:', err.message)
          }
        }
      }
    }
  }

  // 2. Check shared credentials (~/.claude/.credentials.json)
  try {
    const claudeCredsPath = path.join(os.homedir(), '.claude', '.credentials.json')
    if (fs.existsSync(claudeCredsPath)) {
      const creds = JSON.parse(fs.readFileSync(claudeCredsPath, 'utf8'))
      const oauth = creds?.claudeAiOauth
      if (oauth?.accessToken) {
        const bufferMs = 5 * 60 * 1000
        const expired = oauth.expiresAt && Date.now() > oauth.expiresAt - bufferMs

        if (!expired) {
          return oauth.accessToken
        }

        // Expired — try refresh with real CC refresh token
        if (oauth.refreshToken) {
          try {
            const refreshed = await oauthClient.refreshAccessToken(oauth.refreshToken)

            // Save back to shared credentials
            creds.claudeAiOauth = {
              ...oauth,
              accessToken: refreshed.access,
              refreshToken: refreshed.refresh,
              expiresAt: refreshed.expires,
            }
            fs.writeFileSync(claudeCredsPath, JSON.stringify(creds, null, 2))

            // Also save to our own token file for faster access next time
            saveToken({
              access_token: refreshed.access,
              refresh_token: refreshed.refresh,
              expires: refreshed.expires,
            })

            if (process.env.DEBUG_OAUTH) {
              console.error('[OAuth] Refreshed shared token successfully')
            }

            return refreshed.access
          } catch (err) {
            if (process.env.DEBUG_OAUTH) {
              console.error('[OAuth] Shared token refresh failed:', err.message)
            }
          }
        }
      }
    }
  } catch (err) {
    if (process.env.DEBUG_OAUTH) {
      console.error('[OAuth] Error reading Claude credentials:', err.message)
    }
  }

  return null
}

export function isOAuthAuthenticated() {
  return loadToken() !== null
}

export function logout() {
  deleteToken()
  const config = getConfig()
  delete config.claudeOAuthToken
  delete config.primaryApiKey
  delete config.oauthTokens
  delete config.oauthMode
  delete config.oauthAccount
  saveConfig(config)
  // Clear env so cached client doesn't keep using the old token
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
}

export function getAuthInfo() {
  const config = getConfig()
  const savedApiKey = process.env.ANTHROPIC_API_KEY || config.apiKey || config.primaryApiKey
  if (savedApiKey) {
    return { method: 'api_key', authenticated: true }
  }

  // Check Dario's own token
  const token = loadToken()
  if (token) {
    const expiresAt = token.expires || (token.savedAt + (token.expires_in || 3600) * 1000)
    const expired = Date.now() > expiresAt
    return {
      method: 'oauth',
      authenticated: true, // We have a token (refresh will happen on use)
      expiresAt,
      expired,
      canRefresh: !!token.refresh_token,
      hasApiKey: !!token.api_key
    }
  }

  // Check shared credentials (~/.claude/.credentials.json)
  try {
    const claudeCredsPath = path.join(os.homedir(), '.claude', '.credentials.json')
    if (fs.existsSync(claudeCredsPath)) {
      const creds = JSON.parse(fs.readFileSync(claudeCredsPath, 'utf8'))
      const oauth = creds?.claudeAiOauth
      if (oauth?.accessToken) {
        const expired = oauth.expiresAt && oauth.expiresAt <= Date.now()
        return {
          method: 'oauth',
          // Authenticated if token is valid OR can be refreshed
          authenticated: !expired || !!oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          subscriptionType: oauth.subscriptionType || null,
          expired,
          canRefresh: !!oauth.refreshToken,
        }
      }
    }
  } catch {}

  if (config.oauthTokens?.access) {
    return {
      method: 'oauth',
      authenticated: true,
      expiresAt: config.oauthTokens.expires
    }
  }

  return { method: 'none', authenticated: false }
}

export default {
  authenticateWithOAuth,
  getValidToken,
  isOAuthAuthenticated,
  logout,
  getAuthInfo,
  loadToken,
  saveToken: saveToken,
  deleteToken,
  setOAuthMode
}
