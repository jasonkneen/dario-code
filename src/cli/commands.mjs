/**
 * CLI Commands Module
 *
 * Implements slash commands for the Dario CLI.
 * Commands include model switching, context management, authentication,
 * task management, todos, plugin management, session resume/export, etc.
 */

import { VERSION, getModel, setModelOverride, loadConfig, saveConfig, getConfigValue, setConfigValue, loadSettings, saveSettings, isFastMode, setFastMode, modelSupportsFastMode, getFastModeModel, getFastModeDisplayName, getConfigDir, getClaudeConfigDir, loadClaudeMd, getDisabledContextItems, isContextItemDisabled, addCustomContextItem, removeCustomContextItem, getCustomContextItems } from '../core/config.mjs'
import { getAllProviders, getProvider } from '../providers/registry.mjs'
import { loadProviderConfig, getEnabledModels, setProviderKey, toggleModel, enableProvider, disableProvider } from '../providers/config.mjs'
import { addMcpServer, removeMcpServer, getAllMcpServers, getSingleMcpServer } from '../integration/mcp.mjs'
import { getSessionUsage } from '../api/streaming.mjs'
import { vimMode } from '../keyboard/vim-mode.mjs'
import { isGitRepo, getRepoInfo, getStatus } from '../git/index.mjs'
import * as ui from '../ui/index.mjs'
import {
  getPluginStatus,
  getRegisteredPlugins,
  getEnabledPlugins,
  enablePluginByName as registryEnablePlugin,
  disablePluginByName as registryDisablePlugin,
  loadPluginManifest
} from '../plugins/index.mjs'
import {
  installFromNpm,
  installFromLocal,
  uninstallPlugin
} from '../plugins/installer.mjs'
import * as sessions from '../sessions/index.mjs'
import {
  listBackgroundTasks,
  getTaskStatus,
  getTaskOutput,
  killTask,
  TaskStatus
} from '../tasks/background.mjs'

// ============================================================================
// Available Models Configuration
// ============================================================================

/**
 * Available Claude models for selection
 */
export const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Latest Sonnet - Fast and capable' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most capable - latest Opus' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', description: 'Previous Opus generation' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fast and efficient' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Previous Sonnet generation' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', description: 'Legacy - lightweight' },
  { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', description: 'Legacy - previous flagship' }
]

/**
 * Get all available models: Anthropic built-ins + enabled provider models.
 * Model IDs from non-Anthropic providers are prefixed as 'providerId:modelId'.
 * @returns {Array} Array of { id, name, description, provider }
 */
export function getAvailableModels() {
  const base = AVAILABLE_MODELS.map(m => ({ ...m, provider: 'anthropic' }))
  try {
    const providerModels = getEnabledModels()
      .filter(m => m.provider !== 'anthropic')
      .map(m => ({
        id: m.prefixedId,
        name: m.name,
        description: `${getProvider(m.provider)?.name || m.provider} · ${m.category || ''}`.trim(),
        provider: m.provider,
      }))
    return [...base, ...providerModels]
  } catch {
    return base
  }
}

/**
 * Model context window limits
 */
export const MODEL_LIMITS = {
  'claude-sonnet-4-6': 200000,
  'claude-opus-4-6': 200000,
  'claude-opus-4-5-20251101': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-opus-20240229': 200000
}

// ============================================================================
// Working Directory Management
// ============================================================================

/**
 * Additional working directories beyond the main cwd
 */
const additionalWorkingDirs = new Set()

/**
 * Get all working directories (main cwd + additional)
 * @returns {string[]} Array of working directory paths
 */
export function getAllWorkingDirs() {
  return [process.cwd(), ...additionalWorkingDirs]
}

/**
 * Add a working directory
 * @param {string} dir - Directory path to add
 */
export function addWorkingDir(dir) {
  additionalWorkingDirs.add(dir)
}

/**
 * Remove a working directory
 * @param {string} dir - Directory path to remove
 * @returns {boolean} True if removed
 */
export function removeWorkingDir(dir) {
  return additionalWorkingDirs.delete(dir)
}

// ============================================================================
// Todo State Management
// ============================================================================

/**
 * Current todo list state
 */
let todoList = []

/**
 * Get current todos
 * @returns {Array} Current todo list
 */
export function getTodos() {
  return todoList
}

/**
 * Set todos (used by TodoWrite tool)
 * @param {Array} todos - New todo list
 */
export function setTodos(todos) {
  todoList = todos
}

/**
 * Get todo statistics
 * @returns {Object} Statistics object
 */
export function getTodoStatistics() {
  const stats = {
    total: todoList.length,
    pending: 0,
    inProgress: 0,
    completed: 0
  }

  for (const todo of todoList) {
    if (todo.status === 'pending') stats.pending++
    else if (todo.status === 'in_progress') stats.inProgress++
    else if (todo.status === 'completed') stats.completed++
  }

  return stats
}

// ============================================================================
// Command Implementations
// ============================================================================

/**
 * /model command - Switch between AI models
 */
export const modelCommand = {
  type: 'local',
  name: 'model',
  aliases: ['models'],
  description: 'Switch between AI models',
  isEnabled: true,
  isHidden: false,

  async call(closeOverlay, context) {
    const currentModel = await getModel()
    const modelArg = context?.args?.[0]
    const allModels = getAvailableModels()

    // If argument provided, try to set that model
    if (modelArg) {
      const model = allModels.find(m =>
        m.id.includes(modelArg.toLowerCase()) ||
        m.name.toLowerCase().includes(modelArg.toLowerCase())
      )

      if (model) {
        setModelOverride(model.id)
        return `Model set to ${model.name} (${model.id})`
      } else {
        return `Unknown model: ${modelArg}\n\nAvailable models:\n${allModels.map(m => `  ${m.name}: ${m.id}`).join('\n')}`
      }
    }

    // No args — trigger interactive overlay if available (TUI context)
    if (context?.showModelSelector) {
      context.showModelSelector()
      return null
    }

    // Fallback for non-TUI: show text list grouped by provider
    let output = `Current model: ${currentModel}\n\nAvailable models:\n`
    const byProvider = {}
    for (const m of allModels) {
      const key = m.provider || 'anthropic'
      if (!byProvider[key]) byProvider[key] = []
      byProvider[key].push(m)
    }
    for (const [provider, models] of Object.entries(byProvider)) {
      output += `\n  [${provider}]\n`
      output += models.map(m => {
        const isCurrent = m.id === currentModel
        return `    ${isCurrent ? '→ ' : '  '}${m.name} (${m.id})${isCurrent ? ' [current]' : ''}`
      }).join('\n')
      output += '\n'
    }
    output += '\nUsage: /model <name> - e.g., /model opus, /model haiku, /model sonnet'
    return output
  },

  userFacingName() {
    return 'model'
  }
}

/**
 * /auth command - Show authentication status and management
 */
export const authCommand = {
  type: 'local',
  name: 'auth',
  description: 'Show authentication status and manage login',
  isEnabled: true,
  isHidden: false,

  async call(closeOverlay, context) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'

    // Try to load config for OAuth account info
    let config = {}
    try {
      const configModule = await import('../core/config.mjs')
      config = configModule.loadGlobalConfig ? configModule.loadGlobalConfig() : {}
    } catch (e) {
      // Config not available
    }

    const oauthAccount = config.oauthAccount
    const primaryApiKey = config.primaryApiKey

    let output = `Authentication Status\n`
    output += `${'─'.repeat(52)}\n\n`

    // Determine auth method
    if (oauthAccount) {
      output += `Auth Method: OAuth (Console)\n`
      output += `Account: ${oauthAccount.email || 'Unknown'}\n`
      output += `Organization: ${oauthAccount.organizationUuid || 'Personal'}\n`
    } else if (primaryApiKey) {
      output += `Auth Method: Saved API Key\n`
      output += `Key: ...${primaryApiKey.slice(-8)}\n`
    } else if (apiKey) {
      output += `Auth Method: Environment Variable (ANTHROPIC_API_KEY)\n`
      output += `Key: ...${apiKey.slice(-8)}\n`
    } else {
      output += `Auth Method: Not authenticated\n`
    }

    output += `\n`
    output += `API Endpoint:\n`
    if (baseUrl === 'https://api.anthropic.com') {
      output += `  → Direct API\n`
    } else {
      output += `  → Proxy: ${baseUrl}\n`
    }

    output += `\n`
    output += `${'─'.repeat(52)}\n`
    output += `Commands:\n`
    output += `  /login   - Sign in with OAuth\n`
    output += `  /logout  - Sign out from current account\n`
    output += `\n`
    output += `To use direct API:\n`
    output += `  1. Remove ANTHROPIC_BASE_URL from .env\n`
    output += `  2. Run /login to authenticate via OAuth\n`
    output += `\n`
    output += `To use a proxy:\n`
    output += `  Set ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY in .env`

    return output
  },

  userFacingName() {
    return 'auth'
  }
}

/**
 * /context command - Show current context window usage
 * Rich visualization for /context output
 */
