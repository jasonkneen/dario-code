/**
 * OpenClaude Subagent System
 *
 * Provides the ability to spawn specialized agents for complex tasks:
 * - Explore Agent: Fast codebase exploration using smaller models
 * - Plan Agent: Planning and task breakdown
 * - Custom Agents: User-defined agent configurations
 *
 * Subagent Flow:
 * 1. Main agent determines a task needs specialized handling
 * 2. Subagent is spawned with specific tools and context
 * 3. Subagent performs its task autonomously
 * 4. Results are returned to main agent
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

// Subagent state tracking
const activeAgents = new Map()
let agentIdCounter = 0

// Agent types
export const AgentType = {
  EXPLORE: 'explore',           // Fast exploration with Haiku
  PLAN: 'plan',                 // Planning agent
  GENERAL_PURPOSE: 'general-purpose',
  CUSTOM: 'custom'
}

// Agent status
export const AgentStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
}

// Default models for different agent types
export const AgentModels = {
  [AgentType.EXPLORE]: 'claude-haiku-4-5-20251001',
  [AgentType.PLAN]: 'claude-opus-4-6',
  [AgentType.GENERAL_PURPOSE]: 'claude-sonnet-4-6',
  [AgentType.CUSTOM]: null  // Defined by agent config
}

// Available tools for different agent types
export const AgentTools = {
  [AgentType.EXPLORE]: ['Glob', 'Grep', 'Read'],
  [AgentType.PLAN]: ['Glob', 'Grep', 'Read', 'Write', 'Edit'],
  [AgentType.GENERAL_PURPOSE]: '*',  // All tools
  [AgentType.CUSTOM]: null
}

// Agent directory for custom agent definitions
const PERSONAL_AGENTS_DIR = path.join(os.homedir(), '.openclaude', 'agents')
const AGENTS_DIR = PERSONAL_AGENTS_DIR // Default for backward compat

/**
 * Get the project-scoped agents directory
 * @returns {string} Path to .claude/agents/ in cwd
 */
export function getProjectAgentsDir() {
  return path.join(process.cwd(), '.claude', 'agents')
}

/**
 * Generate unique agent ID
 */
function generateAgentId() {
  return `agent_${Date.now()}_${++agentIdCounter}`
}

/**
 * Ensure a directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Ensure agents directory exists
 */
function ensureAgentsDir() {
  ensureDir(AGENTS_DIR)
}

/**
 * Create a subagent configuration
 */
export function createAgentConfig(options = {}) {
  const {
    type = AgentType.GENERAL_PURPOSE,
    model = null,
    tools = null,
    systemPrompt = null,
    maxTokens = 4096,
    temperature = 0.7,
    description = '',
    timeout = 300000  // 5 minutes
  } = options

  return {
    type,
    model: model || AgentModels[type],
    tools: tools || AgentTools[type],
    systemPrompt,
    maxTokens,
    temperature,
    description,
    timeout
  }
}

/**
 * Create an Explore agent configuration
 */
export function createExploreAgent(options = {}) {
  return createAgentConfig({
    type: AgentType.EXPLORE,
    description: 'Fast codebase exploration agent',
    systemPrompt: `You are an exploration agent specialized in quickly finding information in codebases.
Your goal is to efficiently locate relevant files, code patterns, and answer questions about the codebase structure.
Be thorough but fast - use glob patterns and grep searches efficiently.
Return concise, actionable results.`,
    maxTokens: 2048,
    ...options
  })
}

/**
 * Create a Plan agent configuration
 */
export function createPlanAgent(options = {}) {
  return createAgentConfig({
    type: AgentType.PLAN,
    description: 'Planning and task breakdown agent',
    systemPrompt: `You are a planning agent specialized in breaking down complex tasks into manageable steps.
Analyze the codebase and create detailed implementation plans.
Be thorough in your analysis and provide clear, actionable steps.
Consider dependencies, risks, and testing requirements.`,
    maxTokens: 4096,
    ...options
  })
}

/**
 * Create a general-purpose agent configuration
 */
export function createGeneralAgent(options = {}) {
  return createAgentConfig({
    type: AgentType.GENERAL_PURPOSE,
    description: 'General-purpose assistant agent',
    ...options
  })
}

/**
 * Spawn a subagent
 */
