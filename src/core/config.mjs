/**
 * Configuration Management for Dario
 *
 * Handles loading and saving configuration from .dario and .claude directories.
 * Reads from both but only writes to .dario.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'
import merge from 'lodash/merge.js'
import { fileExists, readFile, writeFile, safeJsonParse } from './utils.mjs'

// Version constant — read from package.json so git-tag releases stay in sync
const _require = createRequire(import.meta.url)
const _pkg = _require('../../package.json')
export const VERSION = _pkg.version || '1.0.0'

// Model override state (runtime only)
let _modelOverride = null

// Settings hierarchy state (runtime only)
let _cliSettings = null
let _settingSources = null

// Array keys that concatenate instead of replace during merge
const CONCAT_ARRAY_KEYS = ['permissions.allow', 'permissions.deny', 'permissions.ask']

// Configuration directories
const HOME_DIR = os.homedir()
const DARIO_DIR = process.env.DARIO_CONFIG_DIR || path.join(HOME_DIR, '.dario')
const CLAUDE_DIR = path.join(HOME_DIR, '.claude') // Read-only

// Configuration file names
const CONFIG_FILE = 'config.json'
const SETTINGS_FILE = 'settings.json'
// All memory/instruction filenames Dario recognises — treated as the SAME file.
// AGENTS.md is the canonical name. CLAUDE.md and DARIO.md are aliases.
// Only the first one found per directory is loaded (no duplicates).
const MEMORY_FILES = ['AGENTS.md', 'CLAUDE.md', 'DARIO.md']
const CLAUDE_MD_FILE = 'AGENTS.md' // canonical name going forward

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
 * Set CLI settings override for the current session.
 * @param {Object|null} settings - CLI settings to overlay, or null to clear
 */
export function setCliSettings(settings) {
  _cliSettings = settings
}

/**
 * Set which setting sources to load (for testing).
 * @param {string[]|null} sources - Array of source names, or null for all
 */
export function setSettingSources(sources) {
  _settingSources = sources
}

/**
 * Get a nested value from an object by dot-path parts.
 * @param {Object} obj
 * @param {string[]} parts - Key path segments
 * @returns {*} The value, or undefined
 */
function getNestedValue(obj, parts) {
  let current = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/**
 * Set a nested value on an object by dot-path parts.
 * Does NOT mutate the parts array.
 * @param {Object} obj
 * @param {string[]} parts - Key path segments
 * @param {*} value
 */
function setNestedValue(obj, parts, value) {
  const last = parts[parts.length - 1]
  const parents = parts.slice(0, -1)
  let current = obj
  for (const part of parents) {
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part]
  }
  current[last] = value
}

/**
 * Deep merge two settings objects. Uses lodash/merge for nested objects,
 * then applies array concatenation + deduplication for CONCAT_ARRAY_KEYS.
 *
 * @param {Object} base - Lower-precedence settings
 * @param {Object} overlay - Higher-precedence settings
 * @returns {Object} Merged settings
 */
export function deepMergeSettings(base, overlay) {
  // Clone to avoid mutating inputs
  const result = merge({}, base, overlay)

  // For CONCAT_ARRAY_KEYS, concatenate + deduplicate instead of lodash's index merge
  for (const keyPath of CONCAT_ARRAY_KEYS) {
    const parts = keyPath.split('.')
    const baseVal = getNestedValue(base, parts)
    const overlayVal = getNestedValue(overlay, parts)

    if (Array.isArray(baseVal) || Array.isArray(overlayVal)) {
      const combined = [...(Array.isArray(baseVal) ? baseVal : []), ...(Array.isArray(overlayVal) ? overlayVal : [])]
      setNestedValue(result, parts, [...new Set(combined)])
    }
  }

  return result
}

/**
 * Load user-level settings from ~/.claude/settings.json and ~/.dario/settings.json.
 * Dario settings are deep-merged on top of Claude settings.
 * @returns {Object}
 */
function loadUserSettings() {
  let result = {}

  const claudeSettingsPath = path.join(CLAUDE_DIR, SETTINGS_FILE)
  if (fileExists(claudeSettingsPath)) {
    result = safeJsonParse(readFile(claudeSettingsPath), {})
  }

  const darioSettingsPath = path.join(DARIO_DIR, SETTINGS_FILE)
  if (fileExists(darioSettingsPath)) {
    const darioSettings = safeJsonParse(readFile(darioSettingsPath), {})
    result = deepMergeSettings(result, darioSettings)
  }

  return result
}