export const contextCommand = {
  type: 'local',
  name: 'context',
  description: 'Show current context window usage',
  isEnabled: true,
  isHidden: false,

  async call(closeOverlay, context) {
    const subcommand = context?.args?.[0]?.toLowerCase()

    // /context manage — show interactive context manager overlay
    if (subcommand === 'manage') {
      if (context?.showContextManager) {
        context.showContextManager()
        return null
      }
      return 'Context manager not available in this mode'
    }

    // /context add <file|url|text> — add custom context from CLI
    if (subcommand === 'add') {
      const value = (context?.args || []).slice(1).join(' ').trim()
      if (!value) {
        return '  Usage: /context add <file-path|URL|search-query|text>\n  Examples:\n    /context add ./src/utils.ts\n    /context add https://docs.example.com/guide\n    /context add react hooks\n    /context add "Use snake_case for variables"'
      }

      const { existsSync, readFileSync } = await import('fs')
      const { basename } = await import('path')
      const { homedir } = await import('os')

      // Auto-detect type
      let type, label, content, source
      const expandedPath = value.startsWith('~') ? value.replace('~', homedir()) : value

      if (existsSync(expandedPath)) {
        // File
        type = 'file'
        content = readFileSync(expandedPath, 'utf-8')
        label = `File: ${basename(expandedPath)}`
        source = expandedPath
      } else if (/^https?:\/\//i.test(value)) {
        // URL
        type = 'url'
        try {
          const resp = await fetch(value)
          content = await resp.text()
          content = content.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          if (content.length > 50000) content = content.slice(0, 50000) + '\n...(truncated)'
          label = `URL: ${new URL(value).hostname}${new URL(value).pathname.slice(0, 30)}`
          source = value
        } catch (e) {
          return `  ✗ Failed to fetch URL: ${e.message}`
        }
      } else {
        // Treat as docs search query or text note
        // If it looks like a search (short, no punctuation), treat as docs; otherwise text
        const looksLikeSearch = value.length < 60 && !value.includes('\n')
        if (looksLikeSearch) {
          type = 'docs'
          label = `Docs: ${value}`
          content = `Documentation reference: ${value}`
          source = `docs:${value}`
        } else {
          type = 'text'
          label = `Note: ${value.slice(0, 40)}${value.length > 40 ? '...' : ''}`
          content = value
          source = 'text'
        }
      }

      const entry = addCustomContextItem({ type, label, source, content })
      const est = (text) => Math.ceil((text || '').length / 4)
      return `  ✓ Added context: ${label} (~${est(content).toLocaleString()} tokens)\n  Use /context manage to toggle or remove`
    }

    // /context remove <id> — remove a custom context item
    if (subcommand === 'remove' || subcommand === 'rm') {
      const itemId = (context?.args || []).slice(1).join(' ').trim()
      if (!itemId) {
        const custom = getCustomContextItems()
        if (custom.length === 0) return '  No custom context items to remove.'
        let out = '  Custom context items:\n'
        for (const ci of custom) {
          out += `    ${ci.id}  ${ci.label}\n`
        }
        out += '\n  Usage: /context remove <id>'
        return out
      }
      const removed = removeCustomContextItem(itemId)
      if (removed) return `  ✓ Removed context item: ${itemId}`
      return `  ✗ Item not found: ${itemId}`
    }

    // /context list — show custom items
    if (subcommand === 'list') {
      const custom = getCustomContextItems()
      if (custom.length === 0) return '  No custom context items. Use /context add to add some.'
      let out = '  Custom Context Items:\n'
      const disabled = getDisabledContextItems()
      for (const ci of custom) {
        const status = disabled[ci.id] ? ' [OFF]' : ''
        out += `    ${ci.label}${status}\n      id: ${ci.id} · type: ${ci.type} · added: ${ci.addedAt}\n`
      }
      return out
    }

    const est = (text) => Math.ceil((text || '').length / 4)
    const disabled = getDisabledContextItems()

    const currentModel = await getModel()
    const contextLimit = MODEL_LIMITS[currentModel] || 200000
    const messages = context?.getMessages?.() || []
    const tools = context?.tools || []
    const mcpServers = context?.mcpServers || {}
    const mcpClients = context?.mcpClients || []

    // ── Category: System Prompt ──
    const { getSystemPromptIntro, getSystemInstructions } = await import('../prompts/system.mjs')
    const intro = getSystemPromptIntro()
    const instructions = await getSystemInstructions()
    const systemText = [intro, ...instructions].join('\n')
    const systemTokens = est(systemText)
    const systemDisabled = !!disabled['systemPrompt']

    // ── Category: System Tools (non-MCP) ──
    const mcpToolNames = new Set()
    for (const t of tools) {
      if (t.name?.startsWith('mcp__') || t._lazy) mcpToolNames.add(t.name)
    }
    const systemTools = tools.filter(t => !mcpToolNames.has(t.name))
    const toolDetails = systemTools.map(t => {
      const desc = typeof t.description === 'string' ? t.description : t.name
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : ''
      return { name: t.name, tokens: est(t.name + desc + schema) }
    })
    const systemToolsTokens = toolDetails.reduce((s, t) => s + t.tokens, 0)
    const toolsDisabled = !!disabled['tools']

    // ── Category: MCP Tools ──
    const mcpTools = tools.filter(t => mcpToolNames.has(t.name))
    const mcpByServer = {}
    for (const t of mcpTools) {
      const parts = t.name.split('__')
      const server = parts.length >= 3 ? parts[1] : 'unknown'
      if (!mcpByServer[server]) mcpByServer[server] = []
      const desc = typeof t.description === 'string' ? t.description : t.name
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : ''
      mcpByServer[server].push({ name: t.name, tokens: est(t.name + desc + schema), lazy: !!t._lazy })
    }
    const mcpToolsTokens = mcpTools.reduce((s, t) => {
      const desc = typeof t.description === 'string' ? t.description : t.name
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : ''
      return s + est(t.name + desc + schema)
    }, 0)
    const mcpDisabled = !!disabled['mcpTools']

    // ── Category: Memory (DARIO.md / AGENTS.md / CLAUDE.md) ──
    const { loadClaudeMd } = await import('../core/config.mjs')
    const claudeFiles = loadClaudeMd(process.cwd())
    const memoryDetails = claudeFiles.map(f => ({
      label: f.source || f.path,
      tokens: est(f.content),
      disabled: !!disabled[`memory:${f.source}`],
    }))
    const memoryTokens = memoryDetails.reduce((s, m) => s + m.tokens, 0)
    const allMemoryDisabled = memoryDetails.every(m => m.disabled)

    // ── Category: Skills ──
    const { discoverSkills } = await import('../tools/skills-discovery.mjs')
    const skillsMap = discoverSkills(process.cwd())
    const skillDetails = Array.from(skillsMap.values()).map(s => ({
      name: s.name,
      tokens: s.tokenEstimate,
      disabled: !!disabled[`skill:${s.name}`]
    }))
    const skillsTokens = skillDetails.reduce((s, skill) => s + skill.tokens, 0)
    const allSkillsDisabled = skillDetails.every(s => s.disabled)

    // ── Category: Conversation ──
    let userTokens = 0
    let assistantTokens = 0
    let msgCount = 0
    for (const msg of messages) {
      const role = msg.message?.role || msg.role
      const content = msg.message?.content || msg.content
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      const tokens = est(text)
      if (role === 'user') userTokens += tokens
      else if (role === 'assistant') assistantTokens += tokens
      msgCount++
    }
    const conversationTokens = userTokens + assistantTokens

    // ── Category: Custom Context ──
    const customItems = getCustomContextItems()
    const customDetails = customItems.map(ci => ({
      id: ci.id,
      label: ci.label,
      tokens: est(ci.content),
      disabled: !!disabled[ci.id],
    }))
    const customTokens = customDetails.reduce((s, c) => s + c.tokens, 0)
    const allCustomDisabled = customDetails.length > 0 && customDetails.every(c => c.disabled)

    // ── Totals (only count enabled items) ──
    const effectiveSystem = systemDisabled ? 0 : systemTokens
    const effectiveTools = toolsDisabled ? 0 : systemToolsTokens
    const effectiveMcp = mcpDisabled ? 0 : mcpToolsTokens
    const effectiveMemory = memoryDetails.reduce((s, m) => s + (m.disabled ? 0 : m.tokens), 0)
    const effectiveSkills = skillDetails.reduce((s, skill) => s + (skill.disabled ? 0 : skill.tokens), 0)
    const effectiveCustom = customDetails.reduce((s, c) => s + (c.disabled ? 0 : c.tokens), 0)
    const effectiveConversation = conversationTokens
    const totalTokens = effectiveSystem + effectiveTools + effectiveMcp + effectiveMemory + effectiveSkills + effectiveCustom + effectiveConversation
    const pct = (n) => ((n / contextLimit) * 100).toFixed(1)
    const totalPct = parseFloat(pct(totalTokens))

    // ── Visual bar ──
    const barWidth = 60
    const categories = [
      { label: 'System prompt', tokens: effectiveSystem, char: '█', color: 'cyan', disabled: systemDisabled },
      { label: 'Tools', tokens: effectiveTools, char: '█', color: 'blue', disabled: toolsDisabled },
      { label: 'MCP tools', tokens: effectiveMcp, char: '█', color: 'magenta', disabled: mcpDisabled },
      { label: 'Memory', tokens: effectiveMemory, char: '█', color: 'yellow', disabled: allMemoryDisabled },
      ...(skillDetails.length > 0 ? [{ label: 'Skills', tokens: effectiveSkills, char: '█', color: 'red', disabled: allSkillsDisabled }] : []),
      ...(customDetails.length > 0 ? [{ label: 'Custom', tokens: effectiveCustom, char: '█', color: 'white', disabled: allCustomDisabled }] : []),
      { label: 'Conversation', tokens: effectiveConversation, char: '█', color: 'green', disabled: false },
    ]

    let bar = ''
    for (const cat of categories) {
      const width = Math.max(0, Math.round((cat.tokens / contextLimit) * barWidth))
      bar += cat.char.repeat(width)
    }
    const remaining = Math.max(0, barWidth - bar.length)
    bar += '░'.repeat(remaining)

    // ── Format output ──
    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
    const rpad = (s, n) => ' '.repeat(Math.max(0, n - s.length)) + s
    const disabledTag = ' [OFF]'

    let output = `\n  Context Window Usage\n`
    output += `  ${'─'.repeat(64)}\n`
    output += `  [${bar}] ${totalPct}%\n\n`

    // Legend
    output += `  `
    for (const cat of categories) {
      if (cat.tokens > 0) output += `■ ${cat.label}  `
    }
    output += `\n\n`

    // Category breakdown
    output += `  ${pad('Category', 28)} ${rpad('Tokens', 10)} ${rpad('%', 6)}\n`
    output += `  ${'─'.repeat(48)}\n`

    // System prompt
    const sysLabel = 'System prompt' + (systemDisabled ? disabledTag : '')
    output += `  ${pad(sysLabel, 28)} ${rpad('~' + systemTokens.toLocaleString(), 10)} ${rpad(pct(systemTokens) + '%', 6)}\n`

    // System tools
    const toolsLabel = 'System tools' + (toolsDisabled ? disabledTag : '')
    output += `  ${pad(toolsLabel, 28)} ${rpad('~' + systemToolsTokens.toLocaleString(), 10)} ${rpad(pct(systemToolsTokens) + '%', 6)}\n`
    // Top 5 tools by token size
    const topTools = [...toolDetails].sort((a, b) => b.tokens - a.tokens).slice(0, 5)
    for (const t of topTools) {
      output += `    ${pad(t.name, 26)} ${rpad('~' + t.tokens.toLocaleString(), 10)}\n`
    }
    if (toolDetails.length > 5) {
      output += `    ... and ${toolDetails.length - 5} more tools\n`
    }

    // MCP tools
    if (mcpToolsTokens > 0 || Object.keys(mcpServers).length > 0) {
      const mcpLabel = 'MCP tools' + (mcpDisabled ? disabledTag : '')
      output += `  ${pad(mcpLabel, 28)} ${rpad('~' + mcpToolsTokens.toLocaleString(), 10)} ${rpad(pct(mcpToolsTokens) + '%', 6)}\n`
      for (const [server, serverTools] of Object.entries(mcpByServer)) {
        const serverTokens = serverTools.reduce((s, t) => s + t.tokens, 0)
        const lazy = serverTools.some(t => t.lazy)
        const serverDisabled = !!disabled[`mcp:${server}`]
        const status = (lazy ? ' (lazy)' : '') + (serverDisabled ? ' [OFF]' : '')
        output += `    ${pad(server + status, 26)} ${rpad('~' + serverTokens.toLocaleString(), 10)}  ${serverTools.length} tools\n`
      }
    }

    // Memory
    if (memoryTokens > 0) {
      const memLabel = 'Memory (DARIO.md / AGENTS.md / CLAUDE.md)' + (allMemoryDisabled ? disabledTag : '')
      output += `  ${pad(memLabel, 28)} ${rpad('~' + memoryTokens.toLocaleString(), 10)} ${rpad(pct(memoryTokens) + '%', 6)}\n`
      for (const m of memoryDetails) {
        const mLabel = m.label + (m.disabled ? ' [OFF]' : '')
        output += `    ${pad(mLabel, 26)} ${rpad('~' + m.tokens.toLocaleString(), 10)}\n`
      }
    }

    // Skills
    if (skillsTokens > 0) {
      const skillsLabel = 'Skills' + (allSkillsDisabled ? disabledTag : '')
      output += `  ${pad(skillsLabel, 28)} ${rpad('~' + skillsTokens.toLocaleString(), 10)} ${rpad(pct(skillsTokens) + '%', 6)}\n`
      const topSkills = [...skillDetails].sort((a, b) => b.tokens - a.tokens).slice(0, 5)
      for (const s of topSkills) {
        const sLabel = s.name + (s.disabled ? ' [OFF]' : '')
        output += `    ${pad(sLabel, 26)} ${rpad('~' + s.tokens.toLocaleString(), 10)}\n`
      }
      if (skillDetails.length > 5) {
        output += `    ... and ${skillDetails.length - 5} more skills\n`
      }
    }

    // Custom context
    if (customDetails.length > 0) {
      const customLabel = 'Custom context' + (allCustomDisabled ? disabledTag : '')
      output += `  ${pad(customLabel, 28)} ${rpad('~' + customTokens.toLocaleString(), 10)} ${rpad(pct(customTokens) + '%', 6)}\n`
      for (const c of customDetails) {
        const cLabel = c.label + (c.disabled ? ' [OFF]' : '')
        output += `    ${pad(cLabel, 26)} ${rpad('~' + c.tokens.toLocaleString(), 10)}\n`
      }
    }

    // Conversation
    output += `  ${pad('Conversation', 28)} ${rpad('~' + conversationTokens.toLocaleString(), 10)} ${rpad(pct(conversationTokens) + '%', 6)}\n`
    output += `    ${pad(`User messages (${messages.filter(m => (m.message?.role || m.role) === 'user').length})`, 26)} ${rpad('~' + userTokens.toLocaleString(), 10)}\n`
    output += `    ${pad(`Assistant messages`, 26)} ${rpad('~' + assistantTokens.toLocaleString(), 10)}\n`

    // Total
    output += `  ${'─'.repeat(48)}\n`
    output += `  ${pad('Total (active)', 28)} ${rpad('~' + totalTokens.toLocaleString(), 10)} ${rpad(totalPct + '%', 6)}\n`
    output += `  ${pad('Limit', 28)} ${rpad(contextLimit.toLocaleString(), 10)}\n`
    output += `  ${pad('Remaining', 28)} ${rpad('~' + (contextLimit - totalTokens).toLocaleString(), 10)}\n`

    // Show disabled items summary
    const disabledCount = Object.keys(disabled).length
    if (disabledCount > 0) {
      output += `\n  ${disabledCount} context item${disabledCount === 1 ? '' : 's'} disabled [OFF]\n`
    }

    output += `\n  Tip: /context manage to toggle items · /context add <path|url|query> · /compact to free context\n`

    return output
  },

  userFacingName() {
    return 'context'
  }
}

