/**
 * Named Agents System
 * 
 * Loads agent definitions from .claude/agents/ directories.
 * Agents are markdown files with YAML frontmatter that define:
 * - model: which model to use
 * - tools: which tools the agent can access
 * - allowed-tools: permission patterns
 * - memory: persistent memory scope (user, project, local)
 * - hooks: agent-scoped hooks (PreToolUse, PostToolUse, Stop)
 * 
 * Example agent file (.claude/agents/reviewer.md):
 * ---
 * model: opus
 * tools:
 *   - Read
 *   - Grep
 *   - Glob
 *   - Task(Explore)
 * allowed-tools:
 *   - "Bash(git diff:*)"
 *   - "Bash(git log:*)"
 * memory: project
 * ---
 * You are a code reviewer. Review the code changes and provide feedback.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Parse YAML-like frontmatter from a markdown string
 * Simple parser that handles the common cases without a YAML dependency
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { metadata: {}, body: content }

  const frontmatter = match[1]
  const body = match[2]
  const metadata = {}

  let currentKey = null
  let inList = false

  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // List item
    if (trimmed.startsWith('- ') && currentKey) {
      if (!Array.isArray(metadata[currentKey])) metadata[currentKey] = []
      let value = trimmed.slice(2).trim()
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      metadata[currentKey].push(value)
      inList = true
      continue
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const value = kvMatch[2].trim()
      inList = false

      if (value === '' || value === '|' || value === '>') {
        // Next lines will be a list or multiline
        metadata[currentKey] = value === '' ? [] : ''
      } else if (value === 'true') {
        metadata[currentKey] = true
      } else if (value === 'false') {
        metadata[currentKey] = false
      } else if (!isNaN(value) && value !== '') {
        metadata[currentKey] = Number(value)
      } else {
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          metadata[currentKey] = value.slice(1, -1)
        } else {
          metadata[currentKey] = value
        }
      }
    }
  }

  return { metadata, body }
}

/**
 * Load a single agent definition from a markdown file
 */
function loadAgentFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const { metadata, body } = parseFrontmatter(content)
    const name = path.basename(filePath, '.md')

    return {
      name,
      path: filePath,
      model: metadata.model || null,
      tools: metadata.tools || [],
      allowedTools: metadata['allowed-tools'] || [],
      disallowedTools: metadata['disallowed-tools'] || [],
      memory: metadata.memory || null,
      hooks: metadata.hooks || null,
      context: metadata.context || null,
      // isolation: 'worktree' spins up an isolated git worktree for the agent
      // (CC 2.1.50 parity). If isolation is not set, defaults to 'none'.
      isolation: metadata.isolation || 'none',
      once: metadata.once || false,
      userInvocable: metadata['user-invocable'] !== false,
      description: metadata.description || '',
      prompt: body.trim()
    }
  } catch (e) {
    return null
  }
}

/**
 * Discover all agent definitions from standard locations.
 * Reads from both .claude/agents/ (CC-compatible) and .dario/agents/ (Dario-native).
 * Load order: .claude first, .dario second — so .dario always wins on name collision.
 *
 * Searches:
 *   ~/.claude/agents/   (CC global, read-only)
 *   ~/.dario/agents/    (Dario global, takes precedence)
 *   .claude/agents/     (CC project, read-only)
 *   .dario/agents/      (Dario project, highest priority)
 *   Additional --add-dir directories (both variants)
 */
export function discoverAgents(projectDir = process.cwd()) {
  const agents = new Map()
  const searchDirs = []

  // Global — .claude first, then .dario (so .dario wins)
  searchDirs.push({ dir: path.join(os.homedir(), '.claude', 'agents'), scope: 'global' })
  searchDirs.push({ dir: path.join(os.homedir(), '.dario',  'agents'), scope: 'global' })

  // Project — .claude first, then .dario
  searchDirs.push({ dir: path.join(projectDir, '.claude', 'agents'), scope: 'project' })
  searchDirs.push({ dir: path.join(projectDir, '.dario',  'agents'), scope: 'project' })

  // Additional directories
  if (process.env.DARIO_ADD_DIRS) {
    for (const addDir of process.env.DARIO_ADD_DIRS.split(':').filter(Boolean)) {
      searchDirs.push({ dir: path.join(addDir, '.claude', 'agents'), scope: 'additional' })
      searchDirs.push({ dir: path.join(addDir, '.dario',  'agents'), scope: 'additional' })
    }
  }

  for (const { dir, scope } of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const agent = loadAgentFile(path.join(dir, file))
        if (agent) {
          agent.scope = scope
          // Project-level agents override global ones
          agents.set(agent.name, agent)
        }
      }
    } catch (e) {
      // Skip unreadable directories
    }
  }

  return agents
}

/**
 * Get a specific agent by name
 */
export function getAgent(name, projectDir = process.cwd()) {
  const agents = discoverAgents(projectDir)
  return agents.get(name) || null
}

/**
 * List all available agents
 */
export function listAgents(projectDir = process.cwd()) {
  const agents = discoverAgents(projectDir)
  return Array.from(agents.values())
}

/**
 * Resolve model name to full model ID
 */
export function resolveAgentModel(modelName) {
  if (!modelName) return null

  const aliases = {
    'opus': 'claude-opus-4-6',
    'sonnet': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
    'opus-4.5': 'claude-opus-4-5-20251101',
    'sonnet-4': 'claude-sonnet-4-20250514',
  }

  return aliases[modelName.toLowerCase()] || modelName
}

export default {
  parseFrontmatter,
  discoverAgents,
  getAgent,
  listAgents,
  resolveAgentModel
}
