#!/usr/bin/env node

/**
 * Dario Code TUI - Main conversation interface
 */

import React, { useState, useCallback, useEffect, useMemo, useRef, memo, Component } from 'react'
import { Box, Text, render, useInput, useStdout } from 'ink'
import { randomUUID } from 'crypto'
import chalk from 'chalk'

// Our modules
import { createMessage, normalizeMessages, getLastMessage } from '../../utils/messages.mjs'
import { streamConversation } from '../../api/streaming.mjs'
import { getAllTools } from '../../tools/index.mjs'
import { formatError } from '../../utils/errors.mjs'
import { loadConfig, saveConfig, VERSION, isFastMode, setFastMode, getFastModeModel, getFastModeDisplayName, modelSupportsFastMode, getCompactThreshold } from '../../core/config.mjs'
import { runHooks } from '../../core/hooks.mjs'
import { getLocalCommands, processCommand as execCommand, getAvailableModels } from '../../cli/commands.mjs'
import { getAllProviders } from '../../providers/registry.mjs'
import { glob } from 'glob'
import { basename, relative, join } from 'path'
import path from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { authenticateWithOAuth, getAuthInfo, logout as oauthLogout, getValidToken, setOAuthMode } from '../../auth/oauth.mjs'
import { resetClient } from '../../api/client.mjs'
import { getSystemPromptIntro, getSystemInstructions } from '../../prompts/system.mjs'
import { renderMarkdown } from './components/markdown.mjs'
import { generateDiff } from '../../utils/diff.mjs'
import { FastModeToggle } from './components/fast-mode-toggle.mjs'
import { PromptFooter } from './components/prompt-footer.mjs'
import { McpManager } from './components/mcp-manager.mjs'
import { ConfigManager } from './components/config-manager.mjs'
import { ApprovedToolsManager } from './components/approved-tools-manager.mjs'
import { SessionPicker } from './components/session-picker.mjs'
import { PluginManager } from './components/plugin-manager.mjs'
import { AgentManager } from './components/agent-manager.mjs'
import { ProviderManager } from './components/provider-manager.mjs'
import { ToolsManager } from './components/tools-manager.mjs'
import { ContextManager } from './components/context-manager.mjs'
import { SteeringQuestions } from './components/steering-questions.mjs'
import { addMcpServer, removeMcpServer, getAllMcpServers, connectToMcpServer, updateServerStartupMode } from '../../integration/mcp.mjs'
import {
  getRegisteredPlugins,
  getPluginStatus,
  loadPluginManifest,
  enablePlugin as registryEnablePlugin,
  disablePlugin as registryDisablePlugin,
} from '../../plugins/registry.mjs'
import { installFromNpm, installFromLocal, uninstallPlugin } from '../../plugins/installer.mjs'
import { isBundledPlugin, getSamplePluginPath } from '../../plugins/discovery.mjs'
import { deleteCustomAgent } from '../../agents/subagent.mjs'
import { loadSettings, saveSettings, getDisabledContextItems, toggleContextItem, isContextItemDisabled, getCustomContextItems, addCustomContextItem, removeCustomContextItem } from '../../core/config.mjs'
import { getTotalContextTokens } from '../../utils/tokens.mjs'
import * as sessions from '../../sessions/index.mjs'
import { onPlanApproved, onPlanExit, approvePlan, cancelPlan } from '../../plan/plan.mjs'
import { startSkillsHotReload, stopSkillsHotReload, onSkillsChanged, invalidateSkillsCache } from '../../tools/skills-discovery.mjs'
import { VoiceSession } from '../../voice/index.mjs'
import { keyboardManager } from '../../keyboard/index.mjs'

/**
 * Error Boundary - Catches React errors and displays them gracefully
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[TUI Error]', error)
    console.error('[Error Info]', errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return React.createElement(Box, { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { color: 'red', bold: true }, '✗ UI Error'),
        React.createElement(Text, null, this.state.error?.message || 'Unknown error'),
        React.createElement(Text, { color: 'gray', dimColor: true }, '\nPress Ctrl+C to exit')
      )
    }

    return this.props.children
  }
}

/**
 * Load custom commands from ~/.dario/commands/*.md and ~/.claude/commands/*.md
 * Items from .dario take priority. Each item is tagged with `source`.
 */
function loadCustomCommands() {
  const customCommands = []
  const seen = new Set()

  // Scan dirs in priority order: dario first, then claude
  const commandsDirs = [
    { dir: join(homedir(), '.dario', 'commands'), source: 'dario' },
    { dir: join(homedir(), '.claude', 'commands'), source: 'claude' },
  ]

  for (const { dir: commandsDir, source } of commandsDirs) {
    if (!existsSync(commandsDir)) continue

    try {
      const files = readdirSync(commandsDir)
      for (const file of files) {
        if (!file.endsWith('.md') || file.startsWith('.')) continue

        const name = file.replace('.md', '')

        // If already loaded from higher-priority dir, mark as 'both'
        if (seen.has(name)) {
          const existing = customCommands.find(c => c.name === name)
          if (existing) existing.source = 'both'
          continue
        }
        seen.add(name)

        const filePath = join(commandsDir, file)

        // Read first line for description
        let description = ''
        try {
          const content = readFileSync(filePath, 'utf8')
          const firstLine = content.split('\n')[0]
          // Extract description from # heading or first line
          if (firstLine.startsWith('#')) {
            description = firstLine.replace(/^#+\s*/, '').trim()
          } else {
            description = firstLine.trim().slice(0, 60)
          }
        } catch (e) {
          description = `Custom command: ${name}`
        }

        customCommands.push({
          name,
          description,
          source,
          isEnabled: true,
          isCustom: true,
          filePath,
          userFacingName() { return name },
          async call() {
            try {
              const content = readFileSync(filePath, 'utf8')
              return `Running custom command: ${name}\n\n${content}`
            } catch (e) {
              return `Error loading command ${name}: ${e.message}`
            }
          }
        })
      }
    } catch (e) {
      console.error('[CustomCommands] Failed to load from', commandsDir, ':', e.message)
    }
  }

  return customCommands
}

/**
 * Message Selector - Select a message to fork conversation from
 */
function MessageSelector({ messages, onSelect, onCancel }) {
  const userMessages = messages.filter(m => m.type === 'user')
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, userMessages.length - 1))

  useInput((char, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(userMessages.length - 1, i + 1))
      return
    }
    if (key.return) {
      const selectedMessage = userMessages[selectedIndex]
      // Find this message's index in the full messages array
      const fullIndex = messages.findIndex(m => m.uuid === selectedMessage.uuid)
      onSelect(fullIndex)
      return
    }
  })

  if (userMessages.length === 0) {
    return React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: THEME.claude,
      padding: 1,
      marginTop: 1
    },
      React.createElement(Text, { key: 'title', bold: true, color: THEME.claude }, '⏺ Fork Conversation'),
      React.createElement(Text, { key: 'message' }, 'No messages to fork from'),
      React.createElement(Text, { key: 'help', dimColor: true, marginTop: 1 }, 'Press Escape to cancel')
    )
  }

  return React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: THEME.claude,
    padding: 1,
    marginTop: 1
  },
    React.createElement(Text, { key: 'title', bold: true, color: THEME.claude }, '⏺ Fork Conversation'),
    React.createElement(Text, { key: 'subtitle', dimColor: true }, 'Select a message to fork from:'),
    React.createElement(Box, { key: 'spacer1', marginTop: 1 }),
    React.createElement(Box, { key: 'messages', flexDirection: 'column' },
      userMessages.map((msg, idx) => {
        const isSelected = idx === selectedIndex
        const preview = (msg.content || msg.message?.content?.[0]?.text || 'Empty message')
          .split('\n')[0]
          .slice(0, 60)
        const truncated = preview.length === 60 ? preview + '...' : preview

        return React.createElement(Box, {
          key: msg.uuid || idx,
          flexDirection: 'column',
          marginBottom: idx < userMessages.length - 1 ? 1 : 0
        },
          React.createElement(Text, {
            color: isSelected ? THEME.suggestion : undefined,
            inverse: isSelected,
          },
            isSelected ? ' → ' : '   ',
            `Message ${idx + 1}`
          ),
          React.createElement(Text, {
            dimColor: !isSelected,
            color: isSelected ? THEME.suggestion : undefined
          }, '     ', truncated)
        )
      })
    ),
    React.createElement(Box, { key: 'spacer2', marginTop: 1 }),
    React.createElement(Text, { key: 'help', dimColor: true }, '↑↓ Navigate · Enter to fork · Escape to cancel')
  )
}

/**
 * Interactive Model Selector Overlay
 * Tabbed by provider to mirror other settings/question interfaces.
 */
function ModelSelector({ currentModel, onSelect, onCancel }) {
  const allModels = useMemo(() => getAvailableModels(), [])

  const providerNameMap = useMemo(() => {
    const map = new Map([['anthropic', 'Anthropic']])
    for (const provider of getAllProviders()) {
      map.set(provider.id, provider.name)
    }
    return map
  }, [])

  const modelsByProvider = useMemo(() => {
    const map = new Map()
    for (const model of allModels) {
      const providerId = model.provider || 'anthropic'
      if (!map.has(providerId)) map.set(providerId, [])
      map.get(providerId).push(model)
    }
    return map
  }, [allModels])

  const providers = useMemo(() => Array.from(modelsByProvider.keys()), [modelsByProvider])

  const [activeProvider, setActiveProvider] = useState(() => {
    const current = allModels.find(m => m.id === currentModel)
    return current?.provider || providers[0] || 'anthropic'
  })
  const [selectedModelId, setSelectedModelId] = useState(currentModel)

  useEffect(() => {
    if (providers.length > 0 && !providers.includes(activeProvider)) {
      setActiveProvider(providers[0])
    }
  }, [providers, activeProvider])

  const filteredModels = modelsByProvider.get(activeProvider) || []

  useEffect(() => {
    if (filteredModels.length === 0) return
    if (filteredModels.some(m => m.id === selectedModelId)) return

    const currentInTab = filteredModels.find(m => m.id === currentModel)
    setSelectedModelId(currentInTab?.id || filteredModels[0].id)
  }, [filteredModels, selectedModelId, currentModel])

  const selectedIndex = Math.max(0, filteredModels.findIndex(m => m.id === selectedModelId))
  const selectedModel = filteredModels[selectedIndex] || filteredModels[0] || null

  const providerLabel = useCallback((providerId) => {
    if (!providerId) return 'Unknown'
    return providerNameMap.get(providerId) || `${providerId[0].toUpperCase()}${providerId.slice(1)}`
  }, [providerNameMap])

  const cycleProvider = useCallback((direction) => {
    if (providers.length <= 1) return

    const idx = Math.max(0, providers.indexOf(activeProvider))
    const nextIdx = (idx + direction + providers.length) % providers.length
    const nextProvider = providers[nextIdx]
    setActiveProvider(nextProvider)

    const nextModels = modelsByProvider.get(nextProvider) || []
    if (nextModels.length === 0) return

    if (!nextModels.some(m => m.id === selectedModelId)) {
      const currentInNext = nextModels.find(m => m.id === currentModel)
      setSelectedModelId(currentInNext?.id || nextModels[0].id)
    }
  }, [providers, activeProvider, modelsByProvider, selectedModelId, currentModel])

  useInput((char, key) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (key.leftArrow || (key.shift && key.tab)) {
      cycleProvider(-1)
      return
    }

    if (key.rightArrow || key.tab) {
      cycleProvider(1)
      return
    }

    if (key.upArrow) {
      if (selectedIndex > 0) {
        setSelectedModelId(filteredModels[selectedIndex - 1].id)
      }
      return
    }

    if (key.downArrow) {
      if (selectedIndex < filteredModels.length - 1) {
        setSelectedModelId(filteredModels[selectedIndex + 1].id)
      }
      return
    }

    if (key.return && selectedModel) {
      onSelect(selectedModel)
    }
  })

  return React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: THEME.claude,
    padding: 1,
    marginTop: 1,
  },
    React.createElement(Text, { key: 'title', bold: true, color: THEME.claude }, '⏺ Select Model'),
    React.createElement(Text, { key: 'current', dimColor: true }, 'Current: ', currentModel),

    React.createElement(Box, { key: 'tabs', flexDirection: 'row', marginTop: 1 },
      ...providers.map((providerId) => {
        const isActive = providerId === activeProvider
        const modelCount = (modelsByProvider.get(providerId) || []).length
        return React.createElement(Text, {
          key: `provider-tab-${providerId}`,
          bold: isActive,
          color: isActive ? THEME.text : THEME.secondaryText,
          inverse: isActive,
        }, ` ${providerLabel(providerId)} (${modelCount}) `, React.createElement(Text, { color: THEME.secondaryText }, '  '))
      })
    ),

    React.createElement(Box, { key: 'models', flexDirection: 'column', marginTop: 1 },
      filteredModels.length === 0
        ? React.createElement(Text, { key: 'none', color: THEME.secondaryText }, '  No models enabled for this provider')
        : filteredModels.map((model) => {
            const isSelected = model.id === selectedModel?.id
            const isCurrent = model.id === currentModel
            return React.createElement(Box, {
              key: model.id,
              flexDirection: 'column',
              marginBottom: 0,
            },
              React.createElement(Text, {
                color: isSelected ? THEME.suggestion : (isCurrent ? THEME.success : undefined),
                inverse: isSelected,
                bold: isCurrent,
              },
                isSelected ? ' → ' : '   ',
                model.name,
                isCurrent ? ' [current]' : ''
              ),
              React.createElement(Text, {
                dimColor: !isSelected,
                color: isSelected ? THEME.suggestion : THEME.secondaryText,
              }, `     ${model.id}${model.description ? ` · ${model.description}` : ''}`)
            )
          })
    ),

    React.createElement(Box, { key: 'help', marginTop: 1 },
      React.createElement(Text, { dimColor: true }, '↑↓ models · ←→/Tab providers · Enter select · Esc cancel')
    )
  )
}

// OAuth options for AuthSelector
const AUTH_OPTIONS = [
  {
    id: 'claude',
    name: 'Claude Max/Pro',
    description: 'Use your Claude Max ($100/mo) or Pro ($20/mo) subscription for unlimited usage',
    icon: '🌟'
  },
  {
    id: 'anthropic',
    name: 'Console OAuth',
    description: 'Billed based on API usage through your Console account',
    icon: '🔑'
  }
]

/**
 * Interactive Auth Selector Overlay
 * Shows when /login is called - lets user choose between auth methods
 */
function AuthSelector({ onSelect, onCancel }) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useInput((char, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(AUTH_OPTIONS.length - 1, i + 1))
      return
    }
    if (key.return) {
      onSelect(AUTH_OPTIONS[selectedIndex])
      return
    }
  })

  return React.createElement(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: THEME.claude,
    padding: 1,
    marginTop: 1
  },
    React.createElement(Text, { key: 'title', bold: true, color: THEME.claude }, '⏺ Sign in to Claude'),
    React.createElement(Text, { key: 'subtitle', dimColor: true }, 'Choose your authentication method:'),
    React.createElement(Box, { key: 'spacer', marginTop: 1 }),
    React.createElement(Box, { key: 'options', flexDirection: 'column' },
      AUTH_OPTIONS.map((option, idx) => {
        const isSelected = idx === selectedIndex
        return React.createElement(Box, {
          key: option.id,
          flexDirection: 'column',
          marginBottom: 1
        },
          React.createElement(Text, {
            color: isSelected ? THEME.suggestion : undefined,
            inverse: isSelected,
            bold: isSelected
          },
            isSelected ? ' → ' : '   ',
            option.icon, ' ',
            option.name
          ),
          React.createElement(Text, {
            dimColor: !isSelected,
            color: isSelected ? THEME.suggestion : undefined
          }, '     ', option.description)
        )
      })
    ),
    React.createElement(Box, { key: 'help', marginTop: 1 },
      React.createElement(Text, { dimColor: true }, '↑↓ to navigate · Enter to select · Esc to cancel')
    )
  )
}

// Maximum number of suggestions to show at once
const MAX_SUGGESTIONS = 20
const VISIBLE_SUGGESTIONS = 10 // Show 10 at a time, scroll the rest
const MIN_TRANSCRIPT_WINDOW_SIZE = 8
const MAX_TRANSCRIPT_WINDOW_SIZE = 40