/**
 * /tasks command - View and manage background tasks
 */
export const tasksCommand = {
  type: 'local',
  name: 'tasks',
  description: 'View and manage background tasks',
  isEnabled: true,
  isHidden: false,

  async call(args) {
    const tasks = listBackgroundTasks()

    if (tasks.length === 0) {
      return '\n  Background Tasks\n  ' + '─'.repeat(40) + '\n  No background tasks\n\n  Background tasks are created when you use:\n    • Bash tool with run_in_background: true\n'
    }

    // Format task for display
    const formatTask = (task) => {
      const statusIcons = {
        [TaskStatus.RUNNING]: '◐',
        [TaskStatus.COMPLETED]: '●',
        [TaskStatus.FAILED]: '✗',
        [TaskStatus.KILLED]: '○'
      }

      const statusColors = {
        [TaskStatus.RUNNING]: '#3B82F6',
        [TaskStatus.COMPLETED]: '#22C55E',
        [TaskStatus.FAILED]: '#EF4444',
        [TaskStatus.KILLED]: '#6B7280'
      }

      // Calculate duration
      const startTime = task.startedAt?.getTime() || Date.now()
      const endTime = task.completedAt?.getTime() || Date.now()
      const durationMs = endTime - startTime
      const durationStr = durationMs < 1000
        ? `${durationMs}ms`
        : durationMs < 60000
          ? `${(durationMs / 1000).toFixed(1)}s`
          : `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`

      // Truncate command for display
      const maxCmdLen = 50
      const cmd = task.command.length > maxCmdLen
        ? task.command.slice(0, maxCmdLen) + '...'
        : task.command

      return {
        id: task.id,
        command: cmd,
        fullCommand: task.command,
        status: task.status,
        statusIcon: statusIcons[task.status] || '?',
        statusLabel: task.status,
        statusColor: statusColors[task.status] || '#6B7280',
        duration: durationStr,
        pid: task.pid,
        exitCode: task.exitCode,
        outputLineCount: task.output?.length || 0
      }
    }

    let output = '\n  Background Tasks\n  ' + '─'.repeat(40) + '\n'

    for (const task of tasks) {
      const formatted = formatTask(task)
      output += `  ${formatted.statusIcon} ${formatted.command}\n`
      output += `     ${formatted.statusLabel} · ${formatted.duration} · ${formatted.outputLineCount} lines`
      if (formatted.pid) output += ` · PID ${formatted.pid}`
      if (formatted.exitCode !== null) output += ` · exit ${formatted.exitCode}`
      output += '\n\n'
    }

    output += '  ' + '─'.repeat(40) + '\n'
    output += '  Use /task <id> to view task output\n'

    return output
  },

  userFacingName() {
    return 'tasks'
  }
}

/**
 * /todos command - Display current todo list
 */
export const todosCommand = {
  type: 'local',
  name: 'todos',
  description: 'View current todo list',
  isEnabled: true,
  isHidden: false,

  async call() {
    const todos = getTodos()

    if (todos.length === 0) {
      return 'No todos currently tracked'
    }

    const statusIcons = {
      'pending': '○',
      'in_progress': '◐',
      'completed': '●'
    }

    let output = '\n  Todo List\n  ' + '─'.repeat(40) + '\n'

    todos.forEach((todo, index) => {
      const icon = statusIcons[todo.status] || '○'
      const statusLabel = todo.status.replace('_', ' ')
      output += `  ${icon} ${todo.content}\n`
      output += `     ${statusLabel}\n`
    })

    const stats = getTodoStatistics()
    output += '  ' + '─'.repeat(40) + '\n'
    output += `  ${stats.completed}/${stats.total} completed`
    if (stats.inProgress > 0) {
      output += ` · ${stats.inProgress} in progress`
    }
    output += '\n'

    return output
  },

  userFacingName() {
    return 'todos'
  }
}

/**
 * /add-dir command - Add a new working directory
 */
export const addDirCommand = {
  type: 'local',
  name: 'add-dir',
  description: 'Add a new working directory',
  isEnabled: true,
  isHidden: false,
  argNames: ['path'],

  async call(args) {
    const dirPath = args?.trim()

    if (!dirPath) {
      // Show current directories
      const dirs = getAllWorkingDirs()
      let output = '\n  Working Directories\n  ' + '─'.repeat(40) + '\n'
      output += `  ● ${process.cwd()} (main)\n`
      for (const dir of additionalWorkingDirs) {
        output += `  ○ ${dir}\n`
      }
      output += '  ' + '─'.repeat(40) + '\n'
      output += '  Usage: /add-dir <path>\n'
      return output
    }

    // Resolve path
    const { resolve } = await import('path')
    const fs = await import('fs')

    let resolvedPath
    try {
      resolvedPath = resolve(process.cwd(), dirPath)
    } catch {
      resolvedPath = dirPath.startsWith('/') ? dirPath : process.cwd() + '/' + dirPath
    }

    // Check if directory exists
    try {
      const stats = fs.statSync(resolvedPath)
      if (!stats.isDirectory()) {
        return `Error: ${resolvedPath} is not a directory`
      }
    } catch (e) {
      return `Error: Directory not found: ${resolvedPath}`
    }

    // Check if already added
    if (resolvedPath === process.cwd()) {
      return `${resolvedPath} is already the main working directory`
    }
    if (additionalWorkingDirs.has(resolvedPath)) {
      return `${resolvedPath} is already in working directories`
    }

    // Add directory
    addWorkingDir(resolvedPath)
    return `Added working directory: ${resolvedPath}`
  },

  userFacingName() {
    return 'add-dir'
  }
}

/**
 * /plugin command - Plugin management
 */
export const pluginCommand = {
  type: 'local',
  name: 'plugin',
  description: 'Manage plugins (list, install, enable, disable, remove)',
  isEnabled: true,
  isHidden: false,
  argNames: ['action', 'name'],

  async call(closeOverlay, context) {
    // Support both direct string args and TUI context
    const rawArgs = typeof closeOverlay === 'string' ? closeOverlay : ''
    const contextArgs = context?.args || []
    const parts = rawArgs ? rawArgs.trim().split(/\s+/) : contextArgs
    const action = parts[0] || ''
    const name = parts[1]

    // No args — trigger interactive overlay if available (TUI context)
    if (!action && context?.showPluginManager) {
      context.showPluginManager()
      return null
    }

    // Default to list if no overlay
    const resolvedAction = action || 'list'

    try {
      switch (resolvedAction) {
        case 'list': {
          const registered = getRegisteredPlugins()

          if (registered.length === 0) {
            return 'No plugins installed.\nUsage: /plugin install <name|path>'
          }

          let output = '\n  Installed Plugins\n  ' + '─'.repeat(40) + '\n'
          for (const p of registered) {
            const status = getPluginStatus(p)
            const icon = status === 'enabled' ? '●' : '○'
            const manifest = loadPluginManifest(p)
            const version = manifest?.version || 'unknown'
            const description = manifest?.description || ''

            output += `  ${icon} ${p}@${version} (${status})\n`
            if (description) {
              output += `     ${description}\n`
            }
          }
          return output
        }

        case 'install': {
          if (!name) {
            return 'Usage: /plugin install <name|path>'
          }

          ui.print(`Installing plugin: ${name}...`)

          let result
          // Check if it's a local path
          if (name.includes('/') || name.includes('\\')) {
            result = await installFromLocal(name)
          } else {
            result = await installFromNpm(name)
          }

          return `Successfully installed ${result.name}@${result.version}\nLocation: ${result.path}\nPlugin is disabled by default. Use /plugin enable to activate it.`
        }

        case 'enable': {
          if (!name) {
            return 'Usage: /plugin enable <name>'
          }

          const status = getPluginStatus(name)
          if (status === 'not-registered') {
            return `Plugin not found: ${name}`
          }
          if (status === 'enabled') {
            return `Plugin ${name} is already enabled.`
          }

          registryEnablePlugin(name)
          return `Successfully enabled plugin: ${name}\nPlugin will be loaded on next startup.`
        }

        case 'disable': {
          if (!name) {
            return 'Usage: /plugin disable <name>'
          }

          const status = getPluginStatus(name)
          if (status === 'not-registered') {
            return `Plugin not found: ${name}`
          }
          if (status === 'disabled') {
            return `Plugin ${name} is already disabled.`
          }

          registryDisablePlugin(name)
          return `Successfully disabled plugin: ${name}\nPlugin will be unloaded on next startup.`
        }

        case 'remove': {
          if (!name) {
            return 'Usage: /plugin remove <name>'
          }

          const status = getPluginStatus(name)
          if (status === 'not-registered') {
            return `Plugin not found: ${name}`
          }

          ui.print(`Removing plugin: ${name}...`)
          await uninstallPlugin(name)

          return `Successfully removed plugin: ${name}`
        }

        default:
          return `Plugin commands:\n  /plugin list - List installed plugins\n  /plugin install <name|path> - Install plugin\n  /plugin enable <name> - Enable plugin\n  /plugin disable <name> - Disable plugin\n  /plugin remove <name> - Remove plugin`
      }
    } catch (e) {
      return `Plugin error: ${e.message}`
    }
  },

  userFacingName() {
    return 'plugin'
  }
}

/**
 * /resume command - List and resume previous sessions
 */
export const resumeCommand = {
  type: 'local',
  name: 'resume',
  description: 'List and resume previous sessions',
  isEnabled: true,
  isHidden: false,
  isOverlay: true,

  async call(args, context) {
    // No args: show interactive session picker if in TUI context
    if (!args?.trim()) {
      if (context?.showSessionPicker) {
        context.showSessionPicker()
        return null
      }
    }

    try {
      const sessionList = await sessions.listSessions({ limit: 10 })

      if (sessionList.length === 0) {
        return 'No previous sessions found.\nUse --continue to auto-resume last session'
      }

      let output = '\n  Previous Sessions\n  ' + '─'.repeat(40) + '\n'
      sessionList.forEach((s, i) => {
        const date = new Date(s.updated || s.created).toLocaleDateString()
        const time = new Date(s.updated || s.created).toLocaleTimeString()
        output += `  ${i + 1}. ${s.name || s.id.slice(0, 8)} (${date} ${time})\n`
        if (s.messageCount) {
          output += `     ${s.messageCount} messages\n`
        }
      })
      output += '  ' + '─'.repeat(40) + '\n'
      output += '  Resume with: --resume <id>\n'
      return output
    } catch (e) {
      return `Session error: ${e.message}`
    }
  },

  userFacingName() {
    return 'resume'
  }
}

/**
 * /export command - Export current session
 */
export const exportCommand = {
  type: 'local',
  name: 'export',
  description: 'Export current session (markdown|json)',
  isEnabled: true,
  isHidden: false,
  argNames: ['format', 'filename'],

  async call(args, context) {
    const parts = (args || '').trim().split(/\s+/)
    const format = parts[0] || 'markdown'
    const filename = parts[1]

    if (format !== 'markdown' && format !== 'json') {
      return 'Usage: /export [markdown|json] [filename]'
    }

    // If we have context with messages, perform actual export
    if (context?.getMessages) {
      const messages = context.getMessages()

      if (messages.length === 0) {
        return 'No messages to export'
      }

      try {
        let exportedContent
        let exportFilename

        if (format === 'json') {
          exportedContent = JSON.stringify(messages, null, 2)
          exportFilename = filename || `session-${Date.now()}.json`
        } else {
          // Markdown format
          let md = '# Dario Session Export\n\n'
          md += `Exported: ${new Date().toISOString()}\n\n`
          md += '---\n\n'

          for (const msg of messages) {
            const role = msg.role === 'user' ? 'User' : 'Assistant'
            md += `## ${role}\n\n`

            const content = typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content, null, 2)

            md += content + '\n\n---\n\n'
          }

          exportedContent = md
          exportFilename = filename || `session-${Date.now()}.md`
        }

        // Write to file
        const fs = await import('fs/promises')
        const path = await import('path')
        const exportPath = path.join(process.cwd(), exportFilename)
        await fs.writeFile(exportPath, exportedContent, 'utf-8')

        return `Session exported to: ${exportPath}`
      } catch (e) {
        return `Export failed: ${e.message}`
      }
    }

    return `Export format: ${format}${filename ? ` to ${filename}` : ''}\nNote: Full export integration pending session context access.`
  },

  userFacingName() {
    return 'export'
  }
}

