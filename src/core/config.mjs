/**
 * Configuration Management for Dario
 *
 * Handles loading and saving configuration from .dario and .claude directories.
 * Reads from both but only writes to .dario.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileExists, readFile, writeFile, safeJsonParse } from './utils.mjs'

// Version constant
export const VERSION = '1.0.0'

// Model override state (runtime only)
let _modelOverride = null

// Configuration directories
const HOME_DIR = os.homedir()
const DARIO_DIR = process.env.DARIO_CONFIG_DIR || path.join(HOME_DIR, '.dario')
const CLAUDE_DIR = path.join(HOME_DIR, '.claude') // Read-only

// Configuration file names
const CONFIG_FILE = 'config.json'
const SETTINGS_FILE = 'settings.json'
const CLAUDE_MD_FILE = 'CLAUDE.md'

/**
 * Ensure the Dario config directory exists
 */
export function ensureConfigDir() {
  if (!fileExists(DARIO_DIR)) {
    fs.mkdirSync(DARIO_DIR, { recursive: true })
  }
  return DARIO_DIR
}

/**
 * Get the Dario config directory path
 */
export function getConfigDir() {
  return DARIO_DIR
}

/**
 * Get the Claude config directory path (read-only)
 */
export function getClaudeConfigDir() {
  return CLAUDE_DIR
}

/**
 * Load configuration from both .dario and .claude directories
 * Dario settings take precedence
 */
export function loadConfig() {
  const config = {}

  // First load from .claude (if exists) as base
  const claudeConfigPath = path.join(CLAUDE_DIR, CONFIG_FILE)
  if (fileExists(claudeConfigPath)) {
    const claudeConfig = safeJsonParse(readFile(claudeConfigPath), {})
    Object.assign(config, claudeConfig)
  }

  // Then overlay .dario settings (takes precedence)
  const darioConfigPath = path.join(DARIO_DIR, CONFIG_FILE)
  if (fileExists(darioConfigPath)) {
    const darioConfig = safeJsonParse(readFile(darioConfigPath), {})
    Object.assign(config, darioConfig)
  }

  return config
}

/**
 * Save configuration to .dario directory only.
 *
 * IMPORTANT: This performs a read-modify-write on the .dario config file
 * (NOT the merged config) to avoid clobbering keys written by other modules
 * (e.g., OAuth tokens written by auth/oauth.mjs).
 *
 * Callers passing a full config from loadConfig() will have their keys merged
 * into the existing .dario file, preserving any keys they didn't touch.
 */
export function saveConfig(config) {
  ensureConfigDir()
  const configPath = path.join(DARIO_DIR, CONFIG_FILE)

  // Read existing .dario config to preserve keys not in the incoming config
  let existing = {}
  if (fileExists(configPath)) {
    existing = safeJsonParse(readFile(configPath), {})
  }

  // Merge: incoming config wins, but existing keys not present in incoming are preserved
  const merged = { ...existing, ...config }

  // Handle explicit deletions: if caller deleted a key (not in config but was in existing),
  // check by comparing against what loadConfig() originally returned
  // For simplicity, just write the merged result — callers that need to delete keys
  // should explicitly set them to undefined or use removeConfigValue()
  writeFile(configPath, JSON.stringify(merged, null, 2))
}

/**
 * Get a specific config value
 */
export function getConfigValue(key, defaultValue = null) {
  const config = loadConfig()
  return config[key] ?? defaultValue
}

/**
 * Set a specific config value
 */
export function setConfigValue(key, value) {
  const config = loadConfig()
  config[key] = value
  saveConfig(config)
}

/**
 * Remove a config value from the .dario config file directly.
 */
export function removeConfigValue(key) {
  ensureConfigDir()
  const configPath = path.join(DARIO_DIR, CONFIG_FILE)
  let config = {}
  if (fileExists(configPath)) {
    config = safeJsonParse(readFile(configPath), {})
  }
  delete config[key]
  writeFile(configPath, JSON.stringify(config, null, 2))
}