// Standard slash commands — TUI-only commands that need direct access to TUI context.
// Commands that exist in localCommands (from commands.mjs) are NOT duplicated here.
// The merge order is: [...localCommands, ...standardCommands, ...customCommands]
// so localCommands take precedence for text-based handlers, and standardCommands
// only add TUI-specific overlay wrappers or TUI-only commands (help, quit, version).
const standardCommands = [
  {
    name: 'help',
    description: 'Show available commands and help information',
    isEnabled: true,
    userFacingName() { return 'help' },
    async call(closeOverlay, context) {
      // Build help dynamically from all available commands
      const commandHelp = [
        ['help',           'Show this help message'],
        ['init',           'Create an AGENTS.md file for this project'],
        ['model',          'Switch AI models (or /models, /model <name>)'],
        ['login',          'Sign in to Dario'],
        ['logout',         'Sign out of Dario'],
        ['auth',           'Show authentication status'],
        ['status',         'Show project and session status'],
        ['cost',           'Show API usage and cost for this session'],
        ['compact',        'Compact conversation to free context space'],
        ['clear',          'Clear conversation history'],
        ['config',         'Manage configuration (get/set/remove/list)'],
        ['permissions',    'Show and manage permission mode'],
        ['approved-tools', 'Manage tool approvals (list/remove)'],
        ['mcp',            'Manage MCP servers (list/add/remove)'],
        ['fast',           'Toggle fast mode'],
        ['memory',         'Show or edit AGENTS.md memory file'],
        ['context',        'Show context window usage'],
        ['doctor',         'Run system health check'],
        ['resume',         'Resume a previous session'],
        ['export',         'Export session as markdown or JSON'],
        ['add-dir',        'Add a working directory'],
        ['tasks',          'View background tasks'],
        ['todos',          'View current todo list'],
        ['plugin',         'Manage plugins (list/install/enable/disable)'],
        ['agents',         'Browse and create agents'],
        ['tools',          'Manage tool modes (always/ask/auto/off)'],
        ['vim',            'Toggle vim keybindings'],
        ['terminal-setup', 'Configure shell integration'],
        ['simplify',       'Simplify recently changed code (optional focus area)'],
        ['batch',          'Queue prompts sequentially: add <prompt> | run | list | clear'],
        ['bug',            'Report a bug'],
        ['version',        'Show version information'],
        ['quit',           'Exit Dario'],
      ]

      const maxCmd = Math.max(...commandHelp.map(([c]) => c.length))
      const cmdLines = commandHelp.map(([cmd, desc]) =>
        `  /${cmd.padEnd(maxCmd + 1)} ${desc}`
      ).join('\n')

      return `Dario Help
${'─'.repeat(56)}

Commands:
${cmdLines}

Keyboard shortcuts:
  Shift+Tab  Cycle permission modes
  Tab        Toggle extended thinking (when input empty)
  PgUp/PgDn  Scroll transcript window
  Esc        Cancel current input / Undo
  Ctrl+C     Exit (or clear input)

Get started:
  Ask Dario questions about your codebase
  Use @filename to reference files
  Use ! prefix for bash commands`
    }
  },
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    description: 'Exit Dario',
    isEnabled: true,
    userFacingName() { return 'quit' },
    async call() {
      process.exit(0)
    }
  },
  {
    name: 'version',
    aliases: ['v'],
    description: 'Show version information',
    isEnabled: true,
    userFacingName() { return 'version' },
    async call() {
      return `Dario v${VERSION || '1.0.0'}`
    }
  },
  // Overlay wrappers — these show interactive TUI overlays when called without args,
  // but fall through to the localCommand handler when args are provided.
  {
    name: 'model-overlay',
    aliases: ['m'],
    description: 'Switch AI models (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true, // Hidden — /model from localCommands is the user-facing entry
    userFacingName() { return 'model' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]
      if (!arg && context?.showModelSelector) {
        context.showModelSelector()
        return null
      }
      // Has args — delegate to localCommand handler (won't reach here due to merge order)
      return null
    }
  },
  {
    name: 'login-overlay',
    description: 'Sign in to Dario',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'login' },
    async call(closeOverlay, context) {
      const authInfo = getAuthInfo()
      if (authInfo.authenticated && authInfo.method === 'oauth') {
        return '✓ Already authenticated via OAuth\nUse /logout to sign out'
      }
      if (authInfo.authenticated && authInfo.method === 'api_key') {
        return '✓ Already authenticated via API key (ANTHROPIC_API_KEY)\nOAuth not required when using API key'
      }
      if (context?.showAuthSelector) {
        context.showAuthSelector()
        return null
      }
      return 'Use arrow keys to select auth method, Enter to confirm, Esc to cancel'
    }
  },
  {
    name: 'fast-overlay',
    description: 'Toggle fast mode (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'fast' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]?.toLowerCase()
      if (arg === 'on' || arg === 'off') {
        const enable = arg === 'on'
        setFastMode(enable)
        return enable
          ? `↯ Fast mode ON · model set to ${getFastModeDisplayName()}`
          : 'Fast mode OFF'
      }
      if (context?.showFastModeToggle) {
        context.showFastModeToggle()
        return null
      }
      const current = isFastMode()
      setFastMode(!current)
      return !current
        ? `↯ Fast mode ON · model set to ${getFastModeDisplayName()}`
        : 'Fast mode OFF'
    }
  },
  {
    name: 'mcp-overlay',
    description: 'Manage MCP servers (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'mcp' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]?.toLowerCase()
      if (!arg && context?.showMcpManager) {
        context.showMcpManager()
        return null
      }
      return null // Fall through to localCommand
    }
  },
  {
    name: 'config-overlay',
    description: 'Manage configuration (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'config' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]?.toLowerCase()
      if (!arg || arg === 'list') {
        if (context?.showConfigManager) {
          context.showConfigManager()
          return null
        }
      }
      return null
    }
  },
  {
    name: 'approved-tools-overlay',
    description: 'Manage tool permissions (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'approved-tools' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]?.toLowerCase()
      if (!arg || arg === 'list') {
        if (context?.showApprovedToolsManager) {
          context.showApprovedToolsManager()
          return null
        }
      }
      return null
    }
  },
  {
    name: 'resume-overlay',
    description: 'Resume a previous session (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'resume' },
    async call(closeOverlay, context) {
      if (context?.showSessionPicker) {
        context.showSessionPicker()
        return null
      }
      return 'Session picker not available in this mode'
    }
  },
  {
    name: 'plugin-overlay',
    description: 'Manage plugins (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'plugin' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]?.toLowerCase()
      if (!arg && context?.showPluginManager) {
        context.showPluginManager()
        return null
      }
      return null // Fall through to localCommand
    }
  },
  {
    name: 'agents-overlay',
    description: 'Browse and create agents (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'agents' },
    async call(closeOverlay, context) {
      if (context?.showAgentManager) {
        context.showAgentManager()
        return null
      }
      return null
    }
  },
  {
    name: 'tools-overlay',
    description: 'Manage tool modes (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'tools' },
    async call(closeOverlay, context) {
      if (context?.showToolsManager) {
        context.showToolsManager()
        return null
      }
      return null
    }
  },
  {
    name: 'context-overlay',
    description: 'Manage context items (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'context' },
    async call(closeOverlay, context) {
      const arg = context?.args?.[0]?.toLowerCase()
      if (arg === 'manage' && context?.showContextManager) {
        context.showContextManager()
        return null
      }
      return null // Fall through to localCommand for /context (no args)
    }
  },
  {
    name: 'steer-overlay',
    description: 'Ask steering questions (interactive)',
    isEnabled: true,
    isOverlay: true,
    isHidden: true,
    userFacingName() { return 'steer' },
    async call(closeOverlay, context) {
      if (context?.showSteeringQuestions) {
        // Demo questions if called manually with no data
        const demoQuestions = [
          {
            id: 'framework',
            header: 'Framework',
            question: 'Which UI framework should we use for the new dashboard?',
            multiSelect: false,
            options: [
              { label: 'React + Tailwind (Recommended)', description: 'Matches existing stack, fastest to ship' },
              { label: 'Vue + Vuetify', description: 'Alternative SPA framework with material components' },
              { label: 'Svelte + Skeleton', description: 'Lightweight, compiled approach with less boilerplate' },
              { label: 'Plain HTML + HTMX', description: 'Server-rendered, minimal JS, hypermedia-driven' },
            ],
          },
          {
            id: 'features',
            header: 'Features',
            question: 'Which features should we prioritize for v1?',
            multiSelect: true,
            options: [
              { label: 'Auth + Roles', description: 'User login, SSO, role-based access control' },
              { label: 'Real-time updates', description: 'WebSocket-based live data feeds' },
              { label: 'Export/Reports', description: 'PDF/CSV export, scheduled reports' },
              { label: 'Dark mode', description: 'Theme toggle with system preference detection' },
            ],
          },
          {
            id: 'api',
            header: 'API design',
            question: 'How should we handle the API layer?',
            multiSelect: false,
            options: [
              { label: 'REST + OpenAPI', description: 'Standard REST endpoints with generated docs' },
              { label: 'GraphQL', description: 'Flexible queries, single endpoint, type-safe' },
              { label: 'tRPC', description: 'End-to-end type safety, no code generation needed' },
            ],
          },
          {
            id: 'deploy',
            header: 'Deploy',
            question: 'Where should we deploy?',
            multiSelect: false,
            options: [
              { label: 'Vercel', description: 'Zero-config, great DX, automatic previews' },
              { label: 'Fly.io', description: 'Edge deployment, Docker-based, more control' },
              { label: 'Self-hosted', description: 'Full control, no vendor lock-in, more ops work' },
            ],
          },
        ]
        context.showSteeringQuestions(context?.steeringData || demoQuestions)
        return null
      }
      return null
    }
  }
]

// Theme colors
const THEME = {
  claude: '#D97706',
  text: '#E5E5E5',
  secondaryText: '#B0B8C4',   // was #6B7280 — lifted for readability on dark bg
  secondaryBorder: '#374151',
  success: '#22C55E',
  error: '#EF4444',
  warning: '#F59E0B',
  suggestion: '#3B82F6',
  bashBorder: '#D4749D',
}

// Status modes for Shift+Tab cycling
const STATUS_MODES = {
  ACCEPT_EDITS: 'acceptEdits',
  PLAN: 'plan',
  BYPASS_PERMISSIONS: 'bypassPermissions',
}

function getNextMode(current) {
  const modes = Object.values(STATUS_MODES)
  const idx = modes.indexOf(current)
  return modes[(idx + 1) % modes.length]
}

function getModeDisplay(mode) {
  switch (mode) {
    case STATUS_MODES.ACCEPT_EDITS:
      return { icon: '✓', label: 'Auto-accept edits', color: THEME.success }
    case STATUS_MODES.PLAN:
      return { icon: '📋', label: 'Plan mode', color: THEME.suggestion }
    case STATUS_MODES.BYPASS_PERMISSIONS:
      return { icon: '⚠️', label: 'Bypass permissions', color: THEME.warning }
    default:
      return { icon: '?', label: 'Unknown', color: THEME.secondaryText }
  }
}

/**
 * Get git diff stats (files changed, insertions, deletions)
 * Returns null if not in a git repo or no changes
 */
function getGitStats() {
  try {
    const output = execFileSync('git', ['diff', '--shortstat'], { encoding: 'utf8', timeout: 2000 }).trim()
    if (!output) return null
    const files = output.match(/(\d+) files? changed/)
    const ins = output.match(/(\d+) insertions?/)
    const del = output.match(/(\d+) deletions?/)
    return {
      files: files ? parseInt(files[1]) : 0,
      insertions: ins ? parseInt(ins[1]) : 0,
      deletions: del ? parseInt(del[1]) : 0,
    }
  } catch {
    return null
  }
}

// Double-press to exit handler
function useDoublePress(onDouble, timeout = 2000) {
  const lastPress = useRef(0)
  const timeoutRef = useRef(null)
  const [pending, setPending] = useState(false)
  const [keyName, setKeyName] = useState('')

  const trigger = useCallback((key = 'Escape') => {
    const now = Date.now()
    if (now - lastPress.current < timeout) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      setPending(false)
      onDouble()
    } else {
      setPending(true)
      setKeyName(key)
      timeoutRef.current = setTimeout(() => setPending(false), timeout)
    }
    lastPress.current = now
  }, [onDouble, timeout])

  return { trigger, pending, keyName }
}

/**
 * Get short model display name
 */
function getModelShortName(model) {
  const shortNames = {
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-opus-4-1-20250805': 'Opus 4.1',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'claude-sonnet-4-20250514': 'Sonnet 4',
    'claude-3-5-haiku-20241022': 'Haiku 3.5',
    'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
    'claude-3-7-sonnet-20250219': 'Sonnet 3.7',
    'claude-3-opus-20240229': 'Opus 3',
  }
  return shortNames[model] || model
}

/**
 * Shorten path by replacing home directory with ~
 */
function shortenPath(fullPath) {
  const home = homedir()
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length)
  }
  return fullPath
}

const FEATURE_TIPS = [
  { label: '/context manage', desc: 'toggle skills, memory & tools on/off to save tokens' },
  { label: '/context add <file|url>', desc: 'inject docs, files or search results into context' },
  { label: '/tools', desc: 'set per-tool modes: always / ask / auto / off' },
  { label: 'hold Space', desc: 'speak your prompt using voice input (STT)' },
  { label: '/skills', desc: 'browse and invoke slash command skill packs' },
  { label: '/compact', desc: 'summarise conversation history to free context space' },
  { label: '/approved-tools', desc: 'manage which tools run without confirmation' },
  { label: '/sessions', desc: 'resume any previous conversation by session ID' },
  { label: '/mcp', desc: 'add Model Context Protocol servers for extra tools' },
  { label: 'plan mode', desc: 'Claude enters a planning phase before writing code' },
]

/**
 * Welcome Banner
 */
function WelcomeBanner({ mcpClients = [], isDefaultModel = true, model = '' }) {
  const termWidth = process.stdout.columns || 80
  const shortPath = shortenPath(process.cwd())
  const width = Math.min(termWidth, Math.max(46, shortPath.length + 20))

  // Logo block art (3 lines)
  const logoLines = [
    ' \u2590\u259B\u2588\u2588\u2588\u259C\u258C ',
    '\u259D\u259C\u259B\u259C\u2588\u259B\u259C\u259B\u2598',
    '  \u2598\u2598 \u259D\u259D  ',
  ]

  // Info lines next to logo
  const modelName = getModelShortName(model)

  // Pick a tip that rotates each startup
  const numStartups = loadConfig().numStartups ?? 0
  const tip = FEATURE_TIPS[numStartups % FEATURE_TIPS.length]

  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Box, {
      borderColor: THEME.claude,
      borderStyle: 'round',
      flexDirection: 'column',
      paddingLeft: 1,
      paddingRight: 1,
      width: width
    },
      // Logo + info row
      React.createElement(Box, { key: 'logo-row', flexDirection: 'row' },
        // Logo column
        React.createElement(Box, { flexDirection: 'column', marginRight: 1 },
          ...logoLines.map((line, i) =>
            React.createElement(Text, { key: `logo-${i}`, color: THEME.claude }, line)
          )
        ),
        // Info column
        React.createElement(Box, { flexDirection: 'column', justifyContent: 'center' },
          React.createElement(Text, { key: 'version' },
            React.createElement(Text, { bold: true }, 'Dario Code'),
            React.createElement(Text, { color: THEME.secondaryText }, ` v${VERSION}`)
          ),
          React.createElement(Text, { key: 'model' },
            React.createElement(Text, null, modelName)
          ),
          React.createElement(Text, { key: 'cwd', color: THEME.secondaryText, wrap: 'truncate' }, shortPath)
        )
      ),
      // Feature tip row
      React.createElement(Box, {
        key: 'tip',
        borderColor: THEME.secondaryBorder,
        borderStyle: 'single',
        borderBottom: false,
        borderLeft: false,
        borderRight: false,
        borderTop: true,
        marginLeft: 2,
        marginRight: 1,
        paddingTop: 1,
      },
        React.createElement(Text, { color: THEME.secondaryText }, '💡 '),
        React.createElement(Text, { color: THEME.text, bold: true }, tip.label),
        React.createElement(Text, { color: THEME.secondaryText }, ' — ' + tip.desc)
      ),
      // MCP Servers section
      mcpClients.length > 0 && React.createElement(Box, {
        key: 'mcp',
        borderColor: THEME.secondaryBorder,
        borderStyle: 'single',
        borderBottom: false,
        borderLeft: false,
        borderRight: false,
        borderTop: true,
        flexDirection: 'column',
        marginLeft: 2,
        marginRight: 1,
        paddingTop: 1
      },
        React.createElement(Box, { key: 'mcp-title', marginBottom: 1 },
          React.createElement(Text, { color: THEME.secondaryText }, 'MCP Servers:')
        ),
        mcpClients.map((client, idx) =>
          React.createElement(Box, { key: idx, width: width - 6 },
            React.createElement(Text, { color: THEME.secondaryText }, '\u2022 ', client.name),
            React.createElement(Box, { flexGrow: 1 }),
            React.createElement(Text, {
              bold: true,
              color: client.type === 'connected' ? THEME.success : THEME.error
            }, client.type === 'connected' ? 'connected' : 'failed')
          )
        )
      )
    )
  )
}

/**
 * Workspace Tips
 */
function WorkspaceTips({ workspaceDir }) {
  const config = loadConfig()
  const hasCompletedOnboarding = config.hasCompletedProjectOnboarding

  if (hasCompletedOnboarding) return null

  return React.createElement(Box, {
    flexDirection: 'column',
    gap: 1,
    padding: 1,
    paddingBottom: 0
  },
    React.createElement(Text, { key: 'title', color: THEME.secondaryText }, 'Tips for getting started:'),
    React.createElement(Box, { key: 'tips', flexDirection: 'column', paddingLeft: 2 },
      React.createElement(Text, { key: 'tip1', color: THEME.secondaryText },
        '• Run ', React.createElement(Text, { color: THEME.text }, '/init'),
        ' to create an AGENTS.md file with instructions for Dario.'
      ),
      React.createElement(Text, { key: 'tip2', color: THEME.secondaryText },
        '• Ask Dario questions about your codebase.'
      ),
      React.createElement(Text, { key: 'tip3', color: THEME.secondaryText },
        '• Ask Dario to implement changes to your codebase.'
      )
    )
  )
}