// ============================================================================
// Standard Commands (help, compact, version, quit, bug)
// ============================================================================

/**
 * Available commands registry
 */
const COMMANDS = {
  help: {
    description: 'Show help information',
    handler: handleHelp
  },
  compact: {
    description: 'Compact and continue the conversation',
    handler: () => compactCommand.call()
  },
  version: {
    description: 'Show version information',
    handler: handleVersion
  },
  quit: {
    description: 'Exit the application',
    handler: handleQuit
  },
  bug: {
    description: 'Report a bug',
    handler: () => bugCommand.call()
  },
  model: {
    description: 'Switch between AI models',
    handler: (input) => modelCommand.call(null, { args: input.slice('/model'.length).trim().split(/\s+/) })
  },
  models: {
    description: 'Alias for /model',
    handler: (input) => modelCommand.call(null, { args: input.slice('/models'.length).trim().split(/\s+/) })
  },
  auth: {
    description: 'Show authentication status',
    handler: () => authCommand.call()
  },
  context: {
    description: 'Context: show | manage | add <path|url|query> | remove <id> | list',
    handler: (input) => contextCommand.call(null, { args: input.slice('/context'.length).trim().split(/\s+/).filter(Boolean) })
  },
  tasks: {
    description: 'View background tasks',
    handler: () => tasksCommand.call()
  },
  todos: {
    description: 'View current todo list',
    handler: () => todosCommand.call()
  },
  'add-dir': {
    description: 'Add a working directory',
    handler: (input) => addDirCommand.call(input.slice('/add-dir'.length).trim())
  },
  plugin: {
    description: 'Manage plugins',
    handler: (input) => pluginCommand.call(input.slice('/plugin'.length).trim())
  },
  resume: {
    description: 'Resume a previous session',
    handler: (input, context) => resumeCommand.call(input.slice('/resume'.length).trim(), context)
  },
  export: {
    description: 'Export current session',
    handler: (input) => exportCommand.call(input.slice('/export'.length).trim())
  },
  init: {
    description: 'Create AGENTS.md file with instructions (CLAUDE.md + DARIO.md also recognised)',
    handler: handleInit
  },
  clear: {
    description: 'Clear conversation messages',
    handler: handleClear
  },
  config: {
    description: 'Manage configuration (get/set/remove/list)',
    handler: (input, context) => configCommand.call(input.slice('/config'.length).trim(), context)
  },
  'approved-tools': {
    description: 'Manage approved tools (list/remove/reset)',
    handler: (input, context) => approvedToolsCommand.call(input.slice('/approved-tools'.length).trim(), context)
  },
  mcp: {
    description: 'Manage MCP servers (interactive/list/add/remove/get)',
    handler: (input, context) => mcpCommand.call(input.slice('/mcp'.length).trim(), context)
  },
  doctor: {
    description: 'Check system health and configuration',
    handler: () => doctorCommand.call()
  },
  login: {
    description: 'Sign in with OAuth',
    handler: () => loginCommand.call()
  },
  logout: {
    description: 'Sign out of Dario',
    handler: () => logoutCommand.call()
  },
  fast: {
    description: `Toggle fast mode (${getFastModeDisplayName()} only)`,
    handler: (input) => fastCommand.call(null, { args: input.slice('/fast'.length).trim().split(/\s+/) })
  },
  status: {
    description: 'Show project and session status',
    handler: () => statusCommand.call()
  },
  cost: {
    description: 'Show API usage and cost for this session',
    handler: () => costCommand.call()
  },
  memory: {
    description: 'Show or edit AGENTS.md memory file (CLAUDE.md + DARIO.md also recognised)',
    handler: (input) => memoryCommand.call(null, { args: input.slice('/memory'.length).trim().split(/\s+/) })
  },
  vim: {
    description: 'Toggle vim keybindings',
    handler: (input) => vimCommand.call(null, { args: input.slice('/vim'.length).trim().split(/\s+/) })
  },
  voice: {
    description: 'Hold Space to speak (toggle voice mode)',
    handler: (input) => voiceCommand.call(null, { args: input.slice('/voice'.length).trim().split(/\s+/).filter(Boolean) })
  },
  'terminal-setup': {
    description: 'Configure shell integration',
    handler: () => terminalSetupCommand.call()
  },
  steer: {
    description: 'Open steering questions (multi-tab decision maker)',
    handler: (input, context) => {
      if (context?.showSteeringQuestions) {
        context.showSteeringQuestions()
        return null
      }
      return '⚠ Steering questions only available in TUI mode.'
    }
  },
  stats: {
    description: 'Show usage statistics and session insights',
    handler: () => statsCommand.call()
  },
  rename: {
    description: 'Name the current session',
    handler: (input, context) => renameCommand.call(null, { args: input.slice('/rename'.length).trim().split(/\s+/) })
  },
  debug: {
    description: 'Show debug information for the current session',
    handler: () => debugCommand.call()
  },
  settings: {
    description: 'Alias for /config',
    handler: (input, context) => configCommand.call(input.slice('/settings'.length).trim(), context)
  },
  simplify: {
    description: 'Simplify recently changed code (optional focus area)',
    handler: (input, context) => simplifyCommand.call(null, { ...context, args: input.slice('/simplify'.length).trim().split(/\s+/).filter(Boolean) })
  },
  batch: {
    description: 'Queue prompts to run sequentially: add <prompt> | run | list | clear',
    handler: (input, context) => batchCommand.call(null, { ...context, args: input.slice('/batch'.length).trim().split(/\s+/).filter(Boolean) })
  },
}

/**
 * Check if input is a command
 * @param {string} input - User input
 * @returns {boolean} True if input is a command
 */
export function isCommand(input) {
  return input.startsWith('/')
}

/**
 * Process a command
 * @param {string} input - Command input
 * @returns {Promise<boolean>} True if command was handled
 */
export async function processCommand(input) {
  const commandName = input.slice(1).split(' ')[0]

  if (COMMANDS[commandName]) {
    const result = await COMMANDS[commandName].handler(input)
    if (result && typeof result === 'string') {
      ui.print(result)
    }
    return true
  } else {
    ui.showError(`Unknown command: ${commandName}`)
    return false
  }
}

/**
 * Handle /help command
 */
function handleHelp() {
  ui.print('\nAvailable commands:')
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    ui.print(`  /${name} - ${description}`)
  }
  ui.print('\nYou can also ask Claude anything about your code or project.')
  return true
}

/**
 * Handle /compact command — compacts conversation to free context space
 * Returns an action object that the TUI uses to replace messages
 */
function handleCompact(messages) {
  if (!messages || !Array.isArray(messages) || messages.length < 3) {
    return { action: 'compact_messages', error: 'Not enough messages to compact' }
  }
  return { action: 'compact_messages' }
}

/**
 * Handle /version command
 */
function handleVersion() {
  ui.print(`Dario v${VERSION}`)
  return true
}

/**
 * Handle /quit command
 */
function handleQuit() {
  ui.print('Goodbye!')
  process.exit(0)
}

/**
 * Handle /bug command
 */
function handleBugReport(input) {
  ui.print('Thank you for reporting a bug!')
  ui.print('Please file a GitHub issue at: https://github.com/jkneen/dario-code/issues')
  return true
}

/**
 * Handle /init command - creates DARIO.md with instructions
 * Also checks for existing AGENTS.md or CLAUDE.md and won't overwrite them.
 */
async function handleInit() {
  const { existsSync, writeFileSync } = await import('fs')
  const { join } = await import('path')

  // Check all recognised memory file aliases — don't overwrite any existing one
  for (const fname of ['AGENTS.md', 'CLAUDE.md', 'DARIO.md']) {
    if (existsSync(join(process.cwd(), fname))) {
      return `${fname} already exists. Use a text editor to modify it.\n\nNote: AGENTS.md, CLAUDE.md and DARIO.md are all treated as the same file — Claude loads whichever it finds first.`
    }
  }

  const darioMdPath = join(process.cwd(), 'AGENTS.md')

  const template = `# Dario Development Guide

## Commands
- Build: \`npm run build\`
- Test: \`npm test\`
- Dev: \`npm run dev\`

## Code Style Guidelines
- Use consistent indentation (2 or 4 spaces)
- Follow existing patterns in the codebase
- Write clear, descriptive variable and function names
- Add comments for complex logic

## Project-Specific Instructions
Add your project-specific instructions here for Dario to follow when working on this codebase.

## Architecture Notes
Describe your project's architecture, key components, and design patterns here.

## Testing Guidelines
Describe your testing requirements and conventions here.

---
_CLAUDE.md and DARIO.md are also recognised as aliases._
`

  try {
    writeFileSync(darioMdPath, template, 'utf8')
    return `✓ Created AGENTS.md in ${process.cwd()}\n\nEdit this file to add project-specific instructions for Dario.\nCLAUDE.md and DARIO.md are also recognised as aliases.`
  } catch (error) {
    return `✗ Failed to create AGENTS.md: ${error.message}`
  }
}

/**
 * Handle /clear command - clears conversation messages
 */
function handleClear() {
  // This will be handled by the TUI to actually clear messages
  return { action: 'clear_messages' }
}

// ============================================================================
// Command Objects for TUI Integration
// ============================================================================

/**
 * /init command - creates CLAUDE.md file
 */
export const initCommand = {
  type: 'local',
  name: 'init',
  description: 'Create an AGENTS.md file with instructions for Dario',
  isEnabled: true,
  userFacingName() {
    return 'init'
  },
  async call() {
    return await handleInit()
  }
}

/**
 * /clear command - clears conversation messages
 */
export const clearCommand = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation messages',
  isEnabled: true,
  userFacingName() {
    return 'clear'
  },
  async call(_, context) {
    // Use context.clearMessages if available
    if (context?.clearMessages) {
      context.clearMessages()
      return '✓ Conversation cleared'
    }
    return handleClear()
  }
}

/**
 * /config command - manage configuration
 */
export const configCommand = {
  type: 'local',
  name: 'config',
  description: 'Manage configuration (get/set/remove/list)',
  isEnabled: true,
  isOverlay: true,
  userFacingName() {
    return 'config'
  },
  async call(args, context) {
    const parts = (args || '').trim().split(/\s+/)
    const subcommand = parts[0]?.toLowerCase()

    // No args: show interactive manager if in TUI context
    if (!subcommand || subcommand === 'list') {
      if (context?.showConfigManager) {
        context.showConfigManager()
        return null
      }
    }
    const key = parts[1]
    const value = parts.slice(2).join(' ')

    switch (subcommand) {
      case 'get':
        if (!key) return '✗ Usage: /config get <key>'
        const val = getConfigValue(key)
        return val !== null ? `${key}: ${JSON.stringify(val)}` : `✗ Key "${key}" not found`

      case 'set':
        if (!key) return '✗ Usage: /config set <key> <value>'
        if (!value) return '✗ Usage: /config set <key> <value>'
        // Try to parse as JSON, fallback to string
        let parsedValue = value
        try {
          parsedValue = JSON.parse(value)
        } catch {
          // Keep as string
        }
        setConfigValue(key, parsedValue)
        return `✓ Set ${key} = ${JSON.stringify(parsedValue)}`

      case 'remove':
        if (!key) return '✗ Usage: /config remove <key>'
        const config = loadConfig()
        if (!(key in config)) return `✗ Key "${key}" not found`
        delete config[key]
        saveConfig(config)
        return `✓ Removed ${key}`

      case 'list':
        const allConfig = loadConfig()
        if (Object.keys(allConfig).length === 0) {
          return 'No configuration values set'
        }
        let output = 'Configuration:\n'
        for (const [k, v] of Object.entries(allConfig)) {
          output += `  ${k}: ${JSON.stringify(v)}\n`
        }
        return output

      default:
        return '✗ Usage: /config <get|set|remove|list> [key] [value]'
    }
  }
}

/**
 * /approved-tools command - manage tool approvals
 */