/**
 * Load project-level settings from cwd/.claude/settings.json or cwd/.dario/settings.json.
 * @returns {Object}
 */
function loadProjectSettings() {
  const cwd = process.cwd()

  const claudePath = path.join(cwd, '.claude', SETTINGS_FILE)
  if (fileExists(claudePath)) {
    return safeJsonParse(readFile(claudePath), {})
  }

  const darioPath = path.join(cwd, '.dario', SETTINGS_FILE)
  if (fileExists(darioPath)) {
    return safeJsonParse(readFile(darioPath), {})
  }

  return {}
}

/**
 * Load local settings from cwd/.claude/settings.local.json or cwd/.dario/settings.local.json.
 * @returns {Object}
 */
function loadLocalSettings() {
  const cwd = process.cwd()

  const claudePath = path.join(cwd, '.claude', 'settings.local.json')
  if (fileExists(claudePath)) {
    return safeJsonParse(readFile(claudePath), {})
  }

  const darioPath = path.join(cwd, '.dario', 'settings.local.json')
  if (fileExists(darioPath)) {
    return safeJsonParse(readFile(darioPath), {})
  }

  return {}
}

/**
 * Get the platform-specific path for managed settings.
 * @param {string} [platform] - Override platform (for testing)
 * @param {string} [homeDir] - Override home directory (for testing)
 * @returns {string} Absolute path to managed-settings.json
 */
export function getManagedSettingsPath(platform, homeDir) {
  const plat = platform || process.platform
  const home = homeDir || os.homedir()

  switch (plat) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'claude-code', 'managed-settings.json')
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'claude-code', 'managed-settings.json')
    case 'linux':
    default:
      return '/etc/claude-code/managed-settings.json'
  }
}

/**
 * Load managed settings from platform-specific path.
 * Returns {} on any error (file missing, parse error, etc).
 * @returns {Object}
 */
function loadManagedSettings() {
  try {
    const managedPath = getManagedSettingsPath()
    if (fileExists(managedPath)) {
      return safeJsonParse(readFile(managedPath), {})
    }
  } catch {
    // Graceful fallback
  }
  return {}
}

/**
 * Load settings from all 5 levels, merged in precedence order:
 *   user (lowest) → project → local → CLI → managed (highest)
 *
 * @returns {Object} Merged settings
 */
export function loadSettings() {
  const sources = _settingSources || ['user', 'project', 'local', 'cli', 'managed']
  let result = {}

  if (sources.includes('user'))    result = deepMergeSettings(result, loadUserSettings())
  if (sources.includes('project')) result = deepMergeSettings(result, loadProjectSettings())
  if (sources.includes('local'))   result = deepMergeSettings(result, loadLocalSettings())
  if (sources.includes('cli') && _cliSettings) result = deepMergeSettings(result, _cliSettings)
  if (sources.includes('managed')) result = deepMergeSettings(result, loadManagedSettings())

  return result
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
 * Load the memory/instruction file from all locations.
 * AGENTS.md, CLAUDE.md, and DARIO.md are treated as the SAME file — just
 * different names for the same concept. Only the first one found per directory
 * is loaded (so a project with CLAUDE.md doesn't double-load if AGENTS.md
 * also exists — whichever comes first in MEMORY_FILES wins).
 *
 * Search locations (lowest → highest priority):
 *   ~/.claude/   ~/.dario/   ./  (project root)
 */
export function loadClaudeMd(projectDir = process.cwd()) {
  const contents = []

  // Find the first recognised memory filename in a directory and load it.
  // Returns true if a file was found and loaded.
  const loadFirstFound = (dir, source) => {
    for (const filename of MEMORY_FILES) {
      const filePath = path.join(dir, filename)
      if (fileExists(filePath)) {
        contents.push({
          source,
          path: filePath,
          filename, // so callers can see which alias was used
          content: processImports(readFile(filePath), dir)
        })
        return true // stop at first match — they're all the same file
      }
    }
    return false
  }

  loadFirstFound(CLAUDE_DIR,  'global-claude')
  loadFirstFound(DARIO_DIR,   'global-dario')
  loadFirstFound(projectDir,  'project')

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
         getConfigValue('apiKey') ||
         getConfigValue('primaryApiKey')
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

## Instructions from DARIO.md / AGENTS.md / CLAUDE.md
${claudeMdContent || 'No DARIO.md, AGENTS.md, or CLAUDE.md files found.'}
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
  setCliSettings,
  setSettingSources,
  deepMergeSettings,
  getManagedSettingsPath,
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