/**
 * Load settings (user preferences)
 */
export function loadSettings() {
  const settings = {}

  // Load from .claude first
  const claudeSettingsPath = path.join(CLAUDE_DIR, SETTINGS_FILE)
  if (fileExists(claudeSettingsPath)) {
    const claudeSettings = safeJsonParse(readFile(claudeSettingsPath), {})
    Object.assign(settings, claudeSettings)
  }

  // Overlay .dario settings
  const darioSettingsPath = path.join(DARIO_DIR, SETTINGS_FILE)
  if (fileExists(darioSettingsPath)) {
    const darioSettings = safeJsonParse(readFile(darioSettingsPath), {})
    Object.assign(settings, darioSettings)
  }

  return settings
}

/**
 * Save settings to .dario only
 */
export function saveSettings(settings) {
  ensureConfigDir()
  const settingsPath = path.join(DARIO_DIR, SETTINGS_FILE)
  writeFile(settingsPath, JSON.stringify(settings, null, 2))
}

/**
 * Get disabled context items from settings
 * @returns {Object} Map of context item IDs to disabled state
 */
export function getDisabledContextItems() {
  const settings = loadSettings()
  return settings.disabledContextItems || {}
}

/**
 * Set disabled context items in settings
 * @param {Object} items - Map of context item IDs to disabled state
 */
export function setDisabledContextItems(items) {
  const settings = loadSettings()
  settings.disabledContextItems = items
  saveSettings(settings)
}

/**
 * Check if a specific context item is disabled
 * @param {string} itemId - Context item ID (e.g. 'systemPrompt', 'memory:project')
 * @returns {boolean} True if disabled
 */
export function isContextItemDisabled(itemId) {
  const disabled = getDisabledContextItems()
  return !!disabled[itemId]
}

/**
 * Toggle a context item's disabled state
 * @param {string} itemId - Context item ID
 * @returns {boolean} New disabled state (true = disabled)
 */
export function toggleContextItem(itemId) {
  const disabled = getDisabledContextItems()
  disabled[itemId] = !disabled[itemId]
  // Clean up false entries
  if (!disabled[itemId]) delete disabled[itemId]
  setDisabledContextItems(disabled)
  return !!disabled[itemId]
}

// ============================================================================
// Custom Context Items
// ============================================================================

/**
 * Get all custom context items from settings
 * @returns {Array<{id: string, type: string, label: string, source: string, content: string, addedAt: string}>}
 */
export function getCustomContextItems() {
  const settings = loadSettings()
  return settings.customContextItems || []
}

/**
 * Add a custom context item
 * @param {Object} item - { type: 'file'|'url'|'text'|'docs', label, source, content }
 * @returns {Object} The added item with generated id
 */
export function addCustomContextItem(item) {
  const settings = loadSettings()
  if (!settings.customContextItems) settings.customContextItems = []

  const entry = {
    id: `custom:${Date.now()}`,
    type: item.type,
    label: item.label,
    source: item.source,
    content: item.content,
    addedAt: new Date().toISOString(),
  }

  settings.customContextItems.push(entry)
  saveSettings(settings)
  return entry
}

/**
 * Remove a custom context item by id
 * @param {string} itemId - The custom item id
 * @returns {boolean} True if removed
 */
export function removeCustomContextItem(itemId) {
  const settings = loadSettings()
  if (!settings.customContextItems) return false

  const before = settings.customContextItems.length
  settings.customContextItems = settings.customContextItems.filter(i => i.id !== itemId)

  if (settings.customContextItems.length < before) {
    // Also clean up any disabled state for this item
    if (settings.disabledContextItems?.[itemId]) {
      delete settings.disabledContextItems[itemId]
    }
    saveSettings(settings)
    return true
  }
  return false
}