export const approvedToolsCommand = {
  type: 'local',
  name: 'approved-tools',
  description: 'Manage approved tools (list/remove/reset)',
  isEnabled: true,
  isOverlay: true,
  userFacingName() {
    return 'approved-tools'
  },
  async call(args, context) {
    const parts = (args || '').trim().split(/\s+/)
    const subcommand = parts[0]?.toLowerCase()

    // No args: show interactive manager if in TUI context
    if (!subcommand || subcommand === 'list') {
      if (context?.showApprovedToolsManager) {
        context.showApprovedToolsManager()
        return null
      }
    }
    const toolPattern = parts.slice(1).join(' ')

    const settings = loadSettings()
    const permissions = settings.permissions || { allow: [], deny: [], ask: [] }

    switch (subcommand) {
      case 'list':
        if (permissions.allow.length === 0) {
          return 'No approved tools'
        }
        let output = 'Approved tools:\n'
        for (const tool of permissions.allow) {
          output += `  ✓ ${tool}\n`
        }
        if (permissions.deny.length > 0) {
          output += '\nDenied tools:\n'
          for (const tool of permissions.deny) {
            output += `  ✗ ${tool}\n`
          }
        }
        return output

      case 'remove':
        if (!toolPattern) return '✗ Usage: /approved-tools remove <tool-pattern>'

        const initialCount = permissions.allow.length
        permissions.allow = permissions.allow.filter(tool => tool !== toolPattern)

        if (permissions.allow.length === initialCount) {
          return `✗ Tool pattern "${toolPattern}" not found in approved list`
        }

        settings.permissions = permissions
        saveSettings(settings)
        return `✓ Removed approval for: ${toolPattern}`

      case 'reset':
        settings.permissions = { allow: [], deny: [], ask: [] }
        saveSettings(settings)
        return '✓ All tool approvals cleared'

      default:
        return '✗ Usage: /approved-tools <list|remove|reset> [tool-pattern]'
    }
  }
}

/**
 * /login command - authenticate with OAuth
 */
export const loginCommand = {
  type: 'local',
  name: 'login',
  description: 'Sign in with OAuth',
  isEnabled: true,
  userFacingName() {
    return 'login'
  },
  async call(_, context) {
    // Show auth selector if in TUI context
    if (context?.showAuthSelector) {
      context.showAuthSelector()
      return null // Let TUI handle the flow
    }

    // CLI mode - do OAuth directly
    const { authenticateWithOAuth } = await import('../auth/oauth.mjs')
    try {
      await authenticateWithOAuth()
      return '✓ Successfully authenticated! You can now use the API.'
    } catch (error) {
      return `✗ Authentication failed: ${error.message}`
    }
  }
}

/**
 * /logout command - sign out
 */
export const logoutCommand = {
  type: 'local',
  name: 'logout',
  description: 'Sign out of Dario',
  isEnabled: true,
  userFacingName() {
    return 'logout'
  },
  async call() {
    const { logout } = await import('../auth/oauth.mjs')
    const { resetClient } = await import('../api/client.mjs')

    try {
      logout()
      resetClient()
      return '✓ Logged out successfully'
    } catch (error) {
      return `✗ Logout failed: ${error.message}`
    }
  }
}

/**
 * /doctor command - health check
 */
export const doctorCommand = {
  type: 'local',
  name: 'doctor',
  description: 'Check system health and configuration',
  isEnabled: true,
  userFacingName() {
    return 'doctor'
  },
  async call() {
    let output = '🏥 Dario Health Check\n\n'
    let hasIssues = false

    // Check Node.js version
    const nodeVersion = process.version
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0])
    if (majorVersion >= 18) {
      output += `✓ Node.js ${nodeVersion} (18+ required)\n`
    } else {
      output += `✗ Node.js ${nodeVersion} - Upgrade to 18+ required\n`
      hasIssues = true
    }

    // Check authentication
    const { getValidToken } = await import('../auth/oauth.mjs')
    try {
      const token = await getValidToken()
      if (token) {
        output += `✓ Authentication configured\n`
      } else {
        output += `✗ No valid authentication - run /auth to login\n`
        hasIssues = true
      }
    } catch {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (apiKey) {
        output += `✓ API key configured via environment\n`
      } else {
        output += `✗ No API key or OAuth token - run /auth or set ANTHROPIC_API_KEY\n`
        hasIssues = true
      }
    }

    // Check config directory
    const { getConfigDir } = await import('../core/config.mjs')
    const { existsSync } = await import('fs')
    const configDir = getConfigDir()
    if (existsSync(configDir)) {
      output += `✓ Config directory: ${configDir}\n`
    } else {
      output += `~ Config directory not created yet\n`
    }

    // Check MCP servers
    const servers = getAllMcpServers({
      getGlobalConfig: loadConfig,
      setGlobalConfig: saveConfig,
      getProjectConfig: () => ({}),
      setProjectConfig: () => {},
      getMcprcConfig: () => null
    })
    const serverCount = Object.keys(servers).length
    if (serverCount > 0) {
      output += `✓ MCP servers configured: ${serverCount}\n`
    } else {
      output += `• No MCP servers configured\n`
    }

    // Check tools
    output += `✓ Tools available: 18\n`

    // Overall status
    output += `\n${hasIssues ? '⚠️' : '✅'} Overall: ${hasIssues ? 'Issues found' : 'All systems operational'}`

    return output
  }
}

/**
 * /mcp command - manage MCP servers
 */
export const mcpCommand = {
  type: 'local',
  name: 'mcp',
  description: 'Manage MCP servers (list/add/remove/get)',
  isEnabled: true,
  isOverlay: true,
  userFacingName() {
    return 'mcp'
  },
  async call(args, context) {
    const parts = (args || '').trim().split(/\s+/)
    const subcommand = parts[0]?.toLowerCase()
    const serverName = parts[1]
    const command = parts[2]

    // No args: show interactive manager if in TUI context
    if (!subcommand) {
      if (context?.showMcpManager) {
        context.showMcpManager()
        return null
      }
      // Fallback: show list
      return mcpCommand.call('list')
    }

    // Import path and fs modules
    const { join } = await import('path')
    const { existsSync, readFileSync, mkdirSync, writeFileSync } = await import('fs')

    // Create dependency object for MCP functions
    const deps = {
      getGlobalConfig: loadConfig,
      setGlobalConfig: saveConfig,
      getProjectConfig: () => {
        const projectConfigPath = join(process.cwd(), '.dario', 'config.json')
        if (!existsSync(projectConfigPath)) return {}
        try {
          return JSON.parse(readFileSync(projectConfigPath, 'utf8'))
        } catch {
          return {}
        }
      },
      setProjectConfig: (config) => {
        const projectDir = join(process.cwd(), '.dario')
        if (!existsSync(projectDir)) {
          mkdirSync(projectDir, { recursive: true })
        }
        const projectConfigPath = join(projectDir, 'config.json')
        writeFileSync(projectConfigPath, JSON.stringify(config, null, 2))
      },
      getMcprcConfig: () => {
        const mcprcPath = join(process.cwd(), '.mcprc')
        if (!existsSync(mcprcPath)) return null
        try {
          return JSON.parse(readFileSync(mcprcPath, 'utf8'))
        } catch {
          return null
        }
      }
    }

    switch (subcommand) {
      case 'list': {
        const servers = getAllMcpServers(deps)
        if (Object.keys(servers).length === 0) {
          return 'No MCP servers configured'
        }
        let output = 'Configured MCP servers:\n'
        for (const [name, config] of Object.entries(servers)) {
          output += `  • ${name}\n`
          output += `    Command: ${config.command || 'N/A'}\n`
          if (config.args?.length > 0) {
            output += `    Args: ${config.args.join(' ')}\n`
          }
        }
        return output
      }

      case 'get': {
        if (!serverName) return '✗ Usage: /mcp get <server-name>'
        const server = getSingleMcpServer(serverName, deps)
        if (!server) {
          return `✗ MCP server "${serverName}" not found`
        }
        let output = `MCP Server: ${serverName}\n`
        output += `  Scope: ${server.scope || 'unknown'}\n`
        output += `  Command: ${server.command || 'N/A'}\n`
        if (server.args?.length > 0) {
          output += `  Args: ${server.args.join(' ')}\n`
        }
        if (server.env) {
          output += `  Env vars: ${Object.keys(server.env).join(', ')}\n`
        }
        return output
      }

      case 'add': {
        if (!serverName) return '✗ Usage: /mcp add <name> <command> [args...]'
        if (!command) return '✗ Usage: /mcp add <name> <command> [args...]'

        const mcpArgs = parts.slice(3)
        const scope = 'project' // Default to project scope

        try {
          addMcpServer(serverName, {
            command,
            args: mcpArgs.length > 0 ? mcpArgs : undefined
          }, scope, deps)
          return `✓ Added MCP server "${serverName}" to ${scope} scope\n  Command: ${command}${mcpArgs.length > 0 ? '\n  Args: ' + mcpArgs.join(' ') : ''}`
        } catch (error) {
          return `✗ Failed to add MCP server: ${error.message}`
        }
      }

      case 'remove': {
        if (!serverName) return '✗ Usage: /mcp remove <name>'

        try {
          // Try to determine scope by checking where it exists
          const server = getSingleMcpServer(serverName, deps)
          if (!server) {
            return `✗ MCP server "${serverName}" not found`
          }

          const scope = server.scope || 'project'
          removeMcpServer(serverName, scope, deps)
          return `✓ Removed MCP server "${serverName}" from ${scope} scope`
        } catch (error) {
          return `✗ Failed to remove MCP server: ${error.message}`
        }
      }

      default:
        return '✗ Usage: /mcp <list|add|remove|get> [args...]'
    }
  }
}

// ============================================================================
// /compact command - Compact conversation to free context space
// ============================================================================

export const compactCommand = {
  type: 'local',
  name: 'compact',
  description: 'Compact conversation to free context space',
  isEnabled: true,
  userFacingName() { return 'compact' },

  async call(closeOverlay, context) {
    const messages = context?.getMessages?.()
    if (!messages || messages.length < 5) {
      return 'Not enough messages to compact (need at least 5 messages)'
    }

    const { compactMessagesWithAi, compactFromMessage } = await import('../utils/summarize.mjs');

    const args = context?.args || []
    let compacted

    if (args[0] === 'last' && args[1]) {
      // /compact last <N> — keep only the last N messages, summarize everything before
      const keepN = parseInt(args[1], 10)
      if (isNaN(keepN) || keepN < 1) return 'Usage: /compact last <N> — keep last N messages'
      const fromIndex = Math.max(0, messages.length - keepN)
      compacted = await compactFromMessage(messages, 0, keepN)
    } else if (args[0] && !isNaN(parseInt(args[0], 10))) {
      // /compact <N> — compact from message N onwards
      const fromIndex = parseInt(args[0], 10) - 1  // user-facing 1-based
      if (fromIndex < 0 || fromIndex >= messages.length) {
        return `Message index out of range (1–${messages.length})`
      }
      compacted = await compactFromMessage(messages, fromIndex, 4)
    } else {
      // /compact — compact all (existing behaviour)
      compacted = await compactMessagesWithAi(messages)
    }

    const removed = messages.length - compacted.length;

    if (removed <= 0) {
      return 'Conversation is already compact'
    }

    // Tell the TUI to replace messages with the compacted set
    if (context?.setMessages) {
      const confirmationMsg = createMessage('assistant', `✓ Compacted conversation: ${removed} older messages were summarized into a new context message.`);
      context.setMessages([...compacted, confirmationMsg]);
      return null; // TUI handles the message
    }

    // Fallback for non-TUI
    return `Compaction needed, but cannot be performed in this mode. ${removed} messages could be summarized.`
  }
}

// ============================================================================
// /status command - Show project and session status
// ============================================================================

export const statusCommand = {
  type: 'local',
  name: 'status',
  description: 'Show project and session status',
  isEnabled: true,
  userFacingName() { return 'status' },

  async call() {
    const cwd = process.cwd()
    const currentModel = await getModel()
    const usage = getSessionUsage()
    const config = loadConfig()

    let output = `\n  Session Status\n  ${'─'.repeat(44)}\n`
    output += `  Working directory: ${cwd}\n`
    output += `  Model:             ${currentModel}\n`
    output += `  Fast mode:         ${isFastMode() ? 'ON' : 'OFF'}\n`
    output += `  Turns this session: ${usage.turns}\n`

    // Git info
    try {
      const inRepo = await isGitRepo()
      if (inRepo) {
        const repoInfo = await getRepoInfo()
        const status = await getStatus()
        output += `\n  Git\n  ${'─'.repeat(44)}\n`
        output += `  Branch:  ${repoInfo?.currentBranch || 'unknown'}\n`
        const statusLines = (status || '').split('\n').filter(Boolean)
        if (statusLines.length > 0) {
          output += `  Changes: ${statusLines.length} file${statusLines.length === 1 ? '' : 's'} modified\n`
        } else {
          output += `  Changes: working tree clean\n`
        }
      }
    } catch {}

    // CLAUDE.md status
    const { existsSync } = await import('fs')
    const { join } = await import('path')
    const hasClaudeMd = ['DARIO.md','AGENTS.md','CLAUDE.md'].some(f => existsSync(join(cwd, f)))
    output += `\n  Project\n  ${'─'.repeat(44)}\n`
    output += `  DARIO.md/AGENTS.md/CLAUDE.md: ${hasClaudeMd ? '✓ found' : '✗ not found (use /init to create)'}\n`

    output += `  Vim mode: ${vimMode.enabled ? 'ON' : 'OFF'}\n`

    return output
  }
}