/**
 * Loading Spinner
 */
function LoadingSpinner() {
  const [frame, setFrame] = useState(0)
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % frames.length)
    }, 80)
    return () => clearInterval(timer)
  }, [])

  return React.createElement(Box, { marginLeft: 3 },
    React.createElement(Text, { color: THEME.claude }, frames[frame], ' Thinking...')
  )
}

/**
 * Token Counter Display
 */
function TokenCounter({ tokenUsage }) {
  if (!tokenUsage || tokenUsage === 0) return null

  const formatted = tokenUsage >= 1000
    ? `${(tokenUsage / 1000).toFixed(1)}k`
    : tokenUsage.toString()

  return React.createElement(Text, { dimColor: true }, formatted, ' tokens')
}

/**
 * Text Input Display - just renders, doesn't handle input
 * Input handling is done by parent PromptInput
 */
function TextInputDisplay({
  value,
  placeholder = '',
  isDimmed = false,
  cursorOffset = 0,
  color,
}) {
  // Render with cursor
  const displayValue = value || ''
  const cursorPos = Math.min(cursorOffset, displayValue.length)
  const beforeCursor = displayValue.slice(0, cursorPos)
  const atCursor = displayValue[cursorPos] || ' '
  const afterCursor = displayValue.slice(cursorPos + 1)

  if (!value && placeholder) {
    return React.createElement(Text, { color: THEME.secondaryText },
      React.createElement(Text, { inverse: true }, placeholder[0] || ' '),
      placeholder.slice(1)
    )
  }

  return React.createElement(Text, { dimColor: isDimmed, color, wrap: 'wrap' },
    beforeCursor,
    React.createElement(Text, { inverse: true, color }, atCursor),
    afterCursor
  )
}

/**
 * Message Renderer
 */
function MessageRenderer({
  message,
  tools,
  verbose,
  debug,
  addMargin = true,
  erroredToolUseIDs = new Set(),
  inProgressToolUseIDs = new Set(),
  unresolvedToolUseIDs = new Set(),
  shouldAnimate = false,
  shouldShowDot = true,
  expandedToolResults = new Set(),
}) {
  const messageId = message.uuid || message.id || 'unknown'

  if (message.type === 'assistant') {
    // Handle string content (from commands) or array content (from AI)
    const assistantContent = typeof message.message.content === 'string'
      ? [{ type: 'text', text: message.message.content }]
      : message.message.content

    return React.createElement(Box, { flexDirection: 'column', width: '100%' },
      assistantContent.map((item, idx) =>
        React.createElement(AssistantContentRenderer, {
          key: item.id || `${messageId}-${item.type}-${idx}`,
          param: item,
          tools,
          verbose,
          debug,
          addMargin,
          erroredToolUseIDs,
          inProgressToolUseIDs,
          unresolvedToolUseIDs,
          shouldAnimate,
          shouldShowDot,
        })
      )
    )
  }

  // User message
  const content = typeof message.message.content === 'string'
    ? [{ type: 'text', text: message.message.content }]
    : message.message.content

  return React.createElement(Box, { flexDirection: 'column', width: '100%' },
    content.map((item, idx) =>
      React.createElement(UserContentRenderer, {
        key: item.tool_use_id || `${messageId}-${item.type}-${idx}`,
        param: item,
        addMargin,
        expandedToolResults,
      })
    )
  )
}

const MemoizedMessageRenderer = memo(MessageRenderer)

// ★ Insight block detection + rendering
// Matches backtick-wrapped or bare lines starting with ★ Insight ───…
const INSIGHT_OPEN_RE = /^`?★\s*Insight\s*─+`?$/
const INSIGHT_CLOSE_RE = /^`?─{10,}`?$/

/**
 * Split raw text into alternating plain-text and insight segments.
 * Returns an array of { type: 'text' | 'insight', content: string }
 */
function parseInsightBlocks(text) {
  const lines = text.split('\n')
  const segments = []
  let i = 0
  let currentText = []

  while (i < lines.length) {
    if (INSIGHT_OPEN_RE.test(lines[i].trim())) {
      // Flush accumulated text
      if (currentText.length > 0) {
        segments.push({ type: 'text', content: currentText.join('\n') })
        currentText = []
      }
      // Collect insight body until closing rule
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

/**
 * Render a ★ Insight block with distinct visual treatment
 */
function InsightBlock({ content }) {
  const bar = '─'.repeat(44)
  return React.createElement(Box, {
    flexDirection: 'column',
    marginTop: 1,
    marginLeft: 2,
    marginBottom: 1,
  },
    React.createElement(Text, { color: '#F59E0B', bold: true }, `★ Insight ${bar}`),
    React.createElement(Box, { marginLeft: 2, marginTop: 0 },
      React.createElement(Text, { color: '#FCD34D' }, content)
    ),
    React.createElement(Text, { color: '#F59E0B' }, `${'─'.repeat(bar.length + 10)}`)
  )
}

/**
 * Render the full plan review box shown after ExitPlanMode fires.
 * Displays the plan title, markdown content, accept/reject hints,
 * and a contextual ★ Insight block below.
 */
function PlanDisplay({ plan, onAccept, onReject }) {
  const termWidth = process.stdout.columns || 80
  const width = Math.min(termWidth - 4, 88)

  // Read the .md file if it exists, fall back to description
  let content = plan.description || ''
  try {
    const mdPath = path.join(homedir(), '.dario', 'plans', `${plan.id}.md`)
    if (existsSync(mdPath)) {
      content = readFileSync(mdPath, 'utf8')
        .replace(/^\*\*Status\*\*:.*\n/m, '')
        .replace(/^\*\*Created\*\*:.*\n/m, '')
        .replace(/^\*\*Updated\*\*:.*\n/m, '')
        .trim()
    }
  } catch {}

  const bar = '─'.repeat(44)
  const insightText =
    'Review the plan above carefully before accepting.\n' +
    'Once approved, conversation history will be compacted\n' +
    'and implementation will begin with a full context window.'

  return React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: THEME.suggestion,
      paddingLeft: 1,
      paddingRight: 1,
      width,
    },
      // Header
      React.createElement(Box, { key: 'header', marginBottom: 1 },
        React.createElement(Text, { bold: true, color: THEME.suggestion }, 'Plan to implement')
      ),
      // Title
      React.createElement(Box, { key: 'title', marginBottom: 1 },
        React.createElement(Text, { bold: true }, plan.title || 'Untitled Plan')
      ),
      // Body
      React.createElement(Box, { key: 'body', marginBottom: 1 },
        React.createElement(Text, { wrap: 'wrap' }, content)
      ),
      // Divider
      React.createElement(Box, {
        key: 'divider',
        borderStyle: 'single',
        borderTop: true,
        borderBottom: false,
        borderLeft: false,
        borderRight: false,
        borderColor: THEME.secondaryBorder,
        marginBottom: 1,
      }),
      // Accept / Reject hints
      React.createElement(Box, { key: 'actions', flexDirection: 'row', gap: 2 },
        React.createElement(Text, { color: THEME.success, bold: true }, '[y] Accept'),
        React.createElement(Text, { color: THEME.error, bold: true }, '[n] Reject'),
        React.createElement(Text, { color: THEME.secondaryText }, '— press key to choose')
      )
    ),
    // ★ Insight block below the box
    React.createElement(Box, {
      key: 'insight',
      flexDirection: 'column',
      marginTop: 1,
      marginLeft: 2,
      marginBottom: 1,
    },
      React.createElement(Text, { color: '#F59E0B', bold: true }, `★ Insight ${bar}`),
      React.createElement(Box, { marginLeft: 2 },
        React.createElement(Text, { color: '#FCD34D' }, insightText)
      ),
      React.createElement(Text, { color: '#F59E0B' }, '─'.repeat(bar.length + 10))
    )
  )
}

/**
 * Assistant Content Renderer
 */
function AssistantContentRenderer({
  param,
  tools,
  verbose,
  debug,
  addMargin,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
}) {
  switch (param.type) {
    case 'tool_use':
      return React.createElement(ToolUseRenderer, {
        param,
        tools,
        verbose,
        debug,
        addMargin,
        erroredToolUseIDs,
        inProgressToolUseIDs,
        unresolvedToolUseIDs,
        shouldAnimate,
        shouldShowDot,
      })

    case 'text': {
      const segments = parseInsightBlocks(param.text)
      // Fast path: no insight blocks — render as before
      if (segments.length === 1 && segments[0].type === 'text') {
        const rendered = renderMarkdown(param.text)
        return React.createElement(Box, {
          flexDirection: 'column',
          marginTop: addMargin ? 1 : 0,
          marginLeft: 2
        },
          React.createElement(Text, null,
            shouldShowDot && React.createElement(Text, { color: THEME.claude }, '● '),  
            rendered
          )
        )
      }
      // Mixed: render each segment in order
      return React.createElement(Box, {
        flexDirection: 'column',
        marginTop: addMargin ? 1 : 0,
      },
        segments.map((seg, idx) =>
          seg.type === 'insight'
            ? React.createElement(InsightBlock, { key: idx, content: seg.content })
            : React.createElement(Box, { key: idx, marginLeft: 2 },
                React.createElement(Text, null,
                  idx === 0 && shouldShowDot && React.createElement(Text, { color: THEME.claude }, '● '),  
                  renderMarkdown(seg.content)
                )
              )
        )
      )
    }

    case 'thinking':
      return React.createElement(Box, {
        marginTop: 1,
        marginLeft: 2
      },
        React.createElement(Text, { dimColor: true, italic: true },
          '[Thinking: ', param.thinking?.substring(0, 100) || '', '...]'
        )
      )

    case 'redacted_thinking':
      return React.createElement(Box, {
        marginTop: 1,
        marginLeft: 2
      },
        React.createElement(Text, { dimColor: true, italic: true },
          '[Thinking redacted for safety]'
        )
      )

    default:
      return null
  }
}

/**
 * Inline Diff Block — renders colored diff lines from oldText/newText
 */
function DiffBlock({ oldText, newText, filename }) {
  const diffLines = useMemo(
    () => generateDiff(oldText, newText, filename),
    [oldText, newText, filename]
  )
  if (!diffLines || diffLines.length === 0) return null

  return React.createElement(Box, { flexDirection: 'column' },
    diffLines.map((d, i) => {
      switch (d.type) {
        case 'header':
          return React.createElement(Text, { key: i, color: THEME.secondaryText, dimColor: true }, d.line)
        case 'add':
          return React.createElement(Text, { key: i, color: THEME.success }, '+ ', d.line)
        case 'remove':
          return React.createElement(Text, { key: i, color: THEME.error }, '- ', d.line)
        case 'context':
          return React.createElement(Text, { key: i, dimColor: true }, '  ', d.line)
        default:
          return null
      }
    })
  )
}

/**
 * User Content Renderer
 */
function UserContentRenderer({ param, addMargin, expandedToolResults = new Set() }) {
  switch (param.type) {
    case 'text':
      return React.createElement(Box, {
        marginTop: addMargin ? 1 : 0,
        marginLeft: 2,
        width: '100%',
      },
        React.createElement(Text, null,
          React.createElement(Text, { color: THEME.success, bold: true }, '❯ '),
          param.text
        )
      )

    case 'image':
      return React.createElement(Box, {
        marginTop: addMargin ? 1 : 0,
        marginLeft: 2
      },
        React.createElement(Text, { color: '#FF9500' },
          `📎 [image: ${param.source?.media_type || 'image'}]`
        )
      )

    case 'tool_result': {
      const isError = param.is_error
      const data = param.data
      // Inline diff for Edit tool (has oldString/newString)
      if (!isError && data?.oldString !== undefined && data?.newString !== undefined && data.oldString !== data.newString) {
        const displayFile = data.filePath || 'file'
        return React.createElement(Box, { flexDirection: 'column', marginLeft: 4 },
          React.createElement(Text, { color: THEME.secondaryText }, '⎿ ', `Updated ${displayFile}`),
          React.createElement(DiffBlock, {
            oldText: data.oldString,
            newText: data.newString,
            filename: displayFile,

          })
        )
      }

      // Inline diff for Write tool updates (has oldContent + content)
      if (!isError && data?.type === 'update' && data?.oldContent && data?.content) {
        const displayFile = data.filePath || 'file'
        return React.createElement(Box, { flexDirection: 'column', marginLeft: 4 },
          React.createElement(Text, { color: THEME.secondaryText }, '⎿ ', `Updated ${displayFile}`),
          React.createElement(DiffBlock, {
            oldText: data.oldContent,
            newText: data.content,
            filename: displayFile,

          })
        )
      }

      // Write tool creates — just show creation notice
      if (!isError && data?.type === 'create' && data?.filePath) {
        const lineCount = (data.content || '').split('\n').length
        return React.createElement(Box, { flexDirection: 'column', marginLeft: 4 },
          React.createElement(Text, { color: THEME.secondaryText }, '⎿ ', `Created ${data.filePath} (${lineCount} lines)`)
        )
      }

      // Fallback: plain text rendering
      // Filter out base64 image data to avoid dumping huge strings
      const content = typeof param.content === 'string'
        ? param.content
        : Array.isArray(param.content)
          ? param.content.map(block =>
              block.type === 'image'
                ? `[image: ${block.source?.media_type || 'image'}]`
                : block.text || JSON.stringify(block)
            ).join('\n')
          : JSON.stringify(param.content)

      const isCollapsed = expandedToolResults.has(param.tool_use_id)
      const lines = content.split('\n')
      const PREVIEW_LINES = 5
      const hasMore = lines.length > PREVIEW_LINES
      const displayContent = isCollapsed
        ? lines.slice(0, PREVIEW_LINES).join('\n')
        : content
      const hiddenCount = lines.length - PREVIEW_LINES

      return React.createElement(Box, {
        flexDirection: 'column',
        marginLeft: 4
      },
        displayContent.split('\n').map((line, i) =>
          React.createElement(Text, {
            key: i,
            color: isError ? THEME.error : THEME.secondaryText
          },
            i === 0 ? (isError ? '✗ ' : '⎿ ') : '  ',
            line
          )
        ),
        hasMore && isCollapsed && React.createElement(Text, {
          key: 'more',
          dimColor: true
        }, `  … (+${hiddenCount} lines · ctrl+o to expand)`)
      )
    }

    default:
      return null
  }
}

/**
 * Tool Use Renderer
 */
function ToolUseRenderer({
  param,
  tools,
  verbose,
  addMargin,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
}) {
  // Skip synthetic tool_use messages created by normalizeMessages
  if (param.name === 'unknown') {
    return null
  }

  const tool = tools?.find(t => t.name === param.name)
  const toolName = tool?.userFacingName?.() || param.name

  const isErrored = erroredToolUseIDs.has(param.id)
  const isInProgress = inProgressToolUseIDs.has(param.id)
  const isUnresolved = unresolvedToolUseIDs.has(param.id)

  let statusIcon = '●'
  let statusColor = THEME.claude

  if (isErrored) {
    statusIcon = '●'
    statusColor = THEME.error
  } else if (isInProgress) {
    statusIcon = '●'
    statusColor = THEME.suggestion
  } else if (!isUnresolved) {
    statusIcon = '●'
    statusColor = THEME.success
  }

  return React.createElement(Box, {
    flexDirection: 'column',
    marginTop: addMargin ? 1 : 0,
    marginLeft: 2
  },
    React.createElement(Text, null,
      shouldShowDot && React.createElement(Text, { color: statusColor }, statusIcon, ' '),
      React.createElement(Text, { bold: true, color: 'white' }, toolName)
    ),
    verbose && param.input && React.createElement(Box, { marginLeft: 2 },
      React.createElement(Text, { dimColor: true },
        JSON.stringify(param.input, null, 2).substring(0, 200)
      )
    )
  )
}

/**
 * Prompt Input - main input component with all features
 */
