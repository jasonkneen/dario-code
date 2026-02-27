/**
 * Skills Discovery Module
 * 
 * Scans .claude/skills/ directories for skill definitions.
 * Skills are markdown files with YAML frontmatter (CC 2.1.x parity).
 * 
 * Skill locations (in order of precedence):
 *   ~/.claude/skills/         - global user skills
 *   ./.claude/skills/         - project-level skills
 *   Additional dirs' .claude/skills/ (--add-dir)
 *
 * Skill frontmatter format:
 * ---
 * description: Brief description of the skill
 * allowed-tools:
 *   - Bash
 *   - Read
 *   - Edit
 * context: fork          # 'fork' to run in sub-agent context
 * agent: reviewer        # named agent to use
 * user-invocable: true   # show in slash command menu (default true)
 * once: false            # only run once per session
 * ---
 * The rest of the file is the skill's prompt/instructions.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const SKILLS_DIR_NAME = 'skills'
const CLAUDE_DIR_NAME = '.claude'

/**
 * Parse frontmatter from a skill file
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { metadata: {}, body: content }

  const raw = match[1]
  const body = match[2]
  const metadata = {}
  let currentKey = null

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (trimmed.startsWith('- ') && currentKey) {
      if (!Array.isArray(metadata[currentKey])) metadata[currentKey] = []
      let val = trimmed.slice(2).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      metadata[currentKey].push(val)
      continue
    }

    const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (kv) {
      currentKey = kv[1]
      const val = kv[2].trim()
      if (val === '' || val === '|' || val === '>') {
        metadata[currentKey] = val === '' ? [] : ''
      } else if (val === 'true') {
        metadata[currentKey] = true
      } else if (val === 'false') {
        metadata[currentKey] = false
      } else if (!isNaN(val) && val !== '') {
        metadata[currentKey] = Number(val)
      } else {
        metadata[currentKey] = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))
          ? val.slice(1, -1)
          : val
      }
    }
  }

  return { metadata, body }
}

/**
 * Load a skill from a directory or markdown file
 */
function loadSkill(skillPath, scope) {
  try {
    let filePath = skillPath
    let name

    const stat = fs.statSync(skillPath)
    if (stat.isDirectory()) {
      // Look for SKILL.md or index.md inside the directory
      const candidates = ['SKILL.md', 'skill.md', 'index.md', 'README.md']
      for (const candidate of candidates) {
        const candidatePath = path.join(skillPath, candidate)
        if (fs.existsSync(candidatePath)) {
          filePath = candidatePath
          break
        }
      }
      name = path.basename(skillPath)
    } else {
      name = path.basename(skillPath, '.md')
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const { metadata, body } = parseFrontmatter(content)

    return {
      name,
      path: filePath,
      scope,
      description: metadata.description || '',
      allowedTools: metadata['allowed-tools'] || [],
      disallowedTools: metadata['disallowed-tools'] || [],
      context: metadata.context || null,
      agent: metadata.agent || null,
      userInvocable: metadata['user-invocable'] !== false,
      once: metadata.once || false,
      hooks: metadata.hooks || null,
      prompt: body.trim(),
      rawContent: content,
      // Estimate token count for context budget
      tokenEstimate: Math.ceil(body.length / 4),
    }
  } catch (e) {
    return null
  }
}

/**
 * Scan a skills directory for skill definitions
 */
function scanSkillsDir(dir, scope) {
  const skills = []
  try {
    if (!fs.existsSync(dir)) return skills
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      
      if (entry.isDirectory()) {
        const skill = loadSkill(entryPath, scope)
        if (skill) skills.push(skill)
      } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
        const skill = loadSkill(entryPath, scope)
        if (skill) skills.push(skill)
      }
    }
  } catch (e) {
    // Skip unreadable dirs
  }
  return skills
}

/**
 * Discover all skills from standard locations
 */
export function discoverSkills(projectDir = process.cwd()) {
  const allSkills = new Map()

  // Global skills
  const globalDir = path.join(os.homedir(), CLAUDE_DIR_NAME, SKILLS_DIR_NAME)
  for (const skill of scanSkillsDir(globalDir, 'global')) {
    allSkills.set(skill.name, skill)
  }

  // Project skills (override global)
  const projectSkillsDir = path.join(projectDir, CLAUDE_DIR_NAME, SKILLS_DIR_NAME)
  for (const skill of scanSkillsDir(projectSkillsDir, 'project')) {
    allSkills.set(skill.name, skill)
  }

  // Additional directories
  if (process.env.OPENCLAUDE_ADD_DIRS) {
    for (const addDir of process.env.OPENCLAUDE_ADD_DIRS.split(':').filter(Boolean)) {
      const addSkillsDir = path.join(addDir, CLAUDE_DIR_NAME, SKILLS_DIR_NAME)
      for (const skill of scanSkillsDir(addSkillsDir, 'additional')) {
        allSkills.set(skill.name, skill)
      }
    }
  }

  return allSkills
}