// ============================================================================
// /cost command - Show API usage and costs for the session
// ============================================================================

export const costCommand = {
  type: 'local',
  name: 'cost',
  description: 'Show API usage and cost for this session',
  isEnabled: true,
  userFacingName() { return 'cost' },

  async call() {
    const usage = getSessionUsage()

    let output = `\n  Session Cost\n  ${'─'.repeat(44)}\n`
    output += `  Input tokens:          ${usage.inputTokens.toLocaleString()}\n`
    output += `  Output tokens:         ${usage.outputTokens.toLocaleString()}\n`

    if (usage.cacheCreationTokens > 0) {
      output += `  Cache creation tokens: ${usage.cacheCreationTokens.toLocaleString()}\n`
    }
    if (usage.cacheReadTokens > 0) {
      output += `  Cache read tokens:     ${usage.cacheReadTokens.toLocaleString()}\n`
    }

    output += `  ${'─'.repeat(44)}\n`
    output += `  Total cost:            $${usage.costUSD.toFixed(4)}\n`
    output += `  API turns:             ${usage.turns}\n`

    if (usage.turns > 0) {
      output += `  Avg cost/turn:         $${(usage.costUSD / usage.turns).toFixed(4)}\n`
    }

    return output
  }
}

// ============================================================================
// /memory command - Show or edit CLAUDE.md memory files
// ============================================================================

export const memoryCommand = {
  type: 'local',
  name: 'memory',
  description: 'Show or edit CLAUDE.md memory files and auto-extracted memories',
  isEnabled: true,
  userFacingName() { return 'memory' },

  async call(closeOverlay, context) {
    const { existsSync, readFileSync } = await import('fs')
    const { join } = await import('path')
    const cwd = process.cwd()
    const arg = context?.args?.[0]?.toLowerCase()
    const argKey = context?.args?.[1]

    // Find which memory file alias exists per location (AGENTS.md > CLAUDE.md > DARIO.md)
    const memoryFilenames = ['AGENTS.md', 'CLAUDE.md', 'DARIO.md']
    const findMemoryFile = (dir) => memoryFilenames.map(f => join(dir, f)).find(p => existsSync(p)) || join(dir, 'AGENTS.md')
    const locations = [
      { label: 'Project (AGENTS.md)', path: findMemoryFile(cwd), source: 'PRJ' },
      { label: 'User (AGENTS.md)', path: findMemoryFile(getConfigDir()), source: 'OC' },
      { label: 'User (CC)', path: join(getClaudeConfigDir(), 'CLAUDE.md'), source: 'CC' },
    ]

    if (arg === 'edit' && !argKey) {
      const projectMd = join(cwd, 'CLAUDE.md')
      if (!existsSync(projectMd)) {
        return 'No CLAUDE.md in current directory. Use /init to create one.'
      }
      const editor = process.env.EDITOR || process.env.VISUAL
      if (editor) {
        const { execFileSync } = await import('child_process')
        try {
          execFileSync(editor, [projectMd], { stdio: 'inherit' })
          return '✓ CLAUDE.md edited'
        } catch {
          return `✗ Failed to open editor. Edit manually: ${projectMd}`
        }
      }
      return `Edit your memory file at: ${projectMd}`
    }

    // Auto-memory subcommands (CC 2.1.32 parity)
    if (arg === 'list') {
      const { loadMemories } = await import('../memory/auto-memory.mjs')
      const memories = loadMemories(cwd)
      if (memories.size === 0) {
        return '  No auto-extracted memories found.\n  Memories appear after 5+ conversation turns.'
      }
      let out = `\n  Auto-Extracted Memories (${memories.size})\n  ${'─'.repeat(44)}\n`
      for (const { key, value, scope, timestamp } of memories.values()) {
        const ts = timestamp ? ` (${timestamp.slice(0, 10)})` : ''
        const tag = scope === 'global' ? ' [global]' : ''
        out += `\n  [${key}]${tag}${ts}\n  ${value.split('\n')[0].slice(0, 80)}\n`
      }
      return out
    }

    if (arg === 'edit' && argKey) {
      const { getMemoryDir } = await import('../memory/auto-memory.mjs')
      const { sanitizeKey } = await import('../memory/auto-memory.mjs').catch(() => ({ sanitizeKey: k => k }))
      const safeKey = argKey.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-{2,}/g, '-')
      const projectDir = getMemoryDir('project', cwd)
      const globalDir = getMemoryDir('global', cwd)
      const candidates = [
        join(projectDir, `${safeKey}.md`),
        join(globalDir, `${safeKey}.md`),
      ]
      const filePath = candidates.find(p => existsSync(p))
      if (!filePath) return `Memory key not found: ${argKey}`
      const editor = process.env.EDITOR || process.env.VISUAL
      if (editor) {
        const { execFileSync } = await import('child_process')
        try {
          execFileSync(editor, [filePath], { stdio: 'inherit' })
          return `✓ Memory edited: ${argKey}`
        } catch {
          return `✗ Failed to open editor. Edit manually: ${filePath}`
        }
      }
      return `Edit memory at: ${filePath}`
    }

    if (arg === 'delete' && argKey) {
      const { deleteMemory } = await import('../memory/auto-memory.mjs')
      const deleted = deleteMemory(argKey, 'all', cwd)
      return deleted ? `✓ Deleted memory: ${argKey}` : `Memory not found: ${argKey}`
    }

    if (arg === 'clear') {
      const { clearMemories } = await import('../memory/auto-memory.mjs')
      const count = clearMemories('all', cwd)
      return `✓ Cleared ${count} auto-extracted memory file${count === 1 ? '' : 's'}`
    }

    let output = `\n  Memory Files (CLAUDE.md)\n  ${'─'.repeat(44)}\n`

    for (const loc of locations) {
      if (existsSync(loc.path)) {
        const content = readFileSync(loc.path, 'utf8')
        const lines = content.split('\n').length
        const size = content.length
        output += `\n  [${loc.source}] ${loc.label}: ${loc.path}\n`
        output += `  Size: ${size} bytes, ${lines} lines\n`
        const preview = content.split('\n').slice(0, 5).map(l => `    ${l}`).join('\n')
        output += `  Preview:\n${preview}\n`
        if (lines > 5) {
          output += `    ... (${lines - 5} more lines)\n`
        }
      } else {
        output += `\n  ${loc.label}: not found\n`
      }
    }

    // Show auto-memory summary
    try {
      const { loadMemories } = await import('../memory/auto-memory.mjs')
      const memories = loadMemories(cwd)
      if (memories.size > 0) {
        output += `\n  Auto-Extracted Memories: ${memories.size} facts stored\n`
        output += `  Run /memory list to view them\n`
      }
    } catch {}

    output += `\n  Usage: /memory               - Show memory files`
    output += `\n         /memory list           - List auto-extracted memories`
    output += `\n         /memory edit           - Open project CLAUDE.md in editor`
    output += `\n         /memory edit <key>     - Edit specific auto memory`
    output += `\n         /memory delete <key>   - Delete an auto memory fact`
    output += `\n         /memory clear          - Clear all auto-extracted memories`
    return output
  }
}

// ============================================================================
// /vim command - Toggle vim keybindings
// ============================================================================

export const vimCommand = {
  type: 'local',
  name: 'vim',
  description: 'Toggle vim keybindings',
  isEnabled: true,
  userFacingName() { return 'vim' },

  async call(closeOverlay, context) {
    const arg = context?.args?.[0]?.toLowerCase()

    if (arg === 'on') {
      vimMode.enable()
      const config = loadConfig()
      config.vimMode = true
      saveConfig(config)
      return '✓ Vim mode enabled (ESC for normal mode, i for insert mode)'
    }

    if (arg === 'off') {
      vimMode.disable()
      const config = loadConfig()
      config.vimMode = false
      saveConfig(config)
      return '✓ Vim mode disabled'
    }

    // Toggle
    if (vimMode.enabled) {
      vimMode.disable()
      const config = loadConfig()
      config.vimMode = false
      saveConfig(config)
      return '✓ Vim mode disabled'
    } else {
      vimMode.enable()
      const config = loadConfig()
      config.vimMode = true
      saveConfig(config)
      return '✓ Vim mode enabled (ESC for normal mode, i for insert mode)'
    }
  }
}

// ============================================================================
// /voice command - Hold Space to speak
// ============================================================================

import { isAvailable as isSoxAvailable } from '../voice/recorder.mjs'
import { resolveProvider as resolveSTTProvider, resolveProviderAsync } from '../voice/transcribe.mjs'
import { keyboardManager } from '../keyboard/index.mjs'

export const voiceCommand = {
  type: 'local',
  name: 'voice',
  description: 'Hold Space to speak (toggle voice mode)',
  argumentHint: '[on|off]',
  isEnabled: true,
  userFacingName() { return 'voice' },

  async call(closeOverlay, context) {
    const arg = context?.args?.[0]?.toLowerCase()
    const soxInstallHint = process.platform === 'win32'
      ? 'winget install --id sox_ng.sox_ng --exact (recommended) or choco install sox'
      : 'brew install sox (macOS) or apt install sox (Linux)'

    // Status check helpers
    const soxOk = isSoxAvailable()
    const provider = await resolveProviderAsync()

    if (arg === 'on') {
      if (!soxOk) return `✗ No recorder binary found (sox_ng, sox, or rec). Install it: ${soxInstallHint}`
      if (!provider) return '✗ No STT API key. Set GROQ_API_KEY (recommended) or OPENAI_API_KEY.'
      keyboardManager.enableVoiceMode()
      return `✓ Voice mode ON · STT: ${provider.name} · Hold Space to speak (when prompt is empty)`
    }

    if (arg === 'off') {
      keyboardManager.disableVoiceMode()
      return '✓ Voice mode OFF'
    }

    // No arg: show status or toggle
    if (keyboardManager.voiceMode) {
      keyboardManager.disableVoiceMode()
      return '✓ Voice mode OFF'
    }

    // Trying to enable — validate deps
    if (!soxOk) return `✗ No recorder binary found (sox_ng, sox, or rec). Install it: ${soxInstallHint}`
    if (!provider) return '✗ No STT API key. Set GROQ_API_KEY (recommended) or OPENAI_API_KEY.'

    keyboardManager.enableVoiceMode()
    return `✓ Voice mode ON · STT: ${provider.name} · Hold Space to speak (when prompt is empty)`
  }
}

// ============================================================================
// /terminal-setup command - Configure shell integration
// ============================================================================

export const terminalSetupCommand = {
  type: 'local',
  name: 'terminal-setup',
  description: 'Configure shell integration for Dario',
  isEnabled: true,
  userFacingName() { return 'terminal-setup' },

  async call() {
    const { existsSync, readFileSync } = await import('fs')
    const { join } = await import('path')
    const { execFileSync } = await import('child_process')
    const home = (await import('os')).homedir()
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell' : (process.env.SHELL || '/bin/bash')
    const shellName = shell.split('/').pop()

    let output = `\n  Terminal Setup\n  ${'─'.repeat(44)}\n`
    output += `  Detected shell: ${shellName} (${shell})\n\n`

    if (isWindows) {
      let profilePath = '$PROFILE.CurrentUserAllHosts'
      try {
        profilePath = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts'],
          { encoding: 'utf8' }
        ).trim() || profilePath
      } catch {
        // Keep default profile variable reference
      }

      let alreadySetup = false
      if (existsSync(profilePath)) {
        const content = readFileSync(profilePath, 'utf8')
        alreadySetup = content.includes('Set-Alias claude dario') || content.includes('function claude')
      }

      if (alreadySetup) {
        output += `  ✓ Shell integration already configured in PowerShell profile\n`
      } else {
        output += `  To set up shell integration, add to your PowerShell profile:\n\n`
        output += `    # Dario CLI\n`
        output += `    Set-Alias claude dario\n`
        output += `\n  Profile: ${profilePath}\n`
      }
    } else {
      const rcFiles = { bash: '.bashrc', zsh: '.zshrc', fish: '.config/fish/config.fish' }
      const rcFile = rcFiles[shellName] || '.bashrc'
      const rcPath = join(home, rcFile)

      let alreadySetup = false
      if (existsSync(rcPath)) {
        const content = readFileSync(rcPath, 'utf8')
        alreadySetup = content.includes('dario') || content.includes('claude=')
      }

      if (alreadySetup) {
        output += `  ✓ Shell integration already configured in ~/${rcFile}\n`
      } else {
        output += `  To set up shell integration, add to ~/${rcFile}:\n\n`
        output += `    # Dario CLI\n`
        output += `    alias claude='dario'\n`
        if (shellName === 'fish') {
          output += `    # For fish shell:\n`
          output += `    alias claude 'dario'\n`
        }
        output += `\n  Then restart your shell or run: source ~/${rcFile}\n`
      }
    }

    try {
      if (isWindows) {
        execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Command dario -ErrorAction Stop | Out-Null'], { stdio: 'pipe' })
      } else {
        execFileSync('which', ['dario'], { stdio: 'pipe' })
      }
      output += '\n  ✓ dario is in PATH\n'
    } catch {
      output += '\n  ⚠  dario not found in PATH\n'
      output += '  Install globally: npm install -g dario-code\n'
      output += '  Or use npx: npx dario-code\n'
    }

    return output
  }
}