function PromptInput({
  commands = [],
  tools = [],
  isDisabled = false,
  isLoading = false,
  onQuery,
  debug = false,
  verbose = false,
  messages = [],
  mode,
  onModeChange,
  onShowMessageSelector,
  onCancel,
  mcpStatus = null,
  gitStats = null,
  onBypassPermissionsChange,
  queuedMessage = null,
  setQueuedMessage,
  expandedToolResults = new Set(),
  onToggleToolResultExpand,
  onTranscriptPageUp,
  onTranscriptPageDown,
  onTranscriptJumpToLatest,
  transcriptIsWindowed = false,
}) {
  // Internal input state (moved from parent to avoid re-renders)
  const [input, setInput] = useState('')
  const onInputChange = setInput

  // Status line state
  const [statusMode, setStatusMode] = useState(STATUS_MODES.ACCEPT_EDITS)
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  const [thinkingVisible, setThinkingVisible] = useState(false)
  const thinkingTimeoutRef = useRef(null)

  // Voice mode state
  const [voiceStatus, setVoiceStatus] = useState(null)   // 'recording' | 'transcribing' | null
  const voiceSessionRef = useRef(null)
  const voiceReleaseTimerRef = useRef(null)
  const voiceHoldingRef = useRef(false)
  const voiceSpaceCountRef = useRef(0)

  // Voice start/stop handlers (called from useInput space-hold detection)
  const handleVoiceStart = useCallback(() => {
    if (voiceSessionRef.current) return

    const session = new VoiceSession()
    voiceSessionRef.current = session

    session.on('recording', () => {
      setVoiceStatus('recording')
    })
    session.on('transcribing', () => {
      setVoiceStatus('transcribing')
    })
    session.on('transcribed', (text) => {
      setVoiceStatus(null)
      voiceSessionRef.current = null
      if (text) onQuery(text)
    })
    session.on('error', () => {
      setVoiceStatus(null)
      voiceSessionRef.current = null
    })

    session.start()
  }, [onQuery])

  const handleVoiceStop = useCallback(() => {
    if (voiceSessionRef.current) {
      voiceSessionRef.current.stop()
    }
  }, [])

  // Cleanup release timer on unmount
  useEffect(() => {
    return () => {
      if (voiceReleaseTimerRef.current) clearTimeout(voiceReleaseTimerRef.current)
    }
  }, [])

  // Suggestions state
  const [suggestions, setSuggestions] = useState([])
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [suggestionMode, setSuggestionMode] = useState(null)

  // Refs to avoid stale closure issues with rapid input
  const inputRef = useRef(input)
  const cursorOffsetRef = useRef(input.length)
  const [cursorOffset, _setCursorOffset] = useState(input.length)

  // Keep inputRef in sync with prop + notify keyboardManager for voice mode
  useEffect(() => {
    inputRef.current = input
    keyboardManager.setCurrentInput(input)
  }, [input])

  const setCursorOffset = useCallback((val) => {
    const newVal = typeof val === 'function' ? val(cursorOffsetRef.current) : val
    cursorOffsetRef.current = newVal
    _setCursorOffset(newVal)
  }, [])

  const [exitMessage, setExitMessage] = useState({ show: false })

  // History
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  // Image attachments
  const [attachments, setAttachments] = useState([])  // Array of { path, name }
  const [attachmentFocusIndex, setAttachmentFocusIndex] = useState(-1) // -1 = input focused, 0+ = attachment index

  // Double press to exit
  const exitHandler = useDoublePress(() => process.exit(0))

  // Status line handlers
  const handleStatusShiftTab = useCallback(() => {
    setStatusMode(prev => {
      const next = getNextMode(prev)
      onBypassPermissionsChange?.(next === STATUS_MODES.BYPASS_PERMISSIONS)
      return next
    })
  }, [onBypassPermissionsChange])

  const handleStatusTab = useCallback(() => {
    setThinkingEnabled(prev => !prev)
    setThinkingVisible(true)
    if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current)
    thinkingTimeoutRef.current = setTimeout(() => {
      setThinkingVisible(false)
    }, 3000)
  }, [])

  useEffect(() => {
    return () => {
      if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current)
    }
  }, [])

  // Update suggestions based on input
  useEffect(() => {
    // DEBUG: Log commands and input
    if (process.env.DEBUG_TUI) {
      console.error('[DEBUG] input:', JSON.stringify(input), 'commands:', commands.length)
    }

    if (input.startsWith('/')) {
      // Command suggestions
      const search = input.slice(1).toLowerCase()
      const seen = new Set()
      const matching = commands
        .filter(cmd => {
          // Skip hidden overlay stubs — they duplicate real localCommands
          if (cmd.isHidden) return false
          const name = cmd.userFacingName?.() || cmd.name
          // Deduplicate by user-facing name (in case of any other duplicates)
          if (seen.has(name)) return false
          seen.add(name)
          return name.toLowerCase().includes(search) ||
            cmd.aliases?.some(a => a.toLowerCase().includes(search))
        })
        .map(cmd => cmd.userFacingName?.() || cmd.name)
        .slice(0, MAX_SUGGESTIONS)

      if (process.env.DEBUG_TUI) {
        console.error('[DEBUG] suggestions:', matching)
      }

      setSuggestions(matching)
      setSelectedSuggestion(0)
      setSuggestionMode('command')
    } else if (input.includes('@') && !input.startsWith('/')) {
      // File suggestions
      const atIndex = input.lastIndexOf('@')
      const search = input.slice(atIndex + 1).split(' ')[0]
      if (search.length > 0) {
        // Search for files matching the pattern
        const searchFiles = async () => {
          try {
            const pattern = `**/*${search}*`
            const files = await glob(pattern, {
              cwd: process.cwd(),
              nodir: true,
              ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
              maxDepth: 5
            })
            const matches = files
              .slice(0, MAX_SUGGESTIONS)
              .map(f => relative(process.cwd(), f) || f)
            setSuggestions(matches)
            setSuggestionMode('file')
          } catch (e) {
            setSuggestions([])
            setSuggestionMode(null)
          }
        }
        searchFiles()
      } else {
        // Show recent/common files when @ is typed without search
        setSuggestions([])
        setSuggestionMode('file')
      }
    } else {
      setSuggestions([])
      setSuggestionMode(null)
    }
  }, [input, commands])

  // Auto-detect file paths in input (fires on every input change)
  // Handles drag-drop (terminal emits path as text) and manual paste
  useEffect(() => {
    if (!input) return
    const FILE_PATH_RE = /(?:['"]?)((?:\/|~\/|\.\/)[^\t'"]+?)(?:['"]?)(?=\s|$)/gi
    const matches = [...input.matchAll(FILE_PATH_RE)]
    if (matches.length === 0) return

    let remaining = input
    let foundAny = false
    for (const match of matches) {
      const pathCandidate = match[1].replace(/\\(.)/g, '$1')
      const resolvedPath = pathCandidate.startsWith('~')
        ? pathCandidate.replace('~', homedir())
        : pathCandidate
      if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
        setAttachments(prev => {
          if (prev.some(a => a.path === resolvedPath)) return prev
          return [...prev, { path: resolvedPath, name: basename(resolvedPath) }]
        })
        remaining = remaining.replace(match[0], '').trim()
        foundAny = true
      }
    }

    if (foundAny) {
      setAttachmentFocusIndex(-1)
      onInputChange(remaining)
      inputRef.current = remaining
      setCursorOffset(remaining.length)
    }
  }, [input])

  // Handle submit
  const handleSubmit = useCallback(async (value) => {
    const hasAttachments = attachments.length > 0
    // Robust input validation — allow empty text if attachments exist
    if (!hasAttachments && (!value || typeof value !== 'string' || value.trim() === '')) return
    if (isDisabled) return

    // Queue message if currently loading (auto-submits when turn completes)
    if (isLoading) {
      const sanitizedValue = (value || '').trim().slice(0, 100000)
      if (!hasAttachments && sanitizedValue.length === 0) return
      setQueuedMessage(hasAttachments
        ? { text: sanitizedValue, attachments: [...attachments] }
        : sanitizedValue)
      onInputChange('')
      setCursorOffset(0)
      setAttachments([])
      return
    }

    // Sanitize and validate input length (max 100k chars)
    const sanitizedValue = (value || '').trim().slice(0, 100000)
    if (!hasAttachments && sanitizedValue.length === 0) return

    // Handle exit commands
    if (['exit', 'quit', ':q', ':q!', ':wq', ':wq!'].includes(sanitizedValue)) {
      process.exit(0)
    }

    // Clear input and attachments immediately to prevent double submission
    onInputChange('')
    setCursorOffset(0)
    setSuggestions([])
    const currentAttachments = [...attachments]
    setAttachments([])
    setAttachmentFocusIndex(-1)

    // Add to history (text only)
    if (sanitizedValue) {
      setHistory(h => [sanitizedValue, ...h.slice(0, 50)])
    }
    setHistoryIndex(-1)
    onTranscriptJumpToLatest?.()

    // Call onQuery with error handling
    try {
      if (typeof onQuery === 'function') {
        if (currentAttachments.length > 0) {
          // Send as object with attachments for multipart content
          await onQuery({ text: sanitizedValue, attachments: currentAttachments })
        } else {
          await onQuery(sanitizedValue)
        }
      }
    } catch (error) {
      console.error('[TUI] Error in onQuery:', error)
    }
  }, [isDisabled, isLoading, onInputChange, onQuery, setCursorOffset, setSuggestions, setHistory, setHistoryIndex, attachments, onTranscriptJumpToLatest])

  // Handle history navigation
  const handleHistoryUp = useCallback(() => {
    if (history.length === 0) return
    const newIndex = Math.min(historyIndex + 1, history.length - 1)
    setHistoryIndex(newIndex)
    const historyValue = history[newIndex] || ''
    inputRef.current = historyValue
    onInputChange(historyValue)
    setCursorOffset(historyValue.length)
  }, [history, historyIndex, onInputChange])

  const handleHistoryDown = useCallback(() => {
    if (historyIndex <= 0) {
      setHistoryIndex(-1)
      inputRef.current = ''
      onInputChange('')
      setCursorOffset(0)
      return
    }
    const newIndex = historyIndex - 1
    setHistoryIndex(newIndex)
    const historyValue = history[newIndex] || ''
    inputRef.current = historyValue
    onInputChange(historyValue)
    setCursorOffset(historyValue.length)
  }, [history, historyIndex, onInputChange])

  // ALL keyboard input handled here
  useInput((char, key) => {
    // Robust null checking
    if (!key || typeof key !== 'object') return

    // Handle Escape - cancel loading, clear queue, OR clear input
    if (key.escape) {
      if (isLoading && onCancel) {
        onCancel()
        return
      }
      // Clear queued message if one exists (before other idle escape behaviors)
      if (queuedMessage && !isLoading) {
        setQueuedMessage(null)
        return
      }
      if (input === '' && messages.length > 0 && !isLoading) {
        onShowMessageSelector?.()
      } else if (input === '') {
        exitHandler.trigger('Escape')
      } else {
        onInputChange('')
        setCursorOffset(0)
        onModeChange?.('prompt')
      }
      return
    }

    // Ctrl+B — unified background (CC 2.1 parity)
    if (char === '\x02') {
      backgroundAll()
      return
    }

    // Ctrl+O — toggle expand/collapse on the most recent tool result
    if (char === '\x0f') {
      if (onToggleToolResultExpand && messages.length > 0) {
        // Find the most recent tool_result in messages (walk backwards)
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
            const toolResult = msg.message.content.find(c => c.type === 'tool_result')
            if (toolResult) {
              onToggleToolResultExpand(toolResult.tool_use_id)
              break
            }
          }
        }
      }
      return
    }

    // Transcript paging
    if (key.pageUp) {
      onTranscriptPageUp?.()
      return
    }
    if (key.pageDown) {
      onTranscriptPageDown?.()
      return
    }
    if (key.end) {
      onTranscriptJumpToLatest?.()
      return
    }

    // Shift+Tab to cycle modes
    if (key.shift && key.tab) {
      handleStatusShiftTab()
      return
    }

    // Tab to toggle thinking (when input is empty) or autocomplete suggestion
    if (key.tab && !key.shift) {
      if (suggestions.length > 0 && suggestionMode) {
        // Autocomplete the selected suggestion
        const selected = suggestions[selectedSuggestion]
        if (selected) {
          const currentInput = inputRef.current
          if (suggestionMode === 'command') {
            // Replace entire input with command
            const newValue = '/' + selected + ' '
            inputRef.current = newValue
            onInputChange(newValue)
            setCursorOffset(newValue.length)
          } else if (suggestionMode === 'file') {
            // Replace @search with @file
            const atIndex = currentInput.lastIndexOf('@')
            const beforeAt = currentInput.slice(0, atIndex)
            const newValue = beforeAt + '@' + selected + ' '
            inputRef.current = newValue
            onInputChange(newValue)
            setCursorOffset(newValue.length)
          }
          setSuggestions([])
          setSuggestionMode(null)
        }
        return
      }
      if (input === '' && !isLoading) {
        handleStatusTab()
      }
      return
    }

    // Enter to submit (or autocomplete+submit if suggestion is active)
    if (key.return && !key.shift) {
      if (suggestions.length > 0 && suggestionMode) {
        const selected = suggestions[selectedSuggestion]
        if (selected) {
          if (suggestionMode === 'command') {
            // Submit the command directly
            const cmdValue = '/' + selected
            setSuggestions([])
            setSuggestionMode(null)
            handleSubmit(cmdValue)
            return
          } else if (suggestionMode === 'file') {
            // Autocomplete file and submit
            const currentInput = inputRef.current
            const atIndex = currentInput.lastIndexOf('@')
            const beforeAt = currentInput.slice(0, atIndex)
            const finalValue = beforeAt + '@' + selected
            setSuggestions([])
            setSuggestionMode(null)
            handleSubmit(finalValue)
            return
          }
        }
      }
      handleSubmit(input)
      return
    }

    // Shift+Enter for newline
    if (key.return && key.shift) {
      const offset = cursorOffsetRef.current
      const currentInput = inputRef.current
      const newValue = currentInput.slice(0, offset) + '\n' + currentInput.slice(offset)
      inputRef.current = newValue
      onInputChange(newValue)
      setCursorOffset(offset + 1)
      return
    }

    // Navigate suggestions OR attachments OR history
    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSelectedSuggestion(s => Math.max(0, s - 1))
      } else if (attachmentFocusIndex === -1 && attachments.length > 0) {
        // From input → focus last attachment
        setAttachmentFocusIndex(attachments.length - 1)
      } else if (attachmentFocusIndex > 0) {
        // Navigate up through attachments
        setAttachmentFocusIndex(i => i - 1)
      } else if (attachmentFocusIndex === 0) {
        // Past all attachments → go to history
        setAttachmentFocusIndex(-1)
        handleHistoryUp()
      } else {
        handleHistoryUp()
      }
      return
    }
    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSelectedSuggestion(s => Math.min(suggestions.length - 1, s + 1))
      } else if (attachmentFocusIndex >= 0) {
        // Navigate down through attachments → back to input
        if (attachmentFocusIndex < attachments.length - 1) {
          setAttachmentFocusIndex(i => i + 1)
        } else {
          setAttachmentFocusIndex(-1)
        }
      } else {
        handleHistoryDown()
      }
      return
    }

    // Cursor movement
    if (key.leftArrow) {
      setCursorOffset(o => Math.max(0, o - 1))
      return
    }
    if (key.rightArrow) {
      setCursorOffset(o => Math.min(input.length, o + 1))
      return
    }

    // Backspace — remove attachment if one is focused
    if (key.backspace || key.delete) {
      if (attachmentFocusIndex >= 0) {
        setAttachments(prev => prev.filter((_, i) => i !== attachmentFocusIndex))
        setAttachmentFocusIndex(i => {
          const newLen = attachments.length - 1
          if (newLen === 0) return -1
          return Math.min(i, newLen - 1)
        })
        return
      }
      const offset = cursorOffsetRef.current
      const currentInput = inputRef.current
      if (offset > 0) {
        const newValue = currentInput.slice(0, offset - 1) + currentInput.slice(offset)
        inputRef.current = newValue
        onInputChange(newValue)
        setCursorOffset(offset - 1)
      }
      return
    }

    // Ctrl+A - start of line
    if (key.ctrl && char === 'a') {
      setCursorOffset(0)
      return
    }

    // Ctrl+E - end of line
    if (key.ctrl && char === 'e') {
      setCursorOffset(input.length)
      return
    }

    // Ctrl+U - clear line
    if (key.ctrl && char === 'u') {
      onInputChange('')
      setCursorOffset(0)
      return
    }

    // Ctrl+C - exit if empty, clear if has text
    if (key.ctrl && char === 'c') {
      if (input === '') {
        process.exit(0)
      } else {
        onInputChange('')
        setCursorOffset(0)
      }
      return
    }

    // Ctrl+K - kill to end of line
    if (key.ctrl && char === 'k') {
      const offset = cursorOffsetRef.current
      const currentInput = inputRef.current || ''
      const newValue = currentInput.slice(0, offset)
      inputRef.current = newValue
      onInputChange(newValue)
      return
    }

    // Ctrl+W - delete word backward
    if (key.ctrl && char === 'w') {
      const offset = cursorOffsetRef.current
      const currentInput = inputRef.current || ''
      const beforeCursor = currentInput.slice(0, offset)
      // Find last word boundary
      const match = beforeCursor.match(/\S+\s*$/)
      if (match) {
        const newOffset = offset - match[0].length
        const newValue = currentInput.slice(0, newOffset) + currentInput.slice(offset)
        inputRef.current = newValue
        onInputChange(newValue)
        setCursorOffset(newOffset)
      }
      return
    }

    // Alt+F - forward word
    if (key.meta && char === 'f') {
      const currentInput = inputRef.current || ''
      const afterCursor = currentInput.slice(cursorOffsetRef.current)
      const match = afterCursor.match(/^\s*\S+/)
      if (match) {
        setCursorOffset(o => o + match[0].length)
      }
      return
    }

    // Alt+B - backward word
    if (key.meta && char === 'b') {
      const currentInput = inputRef.current || ''
      const beforeCursor = currentInput.slice(0, cursorOffsetRef.current)
      const match = beforeCursor.match(/\S+\s*$/)
      if (match) {
        setCursorOffset(o => o - match[0].length)
      }
      return
    }

    // Regular character input
    if (char && typeof char === 'string' && !key.ctrl && !key.meta) {
      // Validate character is printable (not control chars)
      const charCode = char.charCodeAt(0)
      if (charCode < 32 && charCode !== 10) return // Skip control chars except newline

      // Voice mode: space-hold detection when input is empty
      // macOS has ~300-500ms delay before key repeat starts, then ~30ms between repeats.
      // Use a longer timeout for the first space, shorter once repeat stream is confirmed.
      if (keyboardManager.voiceMode && char === ' ' && !inputRef.current) {
        if (!voiceHoldingRef.current) {
          voiceHoldingRef.current = true
          voiceSpaceCountRef.current = 1
          handleVoiceStart()
        } else {
          voiceSpaceCountRef.current++
        }
        if (voiceReleaseTimerRef.current) clearTimeout(voiceReleaseTimerRef.current)
        // First space: 500ms survives the pre-repeat delay. Once repeating: 150ms.
        const timeout = voiceSpaceCountRef.current <= 1 ? 500 : 150
        voiceReleaseTimerRef.current = setTimeout(() => {
          voiceHoldingRef.current = false
          voiceSpaceCountRef.current = 0
          voiceReleaseTimerRef.current = null
          handleVoiceStop()
        }, timeout)
        return
      }

      // Typing refocuses to input
      if (attachmentFocusIndex >= 0) setAttachmentFocusIndex(-1)

      const offset = cursorOffsetRef.current
      const currentInput = inputRef.current || ''

      // Validate offset is within bounds
      const safeOffset = Math.max(0, Math.min(offset, currentInput.length))

      const newValue = currentInput.slice(0, safeOffset) + char + currentInput.slice(safeOffset)
      inputRef.current = newValue
      onInputChange(newValue)
      setCursorOffset(safeOffset + char.length)
    }
  })


  const columns = Math.max(40, process.stdout.columns || 80)

  return React.createElement(Box, { flexDirection: 'column' },
    // Attachment chips (above input)
    attachments.length > 0 && React.createElement(Box, {
      key: 'attachments-bar',
      flexDirection: 'row',
      marginLeft: 3,
      marginTop: 1,
      gap: 1,
      flexWrap: 'wrap',
    },
      ...attachments.map((att, i) => {
        const focused = attachmentFocusIndex === i
        return React.createElement(Box, {
          key: `att-${i}`,
          borderStyle: 'round',
          borderColor: focused ? '#FF9500' : '#3B3B3B',
          paddingX: 1,
        },
          React.createElement(Text, {
            color: focused ? '#FF9500' : '#A0A0A0',
            bold: focused,
          }, `📎 ${att.name}`),
          focused && React.createElement(Text, { dimColor: true }, ' ⌫')
        )
      })
    ),
    // Input box
    React.createElement(Box, {
      key: 'input-box',
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      borderColor: mode === 'bash' ? THEME.bashBorder : THEME.secondaryBorder,
      borderDimColor: true,
      borderStyle: 'round',
      marginTop: 1,
    },
      // Prompt indicator
      React.createElement(Box, {
        key: 'prompt',
        alignItems: 'flex-start',
        alignSelf: 'flex-start',
        flexWrap: 'nowrap',
        justifyContent: 'flex-start',
        width: 3
      },
        mode === 'bash'
          ? React.createElement(Text, { key: 'bash', color: THEME.bashBorder }, ' ! ')
          : React.createElement(Text, {
              key: 'normal',
              color: queuedMessage ? THEME.warning : isLoading ? THEME.secondaryText : undefined
            }, queuedMessage ? ' ⏳' : ' ❯ ')
      ),
      // Text input display (voice status shown as placeholder to avoid layout shift)
      React.createElement(Box, { key: 'input', paddingRight: 1, flexGrow: 1 },
        React.createElement(TextInputDisplay, {
          value: input,
          placeholder: voiceStatus === 'recording'
            ? '● Recording... (release Space to stop)'
            : voiceStatus === 'transcribing'
              ? '⏳ Transcribing...'
              : keyboardManager.voiceMode && !input
                ? 'Hold Space to speak...'
                : 'Ask Dario...',
          isDimmed: isDisabled || isLoading,
          cursorOffset: cursorOffset,
          color: voiceStatus === 'recording' ? 'red' : mode === 'bash' ? THEME.bashBorder : undefined,
        })
      )
    ),

    // Queued message indicator
    queuedMessage && React.createElement(Box, { key: 'queued-msg', paddingX: 2 },
      React.createElement(Text, { color: THEME.warning, dimColor: true },
        '⏳ Queued: ',
        typeof queuedMessage === 'string'
          ? queuedMessage.slice(0, 60)
          : queuedMessage.text.slice(0, 60),
        (typeof queuedMessage === 'string' ? queuedMessage : queuedMessage.text).length > 60 ? '…' : ''
      )
    ),

    // Status line / hints
    suggestions.length === 0 && (
      statusMode === STATUS_MODES.ACCEPT_EDITS
        // Default mode - show hints
        ? React.createElement(Box, {
            key: 'status-hints',
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingX: 2,
            paddingY: 0
          },
            React.createElement(Box, { key: 'left', justifyContent: 'flex-start', gap: 1 },
              exitMessage.show
                ? React.createElement(Text, { key: 'exit', dimColor: true },
                    'Press ', exitMessage.key, ' again to exit'
                  )
                : React.createElement(React.Fragment, { key: 'hints' },
                    React.createElement(Text, {
                      key: 'bash',
                      color: mode === 'bash' ? THEME.bashBorder : undefined,
                      dimColor: mode !== 'bash'
                    }, '! for bash mode'),
                    React.createElement(Text, { key: 'commands', dimColor: true },
                      transcriptIsWindowed
                        ? ' · / for commands · pgup/pgdn transcript · esc to undo'
                        : ' · / for commands · esc to undo'
                    )
                  )
            ),
            React.createElement(Box, { key: 'right', justifyContent: 'flex-end', gap: 1 },
              mcpStatus && React.createElement(React.Fragment, { key: 'mcp' },
                React.createElement(Text, { dimColor: true }, 'MCP:'),
                mcpStatus.connected > 0 && React.createElement(Text, { color: THEME.success }, String(mcpStatus.connected)),
                mcpStatus.total - mcpStatus.connected > 0 && React.createElement(Text, { color: '#6B7280' }, String(mcpStatus.total - mcpStatus.connected))
              ),
              mcpStatus && gitStats && React.createElement(Text, { key: 'sep1', dimColor: true }, ' · '),
              gitStats && React.createElement(React.Fragment, { key: 'git' },
                React.createElement(Text, { dimColor: true }, `${gitStats.files} files `),
                gitStats.insertions > 0 && React.createElement(Text, { color: THEME.success }, `+${gitStats.insertions} `),
                gitStats.deletions > 0 && React.createElement(Text, { color: THEME.error }, `-${gitStats.deletions}`)
              )
            )
          )
        // Non-default mode - show mode indicator with git stats
        : React.createElement(Box, {
            key: 'status-mode',
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingX: 2,
            paddingY: 0
          },
            React.createElement(Box, { key: 'left', justifyContent: 'flex-start' },
              React.createElement(Text, { key: 'arrows', color: getModeDisplay(statusMode).color }, '►► '),
              React.createElement(Text, { key: 'mode', color: getModeDisplay(statusMode).color },
                getModeDisplay(statusMode).label.toLowerCase(), ' on'
              ),
              React.createElement(Text, { key: 'hint', dimColor: true }, ' (shift+tab to cycle)'),
              gitStats && React.createElement(React.Fragment, { key: 'git' },
                React.createElement(Text, { dimColor: true }, ' · '),
                React.createElement(Text, { dimColor: true }, `${gitStats.files} files `),
                gitStats.insertions > 0 && React.createElement(Text, { color: THEME.success }, `+${gitStats.insertions} `),
                gitStats.deletions > 0 && React.createElement(Text, { color: THEME.error }, `-${gitStats.deletions}`)
              ),
              mcpStatus && React.createElement(React.Fragment, { key: 'mcp' },
                React.createElement(Text, { dimColor: true }, ' · MCP:'),
                mcpStatus.connected > 0 && React.createElement(Text, { color: THEME.success }, String(mcpStatus.connected)),
                mcpStatus.total - mcpStatus.connected > 0 && React.createElement(Text, { color: '#6B7280' }, String(mcpStatus.total - mcpStatus.connected))
              )
            )
          )
    ),

    // Suggestions (commands or files)
    suggestions.length > 0 && (() => {
      // Calculate visible window - show VISIBLE_SUGGESTIONS items at a time
      const totalSuggestions = suggestions.length
      const halfWindow = Math.floor(VISIBLE_SUGGESTIONS / 2)

      let startIdx = Math.max(0, selectedSuggestion - halfWindow)
      let endIdx = Math.min(totalSuggestions, startIdx + VISIBLE_SUGGESTIONS)

      // Adjust if we're at the end
      if (endIdx - startIdx < VISIBLE_SUGGESTIONS) {
        startIdx = Math.max(0, endIdx - VISIBLE_SUGGESTIONS)
      }

      const visibleSuggestions = suggestions.slice(startIdx, endIdx)
      const hasMore = totalSuggestions > VISIBLE_SUGGESTIONS

      return React.createElement(Box, {
        key: 'suggestions',
        flexDirection: 'column',
        paddingX: 2,
        paddingY: 0,
        borderStyle: 'single',
        borderColor: THEME.secondaryBorder,
        marginTop: 0
      },
        // Header
        React.createElement(Text, { key: 'header', dimColor: true, bold: true },
          suggestionMode === 'command' ? 'Commands' : 'Files',
          hasMore ? ` (${selectedSuggestion + 1}/${totalSuggestions})` : ` (${totalSuggestions})`,
          ' · ↑↓ select · Tab complete'
        ),
        // Suggestions list
        React.createElement(Box, { key: 'list', flexDirection: 'column', marginTop: 0 },
          visibleSuggestions.map((suggestion, visIdx) => {
            const idx = startIdx + visIdx
            const isSelected = idx === selectedSuggestion

            if (suggestionMode === 'command') {
              const cmd = commands.find(c => (c.userFacingName?.() || c.name) === suggestion)
              return React.createElement(Box, {
                key: `cmd-${idx}`,
                flexDirection: 'row'
              },
                React.createElement(Text, {
                  color: isSelected ? THEME.suggestion : undefined,
                  dimColor: !isSelected,
                  inverse: isSelected
                }, isSelected ? ' → ' : '   ', '/', suggestion),
                cmd && React.createElement(Text, {
                  color: isSelected ? THEME.suggestion : undefined,
                  dimColor: !isSelected
                }, '  ', cmd.description || '')
              )
            } else {
              // File suggestion
              return React.createElement(Box, {
                key: `file-${idx}`,
                flexDirection: 'row'
              },
                React.createElement(Text, {
                  color: isSelected ? THEME.success : undefined,
                  dimColor: !isSelected,
                  inverse: isSelected
                }, isSelected ? ' → ' : '   ', '@', suggestion)
              )
            }
          })
        )
      )
    })()
  )
}