/**
 * Get skills formatted for the system prompt context
 */
export function getSkillsContext(projectDir = process.cwd()) {
  const skills = discoverSkills(projectDir)
  if (skills.size === 0) return ''

  // Budget: 2% of context window (~4000 tokens for 200k context)
  const TOKEN_BUDGET = 4000
  let usedTokens = 0
  const entries = []

  for (const [name, skill] of skills) {
    if (!skill.userInvocable) continue
    const desc = skill.description || skill.prompt.slice(0, 100)
    const entry = `- /${name}: ${desc}`
    const tokens = Math.ceil(entry.length / 4)
    if (usedTokens + tokens > TOKEN_BUDGET) break
    entries.push(entry)
    usedTokens += tokens
  }

  if (entries.length === 0) return ''

  return `\n# Available Skills\nThe following skills are available as slash commands:\n${entries.join('\n')}\n`
}

/**
 * Get a specific skill by name
 */
export function getSkill(name, projectDir = process.cwd()) {
  const skills = discoverSkills(projectDir)
  return skills.get(name) || null
}

/**
 * List all user-invocable skills
 */
export function listSkills(projectDir = process.cwd()) {
  const skills = discoverSkills(projectDir)
  return Array.from(skills.values()).filter(s => s.userInvocable)
}

// ---------------------------------------------------------------------------
// Hot-reload (CC 2.1.0 parity)
// Skills reload automatically when files change in .claude/skills/ or
// ~/.claude/skills/ without requiring a session restart.
// ---------------------------------------------------------------------------

let _hotReloadWatchers = []
let _hotReloadCallbacks = []

/**
 * Start watching skill directories for changes.
 * Calls all registered callbacks when a change is detected.
 *
 * @param {string} projectDir
 * @returns {Function} stop — call to tear down watchers
 */
export function startSkillsHotReload(projectDir = process.cwd()) {
  stopSkillsHotReload()

  const dirsToWatch = [
    path.join(os.homedir(), CLAUDE_DIR_NAME, SKILLS_DIR_NAME),
    path.join(projectDir, CLAUDE_DIR_NAME, SKILLS_DIR_NAME),
  ]

  if (process.env.OPENCLAUDE_ADD_DIRS) {
    for (const addDir of process.env.OPENCLAUDE_ADD_DIRS.split(':').filter(Boolean)) {
      dirsToWatch.push(path.join(addDir, CLAUDE_DIR_NAME, SKILLS_DIR_NAME))
    }
  }

  for (const dir of dirsToWatch) {
    if (!fs.existsSync(dir)) continue
    try {
      const watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return
        const changedPath = path.join(dir, filename)
        for (const cb of _hotReloadCallbacks) {
          try { cb(changedPath, eventType) } catch {}
        }
      })
      _hotReloadWatchers.push(watcher)
    } catch {
      // Silently skip directories we can't watch (permissions, etc.)
    }
  }

  return stopSkillsHotReload
}

/**
 * Stop all hot-reload watchers.
 */
export function stopSkillsHotReload() {
  for (const w of _hotReloadWatchers) {
    try { w.close() } catch {}
  }
  _hotReloadWatchers = []
}

/**
 * Register a callback to be invoked when a skill file changes.
 * Useful for the TUI to invalidate its skills cache.
 *
 * @param {Function} callback - (changedPath: string, eventType: string) => void
 * @returns {Function} unregister
 */
export function onSkillsChanged(callback) {
  _hotReloadCallbacks.push(callback)
  return () => {
    _hotReloadCallbacks = _hotReloadCallbacks.filter(cb => cb !== callback)
  }
}

// ---------------------------------------------------------------------------
// Skills cache (CC 2.1.x parity — invalidated by hot-reload)
// ---------------------------------------------------------------------------

let _skillsCache = null

/**
 * Invalidate the in-memory skills cache.
 * Called by the TUI's hot-reload handler so the next `discoverSkills` call
 * rescans disk instead of returning stale data.
 */
export function invalidateSkillsCache() {
  _skillsCache = null
}

/**
 * Cached version of discoverSkills.
 * Returns cached results on repeated calls; cache is cleared by invalidateSkillsCache().
 *
 * @param {string} projectDir
 * @returns {Map<string, object>}
 */
export function discoverSkillsCached(projectDir = process.cwd()) {
  if (_skillsCache !== null) return _skillsCache
  _skillsCache = discoverSkills(projectDir)
  return _skillsCache
}

export default {
  discoverSkills,
  discoverSkillsCached,
  invalidateSkillsCache,
  getSkillsContext,
  getSkill,
  listSkills,
  parseFrontmatter,
  startSkillsHotReload,
  stopSkillsHotReload,
  onSkillsChanged,
}