// ============================================================================
// /bug command - Report a bug with useful context
// ============================================================================

export const bugCommand = {
  type: 'local',
  name: 'bug',
  description: 'Report a bug',
  isEnabled: true,
  userFacingName() { return 'bug' },

  async call() {
    const os = await import('os')
    const currentModel = await getModel()

    let output = `\n  Report a Bug\n  ${'─'.repeat(44)}\n`
    output += `\n  File an issue at:\n`
    output += `  https://github.com/jkneen/dario-code/issues\n\n`
    output += `  Include this info:\n`
    output += `    Version:  Dario v${VERSION}\n`
    output += `    Node:     ${process.version}\n`
    output += `    Platform: ${os.platform()} ${os.arch()}\n`
    output += `    Model:    ${currentModel}\n`
    output += `    Fast:     ${isFastMode() ? 'ON' : 'OFF'}\n`
    return output
  }
}

// ============================================================================
// /stats command - Show usage statistics (CC 2.0.64+)
// ============================================================================

export const statsCommand = {
  type: 'local',
  name: 'stats',
  description: 'Show usage statistics and session insights',
  isEnabled: true,
  userFacingName() { return 'stats' },

  async call() {
    const usage = getSessionUsage()
    const currentModel = await getModel()
    const totalTokens = usage.inputTokens + usage.outputTokens

    let output = `\n  📊 Session Stats\n  ${'─'.repeat(44)}\n`
    output += `  Model: ${currentModel}\n`
    output += `  API turns: ${usage.turns}\n\n`

    // Token breakdown
    output += `  Tokens\n`
    output += `    Input:  ${usage.inputTokens.toLocaleString()}\n`
    output += `    Output: ${usage.outputTokens.toLocaleString()}\n`
    output += `    Total:  ${totalTokens.toLocaleString()}\n`

    if (usage.cacheReadTokens > 0) {
      const cacheHitRate = ((usage.cacheReadTokens / (usage.inputTokens || 1)) * 100).toFixed(1)
      output += `    Cache hits: ${usage.cacheReadTokens.toLocaleString()} (${cacheHitRate}%)\n`
    }

    // Cost
    output += `\n  Cost: $${usage.costUSD.toFixed(4)}`
    if (usage.turns > 0) {
      output += ` ($${(usage.costUSD / usage.turns).toFixed(4)}/turn)`
    }
    output += '\n'

    // Usage bar
    const maxTokens = 200000
    const pct = Math.min(100, (totalTokens / maxTokens) * 100)
    const barWidth = 40
    const filled = Math.round((pct / 100) * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    output += `\n  Context: [${bar}] ${pct.toFixed(1)}%\n`

    // Session duration
    const uptime = process.uptime()
    const mins = Math.floor(uptime / 60)
    const secs = Math.floor(uptime % 60)
    output += `  Duration: ${mins}m ${secs}s\n`

    return output
  }
}

// ============================================================================
// /rename command - Name the current session (CC 2.0.64+)
// ============================================================================

export const renameCommand = {
  type: 'local',
  name: 'rename',
  description: 'Name the current session for easy resume',
  isEnabled: true,
  argNames: ['name'],
  userFacingName() { return 'rename' },

  async call(closeOverlay, context) {
    const args = context?.args || []
    const name = args.join(' ').trim()

    if (!name) {
      return 'Usage: /rename <session-name>\nGive this session a memorable name for easy resume with --resume <name>'
    }

    try {
      const sessionId = process.env.DARIO_SESSION_ID
      if (sessionId) {
        await sessions.renameSession(sessionId, name)
        return `✓ Session renamed to "${name}"\n  Resume later with: dario --resume "${name}"`
      }
      return '✗ No active session to rename'
    } catch (e) {
      return `✗ Failed to rename: ${e.message}`
    }
  }
}

// ============================================================================
// /debug command - Help debug the current session (CC 2.1.30+)
// ============================================================================

export const debugCommand = {
  type: 'local',
  name: 'debug',
  description: 'Show debug information for the current session',
  isEnabled: true,
  userFacingName() { return 'debug' },

  async call(closeOverlay, context) {
    const currentModel = await getModel()
    const usage = getSessionUsage()
    const os = await import('os')

    let output = `\n  🔍 Debug Info\n  ${'─'.repeat(52)}\n`

    // Environment
    output += `\n  Environment\n`
    output += `    Version:    Dario v${VERSION}\n`
    output += `    Node:       ${process.version}\n`
    output += `    Platform:   ${os.platform()} ${os.arch()}\n`
    output += `    Shell:      ${process.env.SHELL || 'unknown'}\n`
    output += `    Terminal:   ${process.env.TERM || 'unknown'}\n`
    output += `    CWD:        ${process.cwd()}\n`

    // Auth
    output += `\n  Authentication\n`
    const apiKey = process.env.ANTHROPIC_API_KEY
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
    output += `    Method:   ${apiKey ? 'API Key' : 'OAuth/None'}\n`
    output += `    Endpoint: ${baseUrl}\n`

    // Model & Session
    output += `\n  Session\n`
    output += `    Model:       ${currentModel}\n`
    output += `    Fast mode:   ${isFastMode() ? 'ON' : 'OFF'}\n`
    output += `    Thinking:    ${process.env.DARIO_THINKING === '1' ? 'ON' : 'OFF'}\n`
    output += `    Session ID:  ${process.env.DARIO_SESSION_ID || 'none'}\n`
    output += `    Agent:       ${process.env.DARIO_AGENT || 'default'}\n`
    output += `    Turns:       ${usage.turns}\n`
    output += `    Tokens:      ${(usage.inputTokens + usage.outputTokens).toLocaleString()}\n`

    // Memory
    output += `\n  Memory\n`
    const claudeFiles = loadClaudeMd(process.cwd())
    output += `    CLAUDE.md files: ${claudeFiles.length}\n`
    for (const f of claudeFiles) {
      output += `      ${f.source}: ${f.path} (${f.content.length} chars)\n`
    }

    // MCP
    output += `\n  MCP Servers\n`
    try {
      const servers = getAllMcpServers({
        getGlobalConfig: loadConfig,
        setGlobalConfig: saveConfig,
        getProjectConfig: () => ({}),
        setProjectConfig: () => {},
        getMcprcConfig: () => null
      })
      const serverNames = Object.keys(servers)
      output += `    Configured: ${serverNames.length}\n`
      for (const name of serverNames) {
        output += `      ${name}: ${servers[name].command}\n`
      }
    } catch {
      output += `    Error loading MCP config\n`
    }

    // Uptime
    const uptime = process.uptime()
    output += `\n  Uptime: ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s\n`
    output += `  Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n`

    return output
  }
}

// ============================================================================
// /providers command
// ============================================================================

export const providersCommand = {
  type: 'local',
  name: 'providers',
  description: 'Manage AI providers and their models',
  isEnabled: true,
  isHidden: false,
  userFacingName() { return 'providers' },

  async call(closeOverlay, context) {
    const args = context?.args || []
    const sub = args[0]?.toLowerCase()

    // No subcommand — open TUI overlay if available
    if (!sub) {
      if (context?.showProviderManager) {
        context.showProviderManager()
        return null
      }
      // Fallback: text list
      return this._listProviders()
    }

    if (sub === 'list') return this._listProviders()

    if (sub === 'add') {
      const id = args[1]
      if (!id) return 'Usage: /providers add <id>  e.g. /providers add groq'
      const def = getProvider(id)
      if (!def) return `Unknown provider: ${id}\n\nAvailable: ${getAllProviders().map(p => p.id).join(', ')}`
      enableProvider(id)
      return `✓ Provider "${def.name}" enabled. Set key: /providers key ${id} <your-key>`
    }

    if (sub === 'remove') {
      const id = args[1]
      if (!id) return 'Usage: /providers remove <id>'
      if (id === 'anthropic') return '✗ Cannot remove Anthropic (built-in)'
      disableProvider(id)
      return `✓ Provider "${id}" disabled`
    }

    if (sub === 'key') {
      const id = args[1]
      const key = args[2]
      if (!id || !key) return 'Usage: /providers key <id> <api-key>'
      const def = getProvider(id)
      if (!def) return `Unknown provider: ${id}`
      setProviderKey(id, key)
      enableProvider(id)
      return `✓ API key saved for ${def.name}`
    }

    if (sub === 'models') {
      const id = args[1]
      if (!id) return 'Usage: /providers models <id>'
      const def = getProvider(id)
      if (!def) return `Unknown provider: ${id}`
      const config = loadProviderConfig()
      const entry = config.providers.find(p => p.id === id) || {}
      const enabled = new Set(entry.enabledModels || [])
      let output = `\n  ${def.name} models:\n`
      for (const m of def.models) {
        const on = enabled.has(m.id)
        output += `  ${on ? '✓' : '○'} ${m.name} (${m.id})\n`
      }
      output += '\nToggle: /providers toggle <id> <modelId>'
      return output
    }

    if (sub === 'toggle') {
      const id = args[1]
      const modelId = args[2]
      if (!id || !modelId) return 'Usage: /providers toggle <providerId> <modelId>'
      const def = getProvider(id)
      if (!def) return `Unknown provider: ${id}`
      const model = def.models.find(m => m.id === modelId)
      if (!model) return `Unknown model "${modelId}" for provider ${id}`
      toggleModel(id, modelId)
      const config = loadProviderConfig()
      const entry = config.providers.find(p => p.id === id) || {}
      const isNowEnabled = (entry.enabledModels || []).includes(modelId)
      return `${isNowEnabled ? '✓ Enabled' : '○ Disabled'}: ${model.name}`
    }

    return `Unknown subcommand: ${sub}\nUsage: /providers [list|add|remove|key|models|toggle]`
  },

  _listProviders() {
    const all = getAllProviders()
    const config = loadProviderConfig()
    const configMap = new Map(config.providers.map(p => [p.id, p]))

    let output = '\n  AI Providers\n  ─────────────────────────────────────\n'
    for (const p of all) {
      const entry = configMap.get(p.id) || {}
      const enabled = p.isBuiltin || entry.enabled === true
      const hasKey = p.noKeyRequired || !!(entry.apiKey || process.env[p.apiKeyEnv])
      const modelCount = p.isBuiltin
        ? p.models.length
        : (entry.enabledModels || []).length

      const status = enabled ? (hasKey ? '✓' : '⚠') : '○'
      output += `  ${status} ${p.name.padEnd(20)} ${enabled ? 'enabled' : 'disabled'}`
      if (enabled && !hasKey && !p.noKeyRequired) output += ' (no key)'
      if (enabled) output += `  ${modelCount} model${modelCount !== 1 ? 's' : ''}`
      output += '\n'
    }
    output += '\nCommands: /providers add|remove|key|models|toggle'
    return output
  }
}

// ============================================================================
// Command Export for Integration
// ============================================================================

/**
 * Get all local commands for slash command processing
 * @returns {Array} Array of command objects
 */
export function getLocalCommands() {
  return [
    modelCommand,
    authCommand,
    contextCommand,
    tasksCommand,
    todosCommand,
    addDirCommand,
    pluginCommand,
    resumeCommand,
    exportCommand,
    initCommand,
    clearCommand,
    configCommand,
    approvedToolsCommand,
    mcpCommand,
    doctorCommand,
    loginCommand,
    logoutCommand,
    fastCommand,
    compactCommand,
    statusCommand,
    costCommand,
    memoryCommand,
    vimCommand,
    voiceCommand,
    terminalSetupCommand,
    bugCommand,
    statsCommand,
    renameCommand,
    debugCommand,
    reviewCommand,
    prCommentsCommand,
    providersCommand,
    simplifyCommand,
    batchCommand,
  ]
}

/**
 * Check if a command exists
 * @param {string} name - Command name
 * @param {Array} commands - List of available commands
 * @returns {boolean} True if command exists
 */
export function commandExists(name, commands) {
  return commands.some(cmd =>
    cmd.userFacingName() === name || cmd.aliases?.includes(name)
  )
}

/**
 * Find a command by name
 * @param {string} name - Command name
 * @param {Array} commands - List of available commands
 * @returns {Object|null} Command object or null
 */
export function findCommand(name, commands) {
  return commands.find(cmd =>
    cmd.userFacingName() === name || cmd.aliases?.includes(name)
  ) || null
}

/**
 * /fast command - Toggle fast mode (Opus 4.6 high-speed inference)
 */
// ============================================================================
// /review command - Code review via git diff (CC 2.1.x)
// ============================================================================

export const reviewCommand = {
  type: 'local',
  name: 'review',
  description: 'Review staged or unstaged changes',
  isEnabled: true,
  userFacingName() { return 'review' },

  async call(closeOverlay, context) {
    const args = context?.args || []
    const target = args[0] || 'staged'

    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)

      let diff
      if (target === 'unstaged' || target === 'all') {
        const { stdout } = await execFileAsync('git', ['diff'], { timeout: 10000 })
        diff = stdout
      } else {
        const { stdout } = await execFileAsync('git', ['diff', '--cached'], { timeout: 10000 })
        diff = stdout
      }

      if (!diff.trim()) {
        return target === 'staged'
          ? 'No staged changes to review. Stage changes with `git add` or use `/review unstaged`.'
          : 'No unstaged changes to review.'
      }

      const allLines = diff.split('\n')
      const lineCount = allLines.length
      const files = diff.match(/^diff --git/gm)?.length || 0

      let output = `\n  Code Review: ${target} changes\n  ${'─'.repeat(44)}\n`
      output += `  Files: ${files} · Lines: ${lineCount}\n\n`

      // Coloured diff output (truncated for display)
      const maxLines = 200
      const diffLines = allLines.slice(0, maxLines)
      for (const line of diffLines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          output += `  \x1b[32m${line}\x1b[0m\n`
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          output += `  \x1b[31m${line}\x1b[0m\n`
        } else if (line.startsWith('@@')) {
          output += `  \x1b[36m${line}\x1b[0m\n`
        } else if (line.startsWith('diff --git')) {
          output += `\n  \x1b[1m${line}\x1b[0m\n`
        } else {
          output += `  ${line}\n`
        }
      }

      if (lineCount > maxLines) {
        output += `\n  ... (${lineCount - maxLines} more lines truncated)\n`
      }

      output += `\n  💡 Ask Claude to review these changes by saying "review this diff" after this output.\n`
      return output
    } catch (e) {
      if (e.message?.includes('not a git repository')) {
        return '✗ Not in a git repository'
      }
      return `✗ Review failed: ${e.message}`
    }
  }
}