/**
 * Load CLAUDE.md files (global and project-level)
 * Supports @import syntax for including other files
 */
export function loadClaudeMd(projectDir = process.cwd()) {
  const contents = []

  // Global CLAUDE.md from .dario
  const globalOpenclaudeMd = path.join(DARIO_DIR, CLAUDE_MD_FILE)
  if (fileExists(globalOpenclaudeMd)) {
    contents.push({
      source: 'global-dario',
      path: globalOpenclaudeMd,
      content: processImports(readFile(globalOpenclaudeMd), path.dirname(globalOpenclaudeMd))
    })
  }

  // Global CLAUDE.md from .claude (read-only)
  const globalClaudeMd = path.join(CLAUDE_DIR, CLAUDE_MD_FILE)
  if (fileExists(globalClaudeMd)) {
    contents.push({
      source: 'global-claude',
      path: globalClaudeMd,
      content: processImports(readFile(globalClaudeMd), path.dirname(globalClaudeMd))
    })
  }

  // Project-level CLAUDE.md
  const projectClaudeMd = path.join(projectDir, CLAUDE_MD_FILE)
  if (fileExists(projectClaudeMd)) {
    contents.push({
      source: 'project',
      path: projectClaudeMd,
      content: processImports(readFile(projectClaudeMd), projectDir)
    })
  }

  // Rules directories — read from both .claude/rules/ and .dario/rules/
  // .dario/rules/ loaded second so it takes precedence on filename collision.
  const loadRulesDir = (rulesDir, sourcePrefix) => {
    try {
      if (!fs.existsSync(rulesDir)) return
      const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).sort()
      for (const ruleFile of ruleFiles) {
        const rulePath = path.join(rulesDir, ruleFile)
        try {
          contents.push({ source: `${sourcePrefix}/${ruleFile}`, path: rulePath, content: readFile(rulePath) })
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }

  loadRulesDir(path.join(projectDir, '.claude', 'rules'), 'rules')
  loadRulesDir(path.join(projectDir, '.dario',  'rules'), 'rules')   // .dario wins
  loadRulesDir(path.join(CLAUDE_DIR, 'rules'), 'global-rules')
  loadRulesDir(path.join(DARIO_DIR,  'rules'), 'global-rules')       // .dario wins

  return contents
}

/**
 * Process @import syntax in CLAUDE.md files
 * Supports: @path/to/file.md
 */
export function processImports(content, baseDir, visited = new Set()) {
  const lines = content.split('\n')
  const result = []

  for (const line of lines) {
    const match = line.match(/^@(.+\.md)\s*$/)
    if (match) {
      const importPath = path.resolve(baseDir, match[1])

      // Prevent circular imports
      if (!visited.has(importPath) && fileExists(importPath)) {
        visited.add(importPath)
        try {
          const imported = readFile(importPath)
          result.push(`\n# Imported from ${match[1]}:\n`)
          result.push(processImports(imported, path.dirname(importPath), visited))
        } catch (e) {
          result.push(`# Failed to import ${match[1]}`)
        }
      }
    } else {
      result.push(line)
    }
  }

  return result.join('\n')
}

/**
 * Load custom commands from .dario/commands/ and .claude/commands/
 */
export async function loadCustomCommands() {
  const commands = []
  const commandDirs = [
    path.join(DARIO_DIR, 'commands'),
    path.join(CLAUDE_DIR, 'commands'), // Read-only
    path.join(process.cwd(), '.dario', 'commands'),
    path.join(process.cwd(), '.claude', 'commands') // Read-only
  ]

  for (const dir of commandDirs) {
    if (!fileExists(dir)) continue

    try {
      const files = fs.readdirSync(dir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue

        const filePath = path.join(dir, file)
        const name = file.replace(/\.md$/, '')
        const content = readFile(filePath)

        // Parse command metadata from frontmatter
        const metadata = parseCommandMetadata(content)

        commands.push({
          name: `/${name}`,
          source: dir.includes('.claude') ? 'claude' : 'dario',
          path: filePath,
          content,
          ...metadata
        })
      }
    } catch (e) {
      // Ignore errors
    }
  }

  return commands
}

/**
 * Parse command metadata from markdown frontmatter
 */
function parseCommandMetadata(content) {
  const metadata = {
    description: '',
    args: []
  }

  // Check for YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1]

    // Simple YAML parsing
    const descMatch = yaml.match(/description:\s*(.+)/)
    if (descMatch) metadata.description = descMatch[1].trim()

    const argsMatch = yaml.match(/args:\s*\[(.*?)\]/)
    if (argsMatch) {
      metadata.args = argsMatch[1].split(',').map(a => a.trim().replace(/['"]/g, ''))
    }
  }

  // If no frontmatter, use first line as description
  if (!metadata.description) {
    const firstLine = content.split('\n')[0]
    if (firstLine.startsWith('#')) {
      metadata.description = firstLine.replace(/^#+\s*/, '').trim()
    }
  }

  return metadata
}

/**
 * Get the default model from environment or config
 */
export function getDefaultModel() {
  return process.env.ANTHROPIC_MODEL ||
         process.env.CLAUDE_MODEL ||
         getConfigValue('model') ||
         'claude-sonnet-4-6'
}

/**
 * Set model override for current session (runtime only)
 * @param {string} modelId - Model ID to use
 */
export function setModelOverride(modelId) {
  _modelOverride = modelId
}

/**
 * Clear model override
 */
export function clearModelOverride() {
  _modelOverride = null
}

// ============================================================================
// Fast Mode
// ============================================================================

const FAST_MODE_MODEL = 'claude-opus-4-6'
const FAST_MODE_DISPLAY_NAME = 'Opus 4.6'

/**
 * Check if fast mode is enabled
 * @returns {boolean}
 */
export function isFastMode() {
  return getConfigValue('fastMode', false)
}

/**
 * Set fast mode on/off. When enabled, forces model to Opus 4.6.
 * @param {boolean} enabled
 */
export function setFastMode(enabled) {
  if (enabled) {
    setConfigValue('fastMode', true)
    setModelOverride(FAST_MODE_MODEL)
  } else {
    removeConfigValue('fastMode')
  }
}

/**
 * Check if a model supports fast mode (only Opus 4.6)
 * @param {string} modelId
 * @returns {boolean}
 */
export function modelSupportsFastMode(modelId) {
  return modelId?.toLowerCase().includes('opus-4-6')
}

/**
 * Get the fast mode model ID
 * @returns {string}
 */
export function getFastModeModel() {
  return FAST_MODE_MODEL
}

/**
 * Get the fast mode display name
 * @returns {string}
 */
export function getFastModeDisplayName() {
  return FAST_MODE_DISPLAY_NAME
}

/**
 * Get the current model (respects runtime override)
 * @returns {Promise<string>} Current model ID
 */
export async function getModel() {
  if (_modelOverride) {
    return _modelOverride
  }
  return getDefaultModel()
}

/**
 * Get current model synchronously
 * @returns {string} Current model ID
 */
export function getModelSync() {
  if (_modelOverride) {
    return _modelOverride
  }
  return getDefaultModel()
}

// ============================================================================
// Auto-compact threshold (CC 2.1.x parity — configurable compaction trigger)
// ============================================================================

const DEFAULT_COMPACT_THRESHOLD = 0.85  // 85% context usage

/**
 * Get the auto-compact threshold (0–1 fraction of context window).
 * When context usage exceeds this fraction, auto-compaction triggers.
 * Default: 0.85 (85%).
 * Configurable via: ~/.dario/config.json { "compactThreshold": 0.85 }
 *
 * @returns {number} Threshold between 0 and 1
 */
export function getCompactThreshold() {
  const val = getConfigValue('compactThreshold', DEFAULT_COMPACT_THRESHOLD)
  const parsed = parseFloat(val)
  if (isNaN(parsed) || parsed <= 0 || parsed > 1) return DEFAULT_COMPACT_THRESHOLD
  return parsed
}

/**
 * Set the auto-compact threshold.
 * @param {number} threshold - Value between 0.1 and 1.0
 */
export function setCompactThreshold(threshold) {
  const val = parseFloat(threshold)
  if (isNaN(val) || val < 0.1 || val > 1) {
    throw new Error('compactThreshold must be a number between 0.1 and 1.0')
  }
  setConfigValue('compactThreshold', val)
}

/**
 * Load global config (user-level config from ~/.dario or ~/.claude)
 * @returns {Object} Global configuration
 */
export function loadGlobalConfig() {
  const config = {}

  // Load from .claude first (read-only)
  const claudeConfigPath = path.join(CLAUDE_DIR, CONFIG_FILE)
  if (fileExists(claudeConfigPath)) {
    const claudeConfig = safeJsonParse(readFile(claudeConfigPath), {})
    Object.assign(config, claudeConfig)
  }

  // Overlay .dario settings (takes precedence)
  const darioConfigPath = path.join(DARIO_DIR, CONFIG_FILE)
  if (fileExists(darioConfigPath)) {
    const darioConfig = safeJsonParse(readFile(darioConfigPath), {})
    Object.assign(config, darioConfig)
  }

  return config
}

/**
 * Save global config
 * @param {Object} config - Configuration to save
 */
export function saveGlobalConfig(config) {
  ensureConfigDir()
  const configPath = path.join(DARIO_DIR, CONFIG_FILE)
  writeFile(configPath, JSON.stringify(config, null, 2))
}

/**
 * Get API key from environment or config
 */
export function getApiKey() {
  return process.env.ANTHROPIC_API_KEY ||
         getConfigValue('apiKey')
}

/**
 * Generate system prompt for conversation
 */
export async function getSystemPrompt(options = {}) {
  const { cwd = process.cwd(), gitInfo = null, sessionId = null } = options

  // Load CLAUDE.md files
  const claudeMdFiles = loadClaudeMd(cwd)
  const claudeMdContent = claudeMdFiles
    .map(f => `# From ${f.source} (${f.path}):\n${f.content}`)
    .join('\n\n')

  // Build environment info
  const envInfo = [
    `Working directory: ${cwd}`,
    gitInfo ? `Git branch: ${gitInfo.currentBranch || 'unknown'}` : 'Not in a git repository',
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split('T')[0]}`
  ].join('\n')

  // Load auto memories (CC 2.1.32 parity)
  let memoriesSection = ''
  try {
    const { buildMemoryContext } = await import('../memory/auto-memory.mjs')
    memoriesSection = buildMemoryContext(cwd)
  } catch {
    // Memory module unavailable — skip silently
  }

  // Core system prompt
  const systemPrompt = `You are Dario, an AI assistant for software engineering tasks.

## Environment
<env>
${envInfo}
</env>

## Instructions from CLAUDE.md files
${claudeMdContent || 'No CLAUDE.md files found.'}
${memoriesSection ? `\n${memoriesSection}` : ''}
## Guidelines
- Be direct and concise
- Use tools to complete tasks
- Prefer editing existing files over creating new ones
- Always read files before editing them
- Handle errors gracefully
`

  return systemPrompt
}

export default {
  VERSION,
  ensureConfigDir,
  getConfigDir,
  getClaudeConfigDir,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  removeConfigValue,
  loadSettings,
  saveSettings,
  loadClaudeMd,
  processImports,
  loadCustomCommands,
  getDefaultModel,
  setModelOverride,
  clearModelOverride,
  getModel,
  getModelSync,
  loadGlobalConfig,
  saveGlobalConfig,
  getApiKey,
  getSystemPrompt,
  getCompactThreshold,
  setCompactThreshold
}