// Memoize PromptInput like the bundle does
const MemoizedPromptInput = memo(PromptInput)

/**
 * Main Conversation App
 */
function ConversationApp({
  commands = [],
  dangerouslySkipPermissions = false,
  debug = false,
  initialForkNumber = 0,
  initialPrompt,
  initialPrNumber,
  currentSession,
  messageLogName,
  shouldShowPromptInput = true,
  tools = [],
  verbose = false,
  initialMessages = [],
  mcpClients = [],
  mcpSystemInstructions = '',
  isDefaultModel = true,
}) {
  const effectiveVerbose = verbose || loadConfig().verbose
  const { stdout } = useStdout()

  // State
  const [forkNumber, setForkNumber] = useState(initialForkNumber)
  const [abortController, setAbortController] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [queuedMessage, setQueuedMessage] = useState(null)
  const [pendingPlan, setPendingPlan] = useState(null)
  const [expandedToolResults, setExpandedToolResults] = useState(new Set())
  const [toolJSX, setToolJSX] = useState(null)
  const [messages, setMessages] = useState(initialMessages)
  const [transcriptWindowStart, setTranscriptWindowStart] = useState(null)
  const [mode, setMode] = useState('prompt')
  const [showMessageSelector, setShowMessageSelector] = useState(false)
  const [showModelSelector, setShowModelSelector] = useState(false)
  const [showAuthSelector, setShowAuthSelector] = useState(false)
  const [showFastModeToggle, setShowFastModeToggle] = useState(false)
  const [showMcpManager, setShowMcpManager] = useState(false)
  const [showConfigManager, setShowConfigManager] = useState(false)
  const [configSnapshot, setConfigSnapshot] = useState({})
  const [showApprovedToolsManager, setShowApprovedToolsManager] = useState(false)
  const [permissionsSnapshot, setPermissionsSnapshot] = useState({ allow: [], deny: [], ask: [] })
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [showPluginManager, setShowPluginManager] = useState(false)
  const [showProviderManager, setShowProviderManager] = useState(false)
  const [showAgentManager, setShowAgentManager] = useState(false)
  const [showToolsManager, setShowToolsManager] = useState(false)
  const [showContextManager, setShowContextManager] = useState(false)
  const [contextManagerItems, setContextManagerItems] = useState([])
  const [disabledContextItems, setDisabledContextItems] = useState(getDisabledContextItems())
  const [showSteeringQuestions, setShowSteeringQuestions] = useState(false)
  const [steeringQuestionsData, setSteeringQuestionsData] = useState(null)
  const [steeringResolve, setSteeringResolve] = useState(null)
  const [sessionList, setSessionList] = useState([])
  const [allProjectSessions, setAllProjectSessions] = useState(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [mcpServersState, setMcpServersState] = useState({})
  const [mcpClientsState, setMcpClientsState] = useState(mcpClients)
  const [fastMode, setFastModeState] = useState(isFastMode())
  const [bypassPermissions, setBypassPermissions] = useState(false)
  const [currentModel, setCurrentModel] = useState(
    loadConfig().model || 'claude-sonnet-4-6'
  )
  const [contextPercent, setContextPercent] = useState(0)

  // MCP status object for footer — { text, connected, total, hasLazy }
  const mcpStatus = useMemo(() => {
    const totalServers = Object.keys(mcpServersState).length
    if (totalServers === 0) return null
    const connectedCount = mcpClientsState.filter(c => c.type === 'connected').length
    const hasLazy = tools.some(t => t._lazy)
    return { connected: connectedCount, total: totalServers, hasLazy }
  }, [mcpServersState, mcpClientsState, tools])

  // Git diff stats for footer, refresh after messages change
  const [gitStats, setGitStats] = useState(null)
  useEffect(() => {
    setGitStats(getGitStats())
  }, [messages.length])

  // Context % for footer
  useEffect(() => {
    let cancelled = false
    const calculateContext = async () => {
      try {
        const total = await getTotalContextTokens(messages, tools)
        if (cancelled) return
        const limit = 200000
        setContextPercent(Math.round((total / limit) * 100))
      } catch(e) {}
    }
    const timer = setTimeout(calculateContext, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [messages.length])

  // Build MCP dependency object for config operations
  const mcpDeps = useMemo(() => ({
    getGlobalConfig: () => {
      try {
        const configPath = path.join(homedir(), '.dario', 'config.json')
        if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, 'utf8'))
      } catch {}
      return {}
    },
    getProjectConfig: () => {
      try {
        const configPath = path.join(process.cwd(), '.dario', 'config.json')
        if (existsSync(configPath)) return JSON.parse(readFileSync(configPath, 'utf8'))
      } catch {}
      return {}
    },
    setProjectConfig: (config) => {
      try {
        const dir = path.join(process.cwd(), '.dario')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
      } catch {}
    },
    setGlobalConfig: (config) => {
      try {
        const dir = path.join(homedir(), '.dario')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const configPath = path.join(dir, 'config.json')
        // Merge with existing config to avoid clobbering OAuth tokens etc.
        let existing = {}
        try { if (existsSync(configPath)) existing = JSON.parse(readFileSync(configPath, 'utf8')) } catch {}
        writeFileSync(configPath, JSON.stringify({ ...existing, ...config }, null, 2))
      } catch {}
    },
    getMcprcConfig: () => {
      try {
        const mcprcPath = path.join(process.cwd(), '.mcprc')
        if (existsSync(mcprcPath)) return JSON.parse(readFileSync(mcprcPath, 'utf8'))
      } catch {}
      return null
    },
    getCurrentDir: () => process.cwd(),
    fs: { existsSync, readFileSync, writeFileSync, mkdirSync },
    path,
    logEvent: () => {},
    logMcpServerMessage: (name, msg) => {
      if (process.env.DEBUG_TUI) console.error(`[MCP:${name}] ${msg}`)
    },
  }), [])

  // Initialize MCP servers list
  useEffect(() => {
    try {
      const servers = getAllMcpServers(mcpDeps)
      setMcpServersState(servers)
    } catch {}
  }, [])

  // Section 8: Wire onPlanApproved → context compaction (CC 2.1.x parity)
  // When the user accepts a plan, compact the conversation history so the
  // execution phase starts with a full context window.
  useEffect(() => {
    const unregister = onPlanApproved(async (plan) => {
      try {
        const { compactMessagesWithAi } = await import('../../utils/summarize.mjs')
        const planSummary = plan.description
          ? `[Plan approved: ${plan.title}]\n\n${plan.description}`
          : `[Plan approved: ${plan.title}]`
        const summaryMsg = createMessage('user', planSummary)
        const currentMsgs = []
        setMessages(prev => {
          const compacted = [summaryMsg]
          currentMsgs.push(...prev)
          return compacted
        })
        // Also run AI compaction on the previous messages to preserve key context
        if (currentMsgs.length > 0) {
          try {
            const compacted = await compactMessagesWithAi(currentMsgs, 0)
            const planMsg = createMessage('user', planSummary)
            setMessages([planMsg, ...compacted.slice(1)])
          } catch {
            // Keep the simple summary if compaction fails
          }
        }
      } catch {
        // Never crash the TUI due to plan compaction errors
      }
    })
    return unregister
  }, [])

  // Wire onPlanExit → show plan review UI
  useEffect(() => {
    const unregister = onPlanExit((plan) => {
      setPendingPlan(plan)
    })
    return unregister
  }, [])

  // Section 9: Skills hot-reload (CC 2.1.0 parity)
  // Watches .claude/skills/ directories and invalidates the skills cache on change.
  useEffect(() => {
    const cwd = process.cwd()
    startSkillsHotReload(cwd)
    const unregisterChanged = onSkillsChanged(() => {
      invalidateSkillsCache()
    })
    return () => {
      unregisterChanged()
      stopSkillsHotReload()
    }
  }, [])

  // MCP Manager handlers
  const handleMcpAddServer = useCallback((name, config) => {
    try {
      addMcpServer(name, config, 'project', mcpDeps)
      // Refresh server list
      const servers = getAllMcpServers(mcpDeps)
      setMcpServersState(servers)
    } catch (err) {
      const msg = createMessage('assistant', `✗ Failed to add server: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [mcpDeps])

  const handleMcpRemoveServer = useCallback((name) => {
    try {
      removeMcpServer(name, 'project', mcpDeps)
      const servers = getAllMcpServers(mcpDeps)
      setMcpServersState(servers)
    } catch (err) {
      // Try global scope
      try {
        removeMcpServer(name, 'global', mcpDeps)
        const servers = getAllMcpServers(mcpDeps)
        setMcpServersState(servers)
      } catch {
        const msg = createMessage('assistant', `✗ Failed to remove server: ${err.message}`)
        setMessages(prev => [...prev, msg])
      }
    }
  }, [mcpDeps])

  const handleMcpConnectServer = useCallback(async (name) => {
    const config = mcpServersState[name]
    if (!config) return
    try {
      const client = await connectToMcpServer(name, config, mcpDeps)
      setMcpClientsState(prev => [
        ...prev.filter(c => c.name !== name),
        { name, client, type: 'connected' }
      ])
      const msg = createMessage('assistant', `✓ Connected to MCP server "${name}"`)
      setMessages(prev => [...prev, msg])
    } catch (err) {
      setMcpClientsState(prev => [
        ...prev.filter(c => c.name !== name),
        { name, type: 'failed' }
      ])
      const msg = createMessage('assistant', `✗ Failed to connect to "${name}": ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [mcpServersState, mcpDeps])

  const handleMcpDisconnectServer = useCallback(async (name) => {
    const client = mcpClientsState.find(c => c.name === name && c.type === 'connected')
    if (client?.client) {
      try { await client.client.close() } catch {}
    }
    setMcpClientsState(prev => prev.filter(c => c.name !== name))
    const msg = createMessage('assistant', `✓ Disconnected from MCP server "${name}"`)
    setMessages(prev => [...prev, msg])
  }, [mcpClientsState])

  const handleMcpTestServer = useCallback(async (name) => {
    const client = mcpClientsState.find(c => c.name === name && c.type === 'connected')
    if (!client?.client) {
      const msg = createMessage('assistant', `✗ Server "${name}" is not connected`)
      setMessages(prev => [...prev, msg])
      return
    }
    try {
      // Use lenient schema — real servers may return non-standard inputSchema
      const result = await client.client.request(
        { method: 'tools/list' },
        { parse: (v) => v }
      )
      const toolCount = result.tools?.length || 0
      const msg = createMessage('assistant', `✓ Server "${name}" is healthy\n  Tools available: ${toolCount}`)
      setMessages(prev => [...prev, msg])
    } catch (err) {
      const msg = createMessage('assistant', `✗ Test failed for "${name}": ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [mcpClientsState])

  const handleMcpMessage = useCallback((text) => {
    const msg = createMessage('assistant', text)
    setMessages(prev => [...prev, msg])
  }, [])

  const handleMcpSetStartupMode = useCallback((name, mode) => {
    try {
      updateServerStartupMode(name, mode, mcpDeps)
      // Refresh server list to reflect new mode
      const servers = getAllMcpServers(mcpDeps)
      setMcpServersState(servers)
    } catch (err) {
      const msg = createMessage('assistant', `✗ Failed to set startup mode: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [mcpDeps])

  // Config Manager: snapshot on open, refresh after mutation
  const openConfigManager = useCallback(() => {
    setConfigSnapshot(loadConfig())
    setShowConfigManager(true)
  }, [])

  const handleConfigSet = useCallback((key, value) => {
    try {
      const config = loadConfig()
      config[key] = value
      saveConfig(config)
      setConfigSnapshot(loadConfig()) // refresh snapshot
    } catch (err) {
      const msg = createMessage('assistant', `✗ Failed to set config: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [])

  const handleConfigRemove = useCallback((key) => {
    try {
      const config = loadConfig()
      delete config[key]
      saveConfig(config)
      setConfigSnapshot(loadConfig()) // refresh snapshot
    } catch (err) {
      const msg = createMessage('assistant', `✗ Failed to remove config: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [])

  const handleConfigMessage = useCallback((text) => {
    const msg = createMessage('assistant', text)
    setMessages(prev => [...prev, msg])
  }, [])

  // Approved Tools Manager: snapshot on open, refresh after mutation
  const openApprovedToolsManager = useCallback(() => {
    const settings = loadSettings()
    setPermissionsSnapshot(settings.permissions || { allow: [], deny: [], ask: [] })
    setShowApprovedToolsManager(true)
  }, [])

  const handleRemoveAllowTool = useCallback((tool) => {
    try {
      const settings = loadSettings()
      const permissions = settings.permissions || { allow: [], deny: [], ask: [] }
      permissions.allow = permissions.allow.filter(t => t !== tool)
      settings.permissions = permissions
      saveSettings(settings)
      setPermissionsSnapshot({ ...permissions }) // refresh snapshot
    } catch (err) {
      const msg = createMessage('assistant', `✗ Failed to update permissions: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [])

  const handleRemoveDenyTool = useCallback((tool) => {
    try {
      const settings = loadSettings()
      const permissions = settings.permissions || { allow: [], deny: [], ask: [] }
      permissions.deny = permissions.deny.filter(t => t !== tool)
      settings.permissions = permissions
      saveSettings(settings)
      setPermissionsSnapshot({ ...permissions }) // refresh snapshot
    } catch (err) {
      const msg = createMessage('assistant', `✗ Failed to update permissions: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [])

  const handleApprovedToolsMessage = useCallback((text) => {
    const msg = createMessage('assistant', text)
    setMessages(prev => [...prev, msg])
  }, [])

  // Session Picker handler
  const handleSessionSelect = useCallback(async (session) => {
    setShowSessionPicker(false)
    try {
      const data = await sessions.getSession(session.id)
      if (data?.messages && data.messages.length > 0) {
        // Convert session messages { role, content, timestamp } to TUI format { type, uuid, message }
        const tuiMessages = data.messages.map(m => createMessage(m.role, m.content))
        setMessages(tuiMessages)
        const msg = createMessage('assistant', `\u2713 Resumed session: ${session.firstPrompt?.slice(0, 50) || session.name || session.id.slice(0, 8)}`)
        setMessages(prev => [...prev, msg])
      } else {
        const msg = createMessage('assistant', `\u2717 Session has no messages`)
        setMessages(prev => [...prev, msg])
      }
    } catch (err) {
      const msg = createMessage('assistant', `\u2717 Failed to resume session: ${err.message}`)
      setMessages(prev => [...prev, msg])
    }
  }, [])

  // Load sessions when picker opens
  const openSessionPicker = useCallback(async () => {
    setShowSessionPicker(true)
    setSessionsLoading(true)
    setAllProjectSessions(null)
    try {
      const list = await sessions.listSessions({ limit: 50 })
      setSessionList(list)
    } catch {
      setSessionList([])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  // Open context manager: build item list from current state
  const openContextManager = useCallback(async () => {
    const est = (text) => Math.ceil((text || '').length / 4)
    const items = []

    // System prompt
    const systemIntro = getSystemPromptIntro()
    const systemInstructions = await getSystemInstructions()
    const systemText = [systemIntro, ...systemInstructions].join('\n')
    items.push({
      id: 'systemPrompt',
      label: 'System prompt',
      tokens: est(systemText),
      locked: true,  // Cannot disable core system prompt
    })

    // System tools
    const mcpToolNames = new Set()
    for (const t of tools) {
      if (t.name?.startsWith('mcp__') || t._lazy) mcpToolNames.add(t.name)
    }
    const systemToolsList = tools.filter(t => !mcpToolNames.has(t.name))
    const toolsTokens = systemToolsList.reduce((s, t) => {
      const desc = typeof t.description === 'string' ? t.description : t.name
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : ''
      return s + est(t.name + desc + schema)
    }, 0)
    items.push({
      id: 'tools',
      label: `System tools (${systemToolsList.length})`,
      tokens: toolsTokens,
    })

    // MCP tools
    const mcpToolsList = tools.filter(t => mcpToolNames.has(t.name))
    if (mcpToolsList.length > 0) {
      const mcpTokens = mcpToolsList.reduce((s, t) => {
        const desc = typeof t.description === 'string' ? t.description : t.name
        const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : ''
        return s + est(t.name + desc + schema)
      }, 0)
      items.push({
        id: 'mcpTools',
        label: `MCP tools (${mcpToolsList.length})`,
        tokens: mcpTokens,
      })
    }

    // Memory files (individually toggleable)
    const { loadClaudeMd } = await import('../../core/config.mjs')
    const claudeFiles = loadClaudeMd(process.cwd())
    for (const f of claudeFiles) {
      items.push({
        id: `memory:${f.source}`,
        label: `Memory: ${f.source} (${f.path.split('/').pop()})`,
        tokens: est(f.content),
      })
    }

    // Custom context items
    const customItems = getCustomContextItems()
    for (const ci of customItems) {
      items.push({
        id: ci.id,
        label: ci.label,
        tokens: est(ci.content),
        isCustom: true,
      })
    }

    // Conversation
    const convTokens = messages.reduce((s, msg) => {
      const content = msg.message?.content || msg.content
      const text = typeof content === 'string' ? content : JSON.stringify(content)
      return s + est(text)
    }, 0)
    items.push({
      id: 'conversation',
      label: `Conversation (${messages.length} msgs)`,
      tokens: convTokens,
      locked: true,  // Cannot disable conversation
    })

    setContextManagerItems(items)
    setDisabledContextItems(getDisabledContextItems())
    setShowContextManager(true)
  }, [tools, messages])

  // Open steering questions overlay — returns a Promise that resolves with answers
  const openSteeringQuestions = useCallback((questionsData) => {
    return new Promise((resolve) => {
      setSteeringQuestionsData(questionsData)
      setSteeringResolve(() => resolve)
      setShowSteeringQuestions(true)
    })
  }, [])

  // Load sessions from all projects (Ctrl+A in picker)
  const loadAllProjectSessions = useCallback(async () => {
    try {
      const all = await sessions.listAllProjectSessions({ limit: 100 })
      setAllProjectSessions(all)
    } catch {
      setAllProjectSessions([])
    }
  }, [])

  // Preview a session (Ctrl+V in picker) — load full messages for preview
  const handleSessionPreview = useCallback(async (session) => {
    if (session.messages && session.messages.length > 0) return
    try {
      const data = await sessions.getSession(session.id)
      if (data?.messages) {
        session.messages = data.messages
      }
    } catch {
      // Preview will show empty if load fails
    }
  }, [])

  // Rename a session (Ctrl+R in picker)
  const handleSessionRename = useCallback(async (session, newName) => {
    try {
      await sessions.updateSession(session.id, { name: newName })
      // Update the local session list
      setSessionList(prev => prev.map(s =>
        s.id === session.id ? { ...s, name: newName, firstPrompt: newName } : s
      ))
      if (allProjectSessions) {
        setAllProjectSessions(prev => prev?.map(s =>
          s.id === session.id ? { ...s, name: newName, firstPrompt: newName } : s
        ))
      }
    } catch {
      // Rename failed silently
    }
  }, [allProjectSessions])

  // Abort operation
  const cancelOperation = useCallback(() => {
    if (!isLoading) return
    setIsLoading(false)
    setQueuedMessage(null)
    abortController?.abort()
  }, [isLoading, abortController])

  // Toggle expand/collapse on a tool result (Ctrl+O)
  const toggleToolResultExpand = useCallback((toolUseId) => {
    setExpandedToolResults(prev => {
      const next = new Set(prev)
      if (next.has(toolUseId)) next.delete(toolUseId)
      else next.add(toolUseId)
      return next
    })
  }, [])

  const handlePlanAccept = useCallback(() => {
    if (!pendingPlan) return
    approvePlan(pendingPlan.id)
    setPendingPlan(null)
    const msg = createMessage('assistant', `✓ Plan accepted — beginning implementation`)
    setMessages(prev => [...prev, msg])
  }, [pendingPlan])

  const handlePlanReject = useCallback(() => {
    if (!pendingPlan) return
    cancelPlan(pendingPlan.id)
    setPendingPlan(null)
    const msg = createMessage('assistant', `✗ Plan rejected`)
    setMessages(prev => [...prev, msg])
  }, [pendingPlan])

  useInput((char, key) => {
    if (!pendingPlan) return
    if (char === 'y' || char === 'Y') {
      handlePlanAccept()
    } else if (char === 'n' || char === 'N' || key.escape) {
      handlePlanReject()
    }
  }, { isActive: !!pendingPlan })

  // Ctrl+B — unified background (CC 2.1 parity)
  // Backgrounds both the current bash command AND any running agent simultaneously.
  // The operation continues running; the user gets their prompt back immediately.
  const backgroundAll = useCallback(() => {
    if (!isLoading) return
    // Signal the abort controller with a 'background' reason so the streaming
    // loop can distinguish between cancel (stop) and background (continue async).
    if (abortController) {
      abortController.signal._backgrounded = true
      abortController.abort()
    }
    setIsLoading(false)
    const msg = createMessage('assistant', '[Backgrounded — operation continues running. Use /tasks to check progress.]')
    setMessages(prev => [...prev, msg])
  }, [isLoading, abortController])

  // Handle user query — accepts string or { text, attachments }
  const handleQuery = useCallback(async (queryInput) => {
    if (!queryInput || isLoading) return

    // Extract text and attachments
    let queryText, queryAttachments = []
    if (typeof queryInput === 'object' && queryInput.text !== undefined) {
      queryText = queryInput.text
      queryAttachments = queryInput.attachments || []
    } else {
      queryText = queryInput
    }

    if (!queryText && queryAttachments.length === 0) return

    // Handle slash commands (text only, no attachments)
    if (queryText && queryText.startsWith('/')) {
      const parts = queryText.slice(1).split(/\s+/)
      const cmdName = parts[0].toLowerCase()
      const cmdArgs = parts.slice(1).join(' ')

      // Find command
      const cmd = commands.find(c =>
        c.name === cmdName ||
        c.userFacingName?.() === cmdName ||
        c.aliases?.includes(cmdName)
      )

      if (cmd) {
        // Show user input
        const userMessage = createMessage('user', queryText)
        setMessages(prev => [...prev, userMessage])

        try {
          const result = await cmd.call?.(null, {
            args: cmdArgs ? cmdArgs.split(/\s+/) : [],
            getMessages: () => messages,
            setMessages: (newMessages) => setMessages(newMessages),
            clearMessages: () => setMessages([]),
            tools,
            mcpServers: mcpServersState,
            mcpClients: mcpClientsState,
            showModelSelector: () => setShowModelSelector(true),
            showAuthSelector: () => setShowAuthSelector(true),
            showFastModeToggle: () => setShowFastModeToggle(true),
            showMcpManager: () => setShowMcpManager(true),
            showConfigManager: () => openConfigManager(),
            showApprovedToolsManager: () => openApprovedToolsManager(),
            showSessionPicker: () => openSessionPicker(),
            showPluginManager: () => setShowPluginManager(true),
            showProviderManager: () => setShowProviderManager(true),
            showAgentManager: () => setShowAgentManager(true),
            showToolsManager: () => setShowToolsManager(true),
            showContextManager: () => openContextManager(),
            showSteeringQuestions: (data) => openSteeringQuestions(data),
            submitMessage: (text) => setTimeout(() => handleQuery(text), 50),
          })

          // Handle command result
          if (result) {
            // Check if result is a special action
            if (typeof result === 'object' && result.action === 'clear_messages') {
              setMessages([])
              return
            }
            if (typeof result === 'object' && result.action === 'compact_messages') {
              // Compact command returned compacted messages for us to apply
              if (result.compacted) {
                setMessages(result.compacted)
                const msg = createMessage('assistant', `✓ Compacted conversation: ${result.removed} older messages summarized`)
                setMessages(prev => [...prev, msg])
              } else if (result.error) {
                const msg = createMessage('assistant', result.error)
                setMessages(prev => [...prev, msg])
              }
              return
            }
            // Show command result as assistant message
            const assistantMessage = createMessage('assistant', result)
            setMessages(prev => [...prev, assistantMessage])
          }
        } catch (e) {
          const errorMessage = createMessage('assistant', `Command error: ${e.message}`)
          setMessages(prev => [...prev, errorMessage])
        }
        return
      } else {
        // Unknown command - show error
        const userMessage = createMessage('user', queryText)
        const errorMessage = createMessage('assistant', `Unknown command: /${cmdName}\nType /help for available commands.`)
        setMessages(prev => [...prev, userMessage, errorMessage])
        return
      }
    }

    setIsLoading(true)
    const controller = new AbortController()
    setAbortController(controller)

    try {
      let currentMessages = [...messages];

      // Auto-compaction check (CC 2.x feature — threshold configurable via compactThreshold)
      const autoCompactThresholdPct = Math.round(getCompactThreshold() * 100)
      if (contextPercent > autoCompactThresholdPct && currentMessages.length > 10) {
        const { compactMessagesWithAi } = await import('../../utils/summarize.mjs');
        const compactingMsg = createMessage('assistant', 'Context is getting full, compacting conversation history...');
        setMessages(prev => [...prev, compactingMsg]);
        
        const compacted = await compactMessagesWithAi(currentMessages);
        const removedCount = currentMessages.length - compacted.length;
        
        if (removedCount > 0) {
          const confirmationMsg = createMessage('assistant', `✓ Compacted ${removedCount} older messages.`);
          setMessages([...compacted, confirmationMsg]);
          currentMessages = [...compacted, confirmationMsg];
        } else {
          // Remove the 'compacting...' message if it failed
          setMessages(currentMessages);
        }
      }

      // Create user message — multipart content if files attached
      let userContent
      if (queryAttachments.length > 0) {
        const { processImage } = await import('../../core/utils.mjs')
        const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])
        const contentBlocks = []
        for (const att of queryAttachments) {
          const ext = path.extname(att.path).toLowerCase()
          if (IMAGE_EXTS.has(ext)) {
            try {
              const imageBlock = await processImage(att.path)
              contentBlocks.push(imageBlock)
            } catch (e) {
              contentBlocks.push({ type: 'text', text: `[Failed to load image: ${att.name} — ${e.message}]` })
            }
          } else {
            try {
              const fileContent = readFileSync(att.path, 'utf8')
              contentBlocks.push({ type: 'text', text: `<file path="${att.path}">\n${fileContent}\n</file>` })
            } catch (e) {
              contentBlocks.push({ type: 'text', text: `[Failed to load file: ${att.name} — ${e.message}]` })
            }
          }
        }
        if (queryText) {
          contentBlocks.push({ type: 'text', text: queryText })
        }
        userContent = contentBlocks
      } else {
        userContent = queryText
      }
      const userMessage = createMessage('user', userContent)
      setMessages(prev => [...prev, userMessage])

      // Get system prompts (REQUIRED for OAuth!)
      const systemIntro = getSystemPromptIntro()
      const systemInstructions = await getSystemInstructions()
      const systemPrompts = [systemIntro, ...systemInstructions]

      // Inject MCP server instructions if available
      if (mcpSystemInstructions) {
        systemPrompts.push(mcpSystemInstructions)
      }

      // Filter tools based on disabled context items
      const ctxDisabled = getDisabledContextItems()
      let activeTools = tools
      if (ctxDisabled['tools'] || ctxDisabled['mcpTools']) {
        activeTools = tools.filter(t => {
          const isMcp = t.name?.startsWith('mcp__') || t._lazy
          if (isMcp && ctxDisabled['mcpTools']) return false
          if (!isMcp && ctxDisabled['tools']) return false
          return true
        })
      }

      // Stream conversation
      for await (const assistantMessage of streamConversation(
        [...currentMessages, userMessage],
        systemPrompts,
        activeTools,
        {
          verbose: effectiveVerbose,
          model: currentModel,
          fastMode,
          dangerouslySkipPermissions: dangerouslySkipPermissions || bypassPermissions,
        },
        controller
      )) {
        setMessages(prev => {
          // Replace or add assistant message
          const lastIdx = prev.findIndex(m =>
            m.type === 'assistant' && m.uuid === assistantMessage.uuid
          )
          if (lastIdx >= 0) {
            const updated = [...prev]
            updated[lastIdx] = assistantMessage
            return updated
          }
          return [...prev, assistantMessage]
        })
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        // Show error as assistant message with helpful context
        const errorText = error.message || formatError(error) || 'Unknown error occurred'

        const config = loadConfig()
        const usingClaudeSubscriptionOAuth =
          config.oauthMode === 'claude' &&
          !config.primaryApiKey &&
          !config.apiKey &&
          !process.env.ANTHROPIC_API_KEY

        let helpText = ''
        if (usingClaudeSubscriptionOAuth &&
            errorText.includes('400') &&
            errorText.includes('"type":"invalid_request_error"')) {
          helpText = '\n\nClaude Max/Pro OAuth authenticated successfully, but Anthropic is rejecting direct public API requests from this app. Use Console OAuth or a saved ANTHROPIC_API_KEY instead.'
        } else if (errorText.includes('API_KEY') || errorText.includes('authentication')) {
          helpText = '\n\nPlease set or save ANTHROPIC_API_KEY, or run /auth to authenticate with OAuth.'
        } else if (errorText.includes('"type":"permission_error"')) {
          helpText = '\n\nThe current credential does not have permission for this API path. If you are using Claude Max/Pro OAuth, use Console OAuth or a saved ANTHROPIC_API_KEY instead.'
        } else if (errorText.includes('ENOENT') || errorText.includes('not found')) {
          helpText = '\n\nThe requested file or resource could not be found.'
        } else if (errorText.includes('EACCES')) {
          helpText = '\n\nPermission denied. Check file permissions.'
        } else if (errorText.includes('network') || errorText.includes('ECONNREFUSED')) {
          helpText = '\n\nNetwork error. Check your internet connection.'
        }

        const errorMessage = createMessage('assistant', `❌ Error: ${errorText}${helpText}`)
        setMessages(prev => [...prev, errorMessage])

        // Log full error for debugging
        if (debug) {
          console.error('[TUI] Full error:', error)
        }
      }
    } finally {
      setIsLoading(false)
      setAbortController(null)
      // Auto-submit queued message if one exists
      if (queuedMessage) {
        const msg = queuedMessage
        setQueuedMessage(null)
        setTimeout(() => handleQuery(msg), 0)
      }
    }
  }, [messages, tools, effectiveVerbose, isLoading, commands, currentModel, bypassPermissions, dangerouslySkipPermissions, queuedMessage])

  // Run initial prompt
  useEffect(() => {
    if (initialPrompt) {
      handleQuery(initialPrompt)
    }
  }, [])

  // REMOVED: useInput hook that was blocking PromptInput's keyboard handling
  // Escape-during-loading is now handled by PromptInput itself

  // Normalized messages for rendering
  const normalizedMessages = useMemo(() =>
    normalizeMessages(messages).filter(m => m.type !== 'progress'),
    [messages]
  )

  const showWelcomeChrome = normalizedMessages.length === 0 && !isLoading && !initialPrompt
  const terminalRows = Math.max(20, stdout?.rows || process.stdout.rows || 24)
  const reservedRows = showWelcomeChrome ? 18 : 8
  const transcriptWindowSize = Math.max(
    MIN_TRANSCRIPT_WINDOW_SIZE,
    Math.min(MAX_TRANSCRIPT_WINDOW_SIZE, terminalRows - reservedRows)
  )
  const transcriptScrollStep = Math.max(4, Math.floor(transcriptWindowSize / 2))

  const maxTranscriptWindowStart = Math.max(0, normalizedMessages.length - transcriptWindowSize)
  const clampedTranscriptStart = transcriptWindowStart === null
    ? maxTranscriptWindowStart
    : Math.max(0, Math.min(transcriptWindowStart, maxTranscriptWindowStart))

  const visibleTranscriptMessages = normalizedMessages.slice(
    clampedTranscriptStart,
    clampedTranscriptStart + transcriptWindowSize
  )
  const hiddenAboveCount = clampedTranscriptStart
  const hiddenBelowCount = Math.max(
    0,
    normalizedMessages.length - (clampedTranscriptStart + visibleTranscriptMessages.length)
  )
  const transcriptIsWindowed = hiddenAboveCount > 0 || hiddenBelowCount > 0

  const pageTranscriptUp = useCallback(() => {
    setTranscriptWindowStart((prev) => {
      const current = prev === null
        ? maxTranscriptWindowStart
        : Math.max(0, Math.min(prev, maxTranscriptWindowStart))
      if (current <= 0) return 0
      return Math.max(0, current - transcriptScrollStep)
    })
  }, [maxTranscriptWindowStart, transcriptScrollStep])

  const pageTranscriptDown = useCallback(() => {
    setTranscriptWindowStart((prev) => {
      if (prev === null) return null
      const current = Math.max(0, Math.min(prev, maxTranscriptWindowStart))
      const next = current + transcriptScrollStep
      return next >= maxTranscriptWindowStart ? null : next
    })
  }, [maxTranscriptWindowStart, transcriptScrollStep])

  const jumpTranscriptToLatest = useCallback(() => {
    setTranscriptWindowStart(null)
  }, [])

  return React.createElement(Box, { flexDirection: 'column' },
    showWelcomeChrome && React.createElement(Box, {
      flexDirection: 'column',
      key: `logo${forkNumber}`
    },
      React.createElement(WelcomeBanner, {
        mcpClients,
        isDefaultModel,
        model: currentModel
      }),
      React.createElement(WorkspaceTips, {
        workspaceDir: process.cwd()
      })
    ),

    transcriptIsWindowed
      ? React.createElement(Box, { key: 'transcript-window-hint', paddingX: 2, marginBottom: 1 },
          React.createElement(Text, { dimColor: true },
            hiddenAboveCount > 0 ? `↑ ${hiddenAboveCount} older messages hidden` : '',
            hiddenAboveCount > 0 && hiddenBelowCount > 0 ? ' · ' : '',
            hiddenBelowCount > 0 ? `↓ ${hiddenBelowCount} newer messages hidden` : '',
            ' · PgUp/PgDn navigate · End jumps latest'
          )
        )
      : null,

    ...visibleTranscriptMessages.map((msg, idx) =>
      React.createElement(Box, { key: msg.uuid || `msg-${clampedTranscriptStart + idx}`, width: '100%' },
        React.createElement(MemoizedMessageRenderer, {
          message: msg,
          tools,
          verbose: effectiveVerbose,
          debug,
          addMargin: true,
          shouldShowDot: true,
          expandedToolResults,
        })
      )
    ),

    // Loading indicator
    !toolJSX && isLoading ? React.createElement(LoadingSpinner, { key: 'loading' }) : null,

    // Plan review overlay — shown after ExitPlanMode fires
    pendingPlan
      ? React.createElement(PlanDisplay, {
          key: 'plan-display',
          plan: pendingPlan,
          onAccept: handlePlanAccept,
          onReject: handlePlanReject,
        })
      : null,

    // Tool JSX (overlays)
    toolJSX?.jsx ? React.cloneElement(toolJSX.jsx, { key: 'tool-jsx' }) : null,

    // Model Selector Overlay
    showModelSelector
      ? React.createElement(ModelSelector, {
          key: 'model-selector',
          currentModel,
          onSelect: (model) => {
            setCurrentModel(model.id)
            setShowModelSelector(false)
            // Update config
            const config = loadConfig()
            saveConfig({ ...config, model: model.id })
            // Show confirmation
            const msg = createMessage('assistant', `✓ Switched to ${model.name}\n  Model ID: ${model.id}`)
            setMessages(prev => [...prev, msg])
          },
          onCancel: () => setShowModelSelector(false)
        })
      : null,

    // Fast Mode Toggle Overlay
    showFastModeToggle
      ? React.createElement(FastModeToggle, {
          key: 'fast-mode-toggle',
          onConfirm: ({ enabled }) => {
            setFastMode(enabled)
            setFastModeState(enabled)
            setShowFastModeToggle(false)
            if (enabled) {
              // Switch model to Opus 4.6
              setCurrentModel(getFastModeModel())
              const config = loadConfig()
              saveConfig({ ...config, model: getFastModeModel() })
              const msg = createMessage('assistant', `↯ Fast mode ON · model set to ${getFastModeDisplayName()}`)
              setMessages(prev => [...prev, msg])
            } else {
              const msg = createMessage('assistant', 'Fast mode OFF')
              setMessages(prev => [...prev, msg])
            }
          },
          onCancel: () => setShowFastModeToggle(false)
        })
      : null,

    // Auth Selector Overlay
    showAuthSelector
      ? React.createElement(AuthSelector, {
          key: 'auth-selector',
          onSelect: async (option) => {
            setShowAuthSelector(false)
            // Set OAuth mode based on selection
            setOAuthMode(option.id)
            // Show authenticating message
            const authMsg = createMessage('assistant', `Authenticating with ${option.name}...\nOpening browser...\n\nIMPORTANT: After authorizing, paste the code in your terminal (not here!)`)
            setMessages(prev => [...prev, authMsg])

            // Perform OAuth - this will handle stdin/stdout directly
            try {
              await authenticateWithOAuth()
              // Reset client so it picks up the new token
              resetClient()
              const successMsg = createMessage('assistant', `✓ Successfully authenticated with ${option.name}!\nYou can now use the API.`)
              setMessages(prev => [...prev, successMsg])
            } catch (error) {
              const errorMsg = createMessage('assistant', `✗ Authentication failed: ${error.message}\n\nAlternatively, set or save ANTHROPIC_API_KEY`)
              setMessages(prev => [...prev, errorMsg])
            }
          },
          onCancel: () => setShowAuthSelector(false)
        })
      : null,

    // MCP Manager Overlay
    showMcpManager
      ? React.createElement(McpManager, {
          key: 'mcp-manager',
          servers: mcpServersState,
          clients: mcpClientsState,
          onAddServer: handleMcpAddServer,
          onRemoveServer: handleMcpRemoveServer,
          onConnectServer: handleMcpConnectServer,
          onDisconnectServer: handleMcpDisconnectServer,
          onTestServer: handleMcpTestServer,
          onSetStartupMode: handleMcpSetStartupMode,
          onCancel: () => setShowMcpManager(false),
          onMessage: handleMcpMessage,
        })
      : null,

    // Config Manager Overlay
    showConfigManager
      ? React.createElement(ConfigManager, {
          key: 'config-manager',
          config: configSnapshot,
          onSet: handleConfigSet,
          onRemove: handleConfigRemove,
          onCancel: () => setShowConfigManager(false),
          onMessage: handleConfigMessage,
        })
      : null,

    // Approved Tools Manager Overlay
    showApprovedToolsManager
      ? React.createElement(ApprovedToolsManager, {
          key: 'approved-tools-manager',
          permissions: permissionsSnapshot,
          onRemoveAllow: handleRemoveAllowTool,
          onRemoveDeny: handleRemoveDenyTool,
          onCancel: () => setShowApprovedToolsManager(false),
          onMessage: handleApprovedToolsMessage,
        })
      : null,

    // Session Picker Overlay
    showSessionPicker
      ? React.createElement(SessionPicker, {
          key: 'session-picker',
          sessions: sessionList,
          allSessions: allProjectSessions,
          isLoading: sessionsLoading,
          onSelect: handleSessionSelect,
          onCancel: () => setShowSessionPicker(false),
          onLoadAllProjects: loadAllProjectSessions,
          onPreview: handleSessionPreview,
          onRename: handleSessionRename,
        })
      : null,

    // Plugin Manager Overlay
    showPluginManager
      ? React.createElement(PluginManager, {
          key: 'plugin-manager',
          installedPlugins: getRegisteredPlugins().map(name => {
            const manifest = loadPluginManifest(name)
            return {
              name,
              version: manifest?.version || 'unknown',
              status: getPluginStatus(name),
              description: manifest?.description || '',
            }
          }),
          onInstall: async (pluginName) => {
            const samplePath = getSamplePluginPath(pluginName)
            if (samplePath) {
              await installFromLocal(samplePath)
            } else {
              await installFromNpm(pluginName)
            }
          },
          onUninstall: async (pluginName) => {
            await uninstallPlugin(pluginName)
          },
          onEnable: (pluginName) => {
            registryEnablePlugin(pluginName)
          },
          onDisable: (pluginName) => {
            registryDisablePlugin(pluginName)
          },
          onCancel: () => setShowPluginManager(false),
          onMessage: (msg) => {
            const assistantMessage = createMessage('assistant', msg)
            setMessages(prev => [...prev, assistantMessage])
          },
        })
      : null,

    // Provider Manager Overlay
    showProviderManager
      ? React.createElement(ProviderManager, {
          key: 'provider-manager',
          onCancel: () => setShowProviderManager(false),
          onMessage: (msg) => {
            const assistantMessage = createMessage('assistant', msg)
            setMessages(prev => [...prev, assistantMessage])
          },
        })
      : null,

    // Agent Manager Overlay
    showAgentManager
      ? React.createElement(AgentManager, {
          key: 'agent-manager',
          tools,
          onCancel: () => setShowAgentManager(false),
          onMessage: (msg) => {
            const assistantMessage = createMessage('assistant', msg)
            setMessages(prev => [...prev, assistantMessage])
          },
          onDeleteAgent: (agentName) => {
            deleteCustomAgent(agentName)
          },
        })
      : null,

    // Tools Manager Overlay
    showToolsManager
      ? React.createElement(ToolsManager, {
          key: 'tools-manager',
          tools,
          onCancel: () => setShowToolsManager(false),
          onMessage: (msg) => {
            const assistantMessage = createMessage('assistant', msg)
            setMessages(prev => [...prev, assistantMessage])
          },
        })
      : null,

    // Context Manager Overlay
    showContextManager
      ? React.createElement(ContextManager, {
          key: 'context-manager',
          contextItems: contextManagerItems,
          disabledItems: disabledContextItems,
          onToggle: (itemId) => {
            const newDisabled = toggleContextItem(itemId)
            setDisabledContextItems(getDisabledContextItems())
            const label = contextManagerItems.find(i => i.id === itemId)?.label || itemId
            const msg = createMessage('assistant',
              newDisabled
                ? `○ Disabled context: ${label}`
                : `● Enabled context: ${label}`
            )
            setMessages(prev => [...prev, msg])
          },
          onAdd: async (type, value) => {
            try {
              let label, content, source
              if (type === 'file') {
                const filePath = value.startsWith('~') ? value.replace('~', homedir()) : value
                if (!existsSync(filePath)) {
                  const msg = createMessage('assistant', `✗ File not found: ${value}`)
                  setMessages(prev => [...prev, msg])
                  return
                }
                content = readFileSync(filePath, 'utf-8')
                label = `File: ${basename(filePath)}`
                source = filePath
              } else if (type === 'url') {
                try {
                  const resp = await fetch(value)
                  content = await resp.text()
                  // Rough HTML-to-text: strip tags
                  content = content.replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                  if (content.length > 50000) content = content.slice(0, 50000) + '\n...(truncated)'
                  label = `URL: ${new URL(value).hostname}${new URL(value).pathname.slice(0, 30)}`
                  source = value
                } catch (e) {
                  const msg = createMessage('assistant', `✗ Failed to fetch URL: ${e.message}`)
                  setMessages(prev => [...prev, msg])
                  return
                }
              } else if (type === 'docs') {
                // Use Context7 MCP if available, otherwise store as text note
                const c7Tool = tools.find(t => t.name === 'mcp__plugin_compound-engineering_context7__resolve-library-id')
                if (c7Tool) {
                  label = `Docs: ${value}`
                  content = `[Context7 docs search pending: "${value}" — will be resolved on next API call]`
                  source = `context7:${value}`
                } else {
                  label = `Docs: ${value}`
                  content = `Documentation reference: ${value}`
                  source = `docs:${value}`
                }
              } else {
                // text note
                label = `Note: ${value.slice(0, 40)}${value.length > 40 ? '...' : ''}`
                content = value
                source = 'text'
              }

              const entry = addCustomContextItem({ type, label, source, content })
              const msg = createMessage('assistant', `✓ Added context: ${label}`)
              setMessages(prev => [...prev, msg])
              // Refresh the manager items
              openContextManager()
            } catch (e) {
              const msg = createMessage('assistant', `✗ Error adding context: ${e.message}`)
              setMessages(prev => [...prev, msg])
            }
          },
          onRemove: (itemId) => {
            const label = contextManagerItems.find(i => i.id === itemId)?.label || itemId
            const removed = removeCustomContextItem(itemId)
            if (removed) {
              const msg = createMessage('assistant', `✓ Removed context: ${label}`)
              setMessages(prev => [...prev, msg])
              // Refresh the manager items
              openContextManager()
            }
          },
          onCancel: () => setShowContextManager(false),
          onMessage: (msg) => {
            const assistantMessage = createMessage('assistant', msg)
            setMessages(prev => [...prev, assistantMessage])
          },
        })
      : null,

    // Steering Questions Overlay
    showSteeringQuestions && steeringQuestionsData
      ? React.createElement(SteeringQuestions, {
          key: 'steering-questions',
          questions: steeringQuestionsData,
          onSubmit: (answers) => {
            setShowSteeringQuestions(false)
            setSteeringQuestionsData(null)
            if (steeringResolve) {
              steeringResolve(answers)
              setSteeringResolve(null)
            }
            // Format answers into a readable message
            const lines = Object.entries(answers).map(([id, val]) => {
              const q = steeringQuestionsData.find(q => q.id === id)
              const header = q?.header || id
              const display = Array.isArray(val) ? val.join(', ') : val
              return `  ${header}: ${display}`
            })
            if (lines.length > 0) {
              const msg = createMessage('assistant', `✓ Steering answers:\n${lines.join('\n')}`)
              setMessages(prev => [...prev, msg])
            }
          },
          onCancel: () => {
            setShowSteeringQuestions(false)
            setSteeringQuestionsData(null)
            if (steeringResolve) {
              steeringResolve(null)
              setSteeringResolve(null)
            }
          },
          onChat: (question, tabIndex) => {
            // Close overlay and inject the question into conversation
            setShowSteeringQuestions(false)
            setSteeringQuestionsData(null)
            if (steeringResolve) {
              steeringResolve(null)
              setSteeringResolve(null)
            }
            const chatMsg = createMessage('user', `Help me decide: ${question.question}`)
            setMessages(prev => [...prev, chatMsg])
            handleQuery(`Help me decide: ${question.question}`)
          },
        })
      : null,

    // Message Selector Overlay
    showMessageSelector
      ? React.createElement(MessageSelector, {
          key: 'message-selector',
          messages,
          onSelect: (messageIndex) => {
            // Fork conversation from selected message
            setForkNumber(n => n + 1)
            setMessages(prev => prev.slice(0, messageIndex + 1))
            setShowMessageSelector(false)
            // Show confirmation
            const msg = createMessage('assistant', `✓ Conversation forked from message ${messageIndex + 1}`)
            setMessages(prev => [...prev, msg])
          },
          onCancel: () => setShowMessageSelector(false)
        })
      : null,

    // Prompt input
    !pendingPlan && !toolJSX?.shouldHidePromptInput && shouldShowPromptInput && !showMessageSelector && !showModelSelector && !showAuthSelector && !showFastModeToggle && !showMcpManager && !showConfigManager && !showApprovedToolsManager && !showSessionPicker && !showPluginManager && !showProviderManager && !showAgentManager && !showToolsManager && !showContextManager && !showSteeringQuestions
      ? React.createElement(MemoizedPromptInput, {
          key: 'prompt-input',
          commands,
          tools,
          isDisabled: false,
          isLoading,
          onQuery: handleQuery,
          onCancel: cancelOperation,
          debug,
          verbose: effectiveVerbose,
          messages,
          mode,
          onModeChange: setMode,
          onShowMessageSelector: () => setShowMessageSelector(s => !s),
          mcpStatus,
          gitStats,
          onBypassPermissionsChange: setBypassPermissions,
          queuedMessage,
          setQueuedMessage,
          expandedToolResults,
          onToggleToolResultExpand: toggleToolResultExpand,
          onTranscriptPageUp: pageTranscriptUp,
          onTranscriptPageDown: pageTranscriptDown,
          onTranscriptJumpToLatest: jumpTranscriptToLatest,
          transcriptIsWindowed,
        })
      : null,

    // Prompt footer (CC 2.x feature)
      !pendingPlan && !isLoading && !toolJSX?.shouldHidePromptInput && shouldShowPromptInput && !showMessageSelector && !showModelSelector && !showAuthSelector && !showFastModeToggle && !showMcpManager && !showConfigManager && !showApprovedToolsManager && !showSessionPicker && !showPluginManager && !showProviderManager && !showAgentManager && !showToolsManager && !showContextManager && !showSteeringQuestions
        ? React.createElement(PromptFooter, {
            session: currentSession,
            prNumber: initialPrNumber,
            contextPercent: contextPercent,
            voiceMode: keyboardManager.voiceMode,
          })
        : null
    )
}

/**
 * Main entry point
 */
async function main() {
  // Check for TTY - if not interactive, show a simple message
  if (!process.stdin.isTTY) {
    process.exit(0)
  }

  const config = loadConfig()
  const toolSchemas = await getAllTools()  // For API

  // Create actual tool objects with call() methods for execution
  const { createAllTools } = await import('../../tools/index.mjs')
  // Use simple exec without sandbox for now (sandbox has unix-socket-open error)
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)
  const executeCommand = async (cmd, opts) => {
    const result = await execAsync(cmd, { ...opts, maxBuffer: 30 * 1024 * 1024 })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  }
  const utils = await import('../../core/utils.mjs')
  const fs = await import('fs')
  const os = await import('os')

  // Create LSP client for code intelligence
  const { createLspClient } = await import('../../lsp/client.mjs')
  const lspClient = createLspClient({ rootUri: `file://${process.cwd()}` })

  const toolObjects = createAllTools({
    fs,
    path,
    os,
    lspClient,
    executeCommand: executeCommand,
    getCurrentDir: utils.getCurrentDir,
    getOriginalDir: utils.getOriginalDir,
    resolvePath: utils.resolvePath,
    isAbsolutePath: utils.isAbsolutePath,
    fileExists: utils.fileExists,
    getFileStats: utils.getFileStats,
    findSimilarFile: utils.findSimilarFile,
    isInAllowedDirectory: () => true,
    detectEncoding: utils.detectEncoding,
    detectLineEnding: utils.detectLineEnding,
    getDefaultLineEnding: utils.getDefaultLineEnding,
    normalizeLineEndings: utils.normalizeLineEndings,
    writeFile: utils.writeFile,
    globFiles: utils.globFiles,
    runRipgrep: utils.runRipgrep,
    processImage: utils.processImage,
    logError: console.error,
    logEvent: () => {},
    React,
    getAvailableTools: async (_dangerouslySkipPermissions) => Object.values(toolObjects)
  })
  let tools = Object.values(toolObjects)

  // Initialize MCP servers lazily (don't spawn processes until first tool call)
  let mcpClients = []
  let mcpSystemInstructions = ''
  try {
    const { initializeMcpLazy } = await import('../../integration/mcp.mjs')
    const mcpDeps = {
      getGlobalConfig: () => {
        try {
          const configPath = path.join(os.homedir(), '.dario', 'config.json')
          if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'))
        } catch {}
        return {}
      },
      getProjectConfig: () => {
        try {
          const configPath = path.join(process.cwd(), '.dario', 'config.json')
          if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'))
        } catch {}
        return {}
      },
      setProjectConfig: (config) => {
        try {
          const dir = path.join(process.cwd(), '.dario')
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2))
        } catch {}
      },
      setGlobalConfig: (config) => {
        try {
          const dir = path.join(os.homedir(), '.dario')
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          const configPath = path.join(dir, 'config.json')
          // Merge with existing config to avoid clobbering OAuth tokens etc.
          let existing = {}
          try { if (fs.existsSync(configPath)) existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
          fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...config }, null, 2))
        } catch {}
      },
      getMcprcConfig: () => {
        try {
          const mcprcPath = path.join(process.cwd(), '.mcprc')
          if (fs.existsSync(mcprcPath)) return JSON.parse(fs.readFileSync(mcprcPath, 'utf8'))
        } catch {}
        return null
      },
      getCurrentDir: () => process.cwd(),
      fs,
      path,
      logEvent: () => {},
      logMcpServerMessage: (name, msg) => {
        if (process.env.DEBUG_TUI) console.error(`[MCP:${name}] ${msg}`)
      },
    }

    // replaceTools callback: when a lazy server connects, swap proxy tools for real ones
    const replaceTools = (serverName, realTools, clientInfo) => {
      // Replace proxy tools with real tools in the tools array
      tools = tools.filter(t => !t._lazy || t._serverName !== serverName)
      tools.push(...realTools)

      // Track the connected client
      mcpClients = [
        ...mcpClients.filter(c => c.name !== serverName),
        clientInfo,
      ]

      if (process.env.DEBUG_TUI) {
        console.error(`[MCP:Lazy] ${serverName}: replaced proxies with ${realTools.length} real tools`)
      }
    }

    const mcpResult = await initializeMcpLazy(mcpDeps, replaceTools)
    mcpSystemInstructions = mcpResult.systemInstructions

    if (mcpResult.tools.length > 0) {
      tools = [...tools, ...mcpResult.tools]
      if (process.env.DEBUG_TUI) {
        console.error(`[MCP:Lazy] Created ${mcpResult.tools.length} proxy tools for ${mcpResult.serverNames.length} servers`)
      }
    }

    // Schedule eager connections for "always" mode servers (5s after startup, staggered)
    if (mcpResult.eagerServers?.length > 0) {
      const { connectEagerServers } = await import('../../integration/mcp.mjs')
      setTimeout(() => {
        connectEagerServers(mcpResult.eagerServers, mcpDeps, replaceTools)
          .catch(err => {
            if (process.env.DEBUG_TUI) {
              console.error('[MCP:Eager] Failed:', err.message)
            }
          })
      }, 5000)
    }
  } catch (error) {
    if (process.env.DEBUG_TUI) {
      console.error('[MCP] Failed to initialize:', error.message)
    }
  }

  // Load all commands: localCommands FIRST (real implementations from commands.mjs),
  // then standardCommands (TUI-only: help, quit, version, overlay wrappers),
  // then customCommands (user ~/.claude/commands/*.md).
  // .find() returns the first match, so localCommands take precedence over stubs.
  let commands = [...standardCommands]
  try {
    const localCommands = getLocalCommands()
    const customCommands = loadCustomCommands()
    commands = [...localCommands, ...standardCommands, ...customCommands]
    if (process.env.DEBUG_TUI) {
      console.error('[Commands] Loaded:', commands.length, 'commands')
      console.error('[Commands] Custom:', customCommands.length, 'from ~/.claude/commands')
    }
  } catch (e) {
    console.error('[Commands] Failed to load:', e.message)
  }

  // Run SessionStart hooks
  try {
    const { runSessionStart } = await import('../../core/hooks.mjs')
    await runSessionStart(Date.now().toString(), {
      file: '', // Empty string to satisfy hook requirements
      cwd: process.cwd()
    })
  } catch (error) {
    console.error('[Hook] SessionStart error:', error.message)
  }

  // Handle graceful exit
  const handleExit = () => {
    lspClient.shutdown().catch(() => {})
    process.stdout.write('\x1b[?25h') // Show cursor
    process.exit(0)
  }

  process.on('SIGINT', handleExit)
  process.on('SIGTERM', handleExit)

  // OOM / memory-pressure protection (CC 2.1.47-50 parity)
  // Monitor heap usage and proactively compact when memory is high to prevent
  // crashes in long-running sessions with heavy subagent usage.
  const OOM_HEAP_THRESHOLD_MB = 800   // warn at 800 MB heap
  const OOM_COMPACT_THRESHOLD_MB = 1100 // compact at 1.1 GB heap
  let _oomWarned = false
  const _oomMonitor = setInterval(async () => {
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024
    if (heapMb > OOM_COMPACT_THRESHOLD_MB && !_oomWarned) {
      _oomWarned = true
      clearInterval(_oomMonitor)
      // Attempt to force GC if --expose-gc flag is set
      if (typeof global.gc === 'function') global.gc()
      // Log warning — TUI will pick this up via stderr if visible
      process.stderr.write(`\n[dario] ⚠️  High memory usage (${Math.round(heapMb)} MB). Triggering auto-compaction to prevent crash.\n`)
    } else if (heapMb > OOM_HEAP_THRESHOLD_MB && !_oomWarned) {
      process.stderr.write(`\n[dario] ℹ️  Memory usage at ${Math.round(heapMb)} MB — consider /compact to free space.\n`)
    }
  }, 30_000)

  // Render app with error boundary
  try {
    const { unmount } = render(
      React.createElement(ErrorBoundary, null,
        React.createElement(ConversationApp, {
          commands,
          dangerouslySkipPermissions: process.env.DARIO_DANGEROUSLY_SKIP_PERMISSIONS === '1',
          debug: process.argv.includes('--debug'),
          initialPrompt: process.env.INITIAL_PROMPT || undefined,
          initialPrNumber: config.prNumber,
          currentSession: config.currentSession,
          messageLogName: new Date().toISOString(),
          shouldShowPromptInput: true,
          tools,
          verbose: config.verbose || process.argv.includes('--verbose'),
          mcpClients,
          mcpSystemInstructions,
        })
      ),
      {
        exitOnCtrlC: false, // We handle it ourselves
        patchConsole: false
      }
    )

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      unmount()
      process.stdout.write('\x1b[?25h') // Show cursor
      process.exit(0)
    })
  } catch (error) {
    console.error('Failed to render TUI:', error.message)
    process.exit(1)
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})

export { ConversationApp, MessageRenderer, PromptInput, WelcomeBanner }