export async function spawnAgent(config, task, context = {}) {
  const agentId = generateAgentId()

  const agent = {
    id: agentId,
    config,
    task,
    context,
    status: AgentStatus.PENDING,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    worktreePath: null,
    worktreeBranch: null,
  }

  activeAgents.set(agentId, agent)

  agent.status = AgentStatus.RUNNING
  agent.startedAt = new Date().toISOString()

  // isolation:worktree support (CC 2.1.50 parity)
  // If the agent definition declares `isolation: worktree`, run the agent
  // inside an isolated git worktree. The worktree is auto-cleaned if the
  // agent makes no file changes; preserved otherwise.
  if (config.isolation === 'worktree') {
    try {
      const { createAgentWorktree } = await import('./worktree-isolation.mjs')
      const agentName = config.name || agentId
      const projectDir = context.cwd || process.cwd()
      const { worktreePath, branch, cleanup } = createAgentWorktree(agentName, projectDir)
      agent.worktreePath = worktreePath
      agent.worktreeBranch = branch
      // Store cleanup on the agent so it can be called after completion
      agent._worktreeCleanup = cleanup
      // Override cwd for this agent session
      context = { ...context, cwd: worktreePath }
    } catch (err) {
      // Non-fatal: fall through to normal execution with a warning
      process.stderr.write(`[agent] worktree isolation unavailable: ${err.message}\n`)
    }
  }

  return {
    agentId,
    config,
    task,
    status: agent.status,
    worktreePath: agent.worktreePath,
    worktreeBranch: agent.worktreeBranch,
    message: `Agent ${agentId} spawned for task: ${task.substring(0, 50)}...`
  }
}

/**
 * Get agent status
 */
export function getAgentStatus(agentId) {
  const agent = activeAgents.get(agentId)
  if (!agent) {
    return null
  }

  return {
    id: agent.id,
    status: agent.status,
    createdAt: agent.createdAt,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
    hasResult: agent.result !== null,
    hasError: agent.error !== null
  }
}

/**
 * Get agent result
 */
export function getAgentResult(agentId) {
  const agent = activeAgents.get(agentId)
  if (!agent) {
    return { found: false, error: 'Agent not found' }
  }

  return {
    found: true,
    id: agent.id,
    status: agent.status,
    result: agent.result,
    error: agent.error
  }
}

/**
 * Complete an agent with result
 */
export function completeAgent(agentId, result) {
  const agent = activeAgents.get(agentId)
  if (!agent) {
    return false
  }

  agent.status = AgentStatus.COMPLETED
  agent.completedAt = new Date().toISOString()
  agent.result = result

  return true
}

/**
 * Fail an agent with error
 */
export function failAgent(agentId, error) {
  const agent = activeAgents.get(agentId)
  if (!agent) {
    return false
  }

  agent.status = AgentStatus.FAILED
  agent.completedAt = new Date().toISOString()
  agent.error = error

  return true
}

/**
 * Cancel an agent
 */
export function cancelAgent(agentId) {
  const agent = activeAgents.get(agentId)
  if (!agent) {
    return false
  }

  agent.status = AgentStatus.CANCELLED
  agent.completedAt = new Date().toISOString()

  return true
}

/**
 * List all active agents
 */
export function listActiveAgents() {
  const agents = []
  for (const [id, agent] of activeAgents) {
    if (agent.status === AgentStatus.RUNNING || agent.status === AgentStatus.PENDING) {
      agents.push({
        id,
        type: agent.config.type,
        status: agent.status,
        createdAt: agent.createdAt,
        task: agent.task.substring(0, 100)
      })
    }
  }
  return agents
}

/**
 * Clean up completed agents older than specified age
 */
export function cleanupAgents(maxAgeMs = 3600000) {  // 1 hour
  const now = Date.now()

  for (const [id, agent] of activeAgents) {
    if (agent.status === AgentStatus.COMPLETED ||
        agent.status === AgentStatus.FAILED ||
        agent.status === AgentStatus.CANCELLED) {
      const completedTime = new Date(agent.completedAt).getTime()
      if (now - completedTime > maxAgeMs) {
        activeAgents.delete(id)
      }
    }
  }
}

/**
 * Load custom agent definition from file (project first, then personal)
 */