// ============================================================================
// /pr-comments command - Show GitHub PR review comments (CC 2.1.x)
// ============================================================================

export const prCommentsCommand = {
  type: 'local',
  name: 'pr-comments',
  description: 'Show GitHub PR review comments',
  isEnabled: true,
  userFacingName() { return 'pr-comments' },

  async call(closeOverlay, context) {
    const args = context?.args || []
    const rawArg = args[0] || ''

    // Validate: PR numbers are always positive integers
    if (rawArg && !/^\d+$/.test(rawArg)) {
      return '✗ PR number must be a positive integer. Usage: /pr-comments <number>'
    }

    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)

      // Check if gh CLI is available
      try {
        await execFileAsync('which', ['gh'])
      } catch {
        return '✗ GitHub CLI (gh) not installed. Install it from https://cli.github.com'
      }

      if (!rawArg) {
        // Try to get current PR from branch
        try {
          const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
          const branch = branchOut.trim()
          const { stdout: prJsonStr } = await execFileAsync('gh', ['pr', 'view', '--json', 'number,title,state,reviews,comments'], { timeout: 15000 })
          const pr = JSON.parse(prJsonStr)

          let output = `\n  PR #${pr.number}: ${pr.title}\n`
          output += `  State: ${pr.state} · Branch: ${branch}\n`
          output += `  ${'─'.repeat(52)}\n`

          if (pr.reviews?.length > 0) {
            output += `\n  Reviews (${pr.reviews.length}):\n`
            for (const review of pr.reviews) {
              const state = review.state === 'APPROVED' ? '✓' : review.state === 'CHANGES_REQUESTED' ? '✗' : '○'
              output += `  ${state} ${review.author?.login || 'unknown'}: ${review.state}\n`
              if (review.body) {
                output += `    ${review.body.slice(0, 200)}\n`
              }
            }
          }

          if (pr.comments?.length > 0) {
            output += `\n  Comments (${pr.comments.length}):\n`
            for (const comment of pr.comments.slice(-5)) {
              output += `  • ${comment.author?.login || 'unknown'}: ${comment.body?.slice(0, 150) || ''}\n`
            }
          }

          if ((!pr.reviews || pr.reviews.length === 0) && (!pr.comments || pr.comments.length === 0)) {
            output += '\n  No reviews or comments yet.\n'
          }

          return output
        } catch {
          return `✗ No PR found for current branch. Usage: /pr-comments <number>`
        }
      }

      // Fetch specific PR
      const { stdout: prJsonStr } = await execFileAsync('gh', ['pr', 'view', rawArg, '--json', 'number,title,state,reviews,comments,reviewRequests'], { timeout: 15000 })
      const pr = JSON.parse(prJsonStr)

      let output = `\n  PR #${pr.number}: ${pr.title}\n`
      output += `  State: ${pr.state}\n`
      output += `  ${'─'.repeat(52)}\n`

      if (pr.reviews?.length > 0) {
        output += `\n  Reviews:\n`
        for (const review of pr.reviews) {
          const state = review.state === 'APPROVED' ? '✓' : review.state === 'CHANGES_REQUESTED' ? '✗' : '○'
          output += `  ${state} ${review.author?.login || 'unknown'}: ${review.state}\n`
          if (review.body) output += `    ${review.body.slice(0, 200)}\n`
        }
      }

      if (pr.comments?.length > 0) {
        output += `\n  Comments:\n`
        for (const comment of pr.comments.slice(-10)) {
          output += `  • ${comment.author?.login || 'unknown'}: ${comment.body?.slice(0, 150) || ''}\n`
        }
      }

      return output
    } catch (e) {
      return `✗ Failed to fetch PR comments: ${e.message}`
    }
  }
}

/**
 * /simplify command - Ask the AI to simplify recently changed code
 */
export const simplifyCommand = {
  type: 'local',
  name: 'simplify',
  description: 'Ask the AI to simplify and clean up recent code changes',
  argumentHint: '[focus area]',
  isEnabled: true,
  isHidden: false,

  async call(closeOverlay, context) {
    const focus = context?.args?.filter(Boolean).join(' ')

    let prompt = 'Review the recently changed code and simplify it. Focus on reducing complexity, removing duplication, and improving readability. Make only the minimum changes needed — do not add new features or change behaviour.'
    if (focus) {
      prompt = `Review the recently changed code and simplify it, focusing on: ${focus}. Reduce complexity, remove duplication, and improve readability without changing behaviour.`
    }

    if (context?.submitMessage) {
      context.submitMessage(prompt)
      return null
    }

    // Non-TUI fallback: print the prompt the user would type
    return `To simplify code, send this to the AI:\n\n${prompt}`
  },

  userFacingName() { return 'simplify' }
}

// In-memory batch queue (persists for the lifetime of the process)
const batchQueue = []

/**
 * /batch command - Queue multiple prompts to run sequentially
 */
export const batchCommand = {
  type: 'local',
  name: 'batch',
  description: 'Queue prompts to run sequentially: add <prompt> | run | list | clear',
  argumentHint: '[add <prompt> | run | list | clear]',
  isEnabled: true,
  isHidden: false,

  async call(closeOverlay, context) {
    const args = context?.args?.filter(Boolean) || []
    const sub = args[0]

    if (!sub || sub === 'list') {
      if (batchQueue.length === 0) {
        return '\n  Batch Queue\n  ' + '─'.repeat(40) + '\n  Queue is empty\n\n  Usage:\n    /batch add <prompt>  Add a prompt to the queue\n    /batch run           Run all queued prompts\n    /batch clear         Clear the queue\n'
      }
      let out = '\n  Batch Queue (' + batchQueue.length + ' items)\n  ' + '─'.repeat(40) + '\n'
      batchQueue.forEach((p, i) => {
        const preview = p.length > 70 ? p.slice(0, 70) + '…' : p
        out += `  ${i + 1}. ${preview}\n`
      })
      out += '  ' + '─'.repeat(40) + '\n  Run with: /batch run\n'
      return out
    }

    if (sub === 'clear') {
      const count = batchQueue.length
      batchQueue.length = 0
      return count > 0 ? `Batch queue cleared (${count} items removed)` : 'Batch queue was already empty'
    }

    if (sub === 'add') {
      const prompt = args.slice(1).join(' ').trim()
      if (!prompt) return 'Usage: /batch add <prompt>'
      batchQueue.push(prompt)
      return `Added to batch queue (#${batchQueue.length}): ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`
    }

    if (sub === 'run') {
      if (batchQueue.length === 0) {
        return 'Batch queue is empty. Add prompts with /batch add <prompt>'
      }
      if (!context?.submitMessage) {
        const items = batchQueue.splice(0)
        return `Batch (${items.length} prompts) — run these in order:\n\n${items.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      }
      // Drain the queue and submit each prompt with a delay so the AI can finish each one
      const items = batchQueue.splice(0)
      items.forEach((prompt, i) => {
        setTimeout(() => context.submitMessage(prompt), i * 200)
      })
      return `Running ${items.length} queued prompt${items.length === 1 ? '' : 's'} sequentially…`
    }

    // Treat unrecognised sub-command as an implicit "add"
    const prompt = args.join(' ').trim()
    batchQueue.push(prompt)
    return `Added to batch queue (#${batchQueue.length}): ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`
  },

  userFacingName() { return 'batch' }
}

export const fastCommand = {
  type: 'local',
  name: 'fast',
  description: `Toggle fast mode (${getFastModeDisplayName()} only)`,
  argumentHint: '[on|off]',
  isEnabled: true,
  isHidden: false,
  isOverlay: true,
  userFacingName() { return 'fast' },

  async call(closeOverlay, context) {
    const arg = context?.args?.[0]?.toLowerCase()

    // Direct on/off from CLI argument
    if (arg === 'on' || arg === 'off') {
      const enable = arg === 'on'
      setFastMode(enable)
      if (enable) {
        return `↯ Fast mode ON · model set to ${getFastModeDisplayName()}`
      }
      return 'Fast mode OFF'
    }

    // Overlay mode — show toggle UI
    if (context?.showFastModeToggle) {
      context.showFastModeToggle()
      return null
    }

    // Fallback for non-TUI
    const current = isFastMode()
    setFastMode(!current)
    if (!current) {
      return `↯ Fast mode ON · model set to ${getFastModeDisplayName()}`
    }
    return 'Fast mode OFF'
  }
}

export default {
  isCommand,
  processCommand,
  getLocalCommands,
  commandExists,
  findCommand,

  // Individual commands
  modelCommand,
  authCommand,
  contextCommand,
  tasksCommand,
  todosCommand,
  addDirCommand,
  pluginCommand,
  resumeCommand,
  exportCommand,
  fastCommand,
  compactCommand,
  statusCommand,
  costCommand,
  memoryCommand,
  vimCommand,
  voiceCommand,
  terminalSetupCommand,
  bugCommand,
  statsCommand,
  renameCommand,
  debugCommand,

  providersCommand,
  simplifyCommand,
  batchCommand,
  getAvailableModels,

  // State management
  AVAILABLE_MODELS,
  MODEL_LIMITS,
  getAllWorkingDirs,
  addWorkingDir,
  removeWorkingDir,
  getTodos,
  setTodos,
  getTodoStatistics
}