export function loadCustomAgent(name) {
  // Check project dir first
  const projectPath = path.join(getProjectAgentsDir(), `${name}.json`)
  if (fs.existsSync(projectPath)) {
    try {
      return JSON.parse(fs.readFileSync(projectPath, 'utf8'))
    } catch { /* fall through */ }
  }

  // Then personal dir
  ensureAgentsDir()
  const personalPath = path.join(PERSONAL_AGENTS_DIR, `${name}.json`)
  if (!fs.existsSync(personalPath)) return null

  try {
    return JSON.parse(fs.readFileSync(personalPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Save custom agent definition
 * @param {string} name - Agent name
 * @param {Object} config - Agent config
 * @param {'personal'|'project'} [location='personal'] - Where to save
 */
export function saveCustomAgent(name, config, location = 'personal') {
  const dir = location === 'project' ? getProjectAgentsDir() : PERSONAL_AGENTS_DIR
  ensureDir(dir)

  const agentPath = path.join(dir, `${name}.json`)
  fs.writeFileSync(agentPath, JSON.stringify(config, null, 2))

  return agentPath
}

/**
 * Delete a custom agent definition (checks project first, then personal)
 */
export function deleteCustomAgent(name) {
  // Check project dir first
  const projectPath = path.join(getProjectAgentsDir(), `${name}.json`)
  if (fs.existsSync(projectPath)) {
    fs.unlinkSync(projectPath)
    return true
  }
  // Then personal dir
  const personalPath = path.join(PERSONAL_AGENTS_DIR, `${name}.json`)
  if (fs.existsSync(personalPath)) {
    fs.unlinkSync(personalPath)
    return true
  }
  return false
}

/**
 * List available custom agents from both personal and project dirs
 */
export function listCustomAgents() {
  const agents = []
  const seen = new Set()

  // Scan a directory for agent JSON files
  function scanDir(dir, source) {
    try {
      if (!fs.existsSync(dir)) return
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      for (const f of files) {
        const name = f.replace('.json', '')
        if (seen.has(name)) continue // project overrides personal
        seen.add(name)
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf8')
          const config = JSON.parse(content)
          agents.push({
            name,
            type: config?.type || AgentType.CUSTOM,
            description: config?.description || '',
            model: config?.model || null,
            source,
          })
        } catch {
          agents.push({ name, type: AgentType.CUSTOM, description: '', model: null, source })
        }
      }
    } catch {
      // dir doesn't exist or is unreadable
    }
  }

  // Project agents first (take priority)
  scanDir(getProjectAgentsDir(), 'project')
  // Personal agents (openclaude)
  scanDir(PERSONAL_AGENTS_DIR, 'personal')
  // Shared global agents (read-only) — tag as 'claude', upgrade to 'both' if duplicate
  const claudeAgentsDir = path.join(os.homedir(), '.claude', 'agents')
  try {
    if (fs.existsSync(claudeAgentsDir)) {
      const files = fs.readdirSync(claudeAgentsDir).filter(f => f.endsWith('.json'))
      for (const f of files) {
        const name = f.replace('.json', '')
        const existing = agents.find(a => a.name === name)
        if (existing) {
          existing.source = 'both'
          continue
        }
        try {
          const content = fs.readFileSync(path.join(claudeAgentsDir, f), 'utf8')
          const config = JSON.parse(content)
          agents.push({
            name,
            type: config?.type || AgentType.CUSTOM,
            description: config?.description || '',
            model: config?.model || null,
            source: 'claude',
          })
        } catch {
          agents.push({ name, type: AgentType.CUSTOM, description: '', model: null, source: 'claude' })
        }
      }
    }
  } catch {}

  return agents
}

/**
 * Resume a paused agent
 */
export function resumeAgent(agentId, transcript = null) {
  const agent = activeAgents.get(agentId)
  if (!agent) {
    return { success: false, error: 'Agent not found' }
  }

  if (agent.status !== AgentStatus.PENDING) {
    return { success: false, error: 'Agent cannot be resumed from current status' }
  }

  agent.status = AgentStatus.RUNNING
  agent.context.resumeTranscript = transcript

  return {
    success: true,
    agentId,
    message: 'Agent resumed'
  }
}

/**
 * Get available agent types
 */
export function getAgentTypes() {
  return [
    {
      type: AgentType.EXPLORE,
      name: 'Explore',
      description: 'Fast codebase exploration using smaller models',
      model: AgentModels[AgentType.EXPLORE],
      tools: AgentTools[AgentType.EXPLORE]
    },
    {
      type: AgentType.PLAN,
      name: 'Plan',
      description: 'Planning and task breakdown',
      model: AgentModels[AgentType.PLAN],
      tools: AgentTools[AgentType.PLAN]
    },
    {
      type: AgentType.GENERAL_PURPOSE,
      name: 'General Purpose',
      description: 'General-purpose assistant with all tools',
      model: AgentModels[AgentType.GENERAL_PURPOSE],
      tools: AgentTools[AgentType.GENERAL_PURPOSE]
    }
  ]
}

export default {
  AgentType,
  AgentStatus,
  AgentModels,
  AgentTools,
  createAgentConfig,
  createExploreAgent,
  createPlanAgent,
  createGeneralAgent,
  spawnAgent,
  getAgentStatus,
  getAgentResult,
  completeAgent,
  failAgent,
  cancelAgent,
  listActiveAgents,
  cleanupAgents,
  getProjectAgentsDir,
  loadCustomAgent,
  saveCustomAgent,
  deleteCustomAgent,
  listCustomAgents,
  resumeAgent,
  getAgentTypes
}
