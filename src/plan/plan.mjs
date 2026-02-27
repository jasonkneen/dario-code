/**
 * OpenClaude Plan Mode
 *
 * Provides planning functionality for complex multi-step tasks:
 * - EnterPlanMode: Transitions to planning phase
 * - ExitPlanMode: Completes planning and awaits approval
 * - Plan file generation and management
 * - Plan execution tracking
 *
 * Plan Mode Flow:
 * 1. User requests a complex task
 * 2. Claude enters plan mode (EnterPlanMode tool)
 * 3. Claude explores codebase and writes plan to file
 * 4. Claude exits plan mode (ExitPlanMode tool)
 * 5. User reviews and approves/modifies plan
 * 6. Claude executes plan step by step
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

// Plan state
let currentPlan = null
let planMode = false

// Default plan directory
const PLAN_DIR = path.join(os.homedir(), '.openclaude', 'plans')

// Plan status
export const PlanStatus = {
  DRAFT: 'draft',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPROVED: 'approved',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
}

/**
 * Ensure plan directory exists
 */
function ensurePlanDir() {
  if (!fs.existsSync(PLAN_DIR)) {
    fs.mkdirSync(PLAN_DIR, { recursive: true })
  }
}

/**
 * Generate a plan ID
 */
function generatePlanId() {
  return `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Get plan file path
 */
function getPlanPath(planId) {
  return path.join(PLAN_DIR, `${planId}.md`)
}

/**
 * Create a new plan
 */
export function createPlan(options = {}) {
  ensurePlanDir()

  const planId = generatePlanId()
  const plan = {
    id: planId,
    title: options.title || 'Untitled Plan',
    description: options.description || '',
    status: PlanStatus.DRAFT,
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedSteps: 0,
    totalSteps: 0
  }

  currentPlan = plan
  savePlan(plan)

  return plan
}

/**
 * Save plan to file
 */
export function savePlan(plan) {
  ensurePlanDir()

  const planPath = getPlanPath(plan.id)
  const content = formatPlanMarkdown(plan)

  fs.writeFileSync(planPath, content)

  // Also save JSON for parsing
  const jsonPath = getPlanPath(plan.id).replace('.md', '.json')
  fs.writeFileSync(jsonPath, JSON.stringify(plan, null, 2))

  return planPath
}

/**
 * Load plan from file
 */
export function loadPlan(planId) {
  const jsonPath = getPlanPath(planId).replace('.md', '.json')

  if (!fs.existsSync(jsonPath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
}

/**
 * Format plan as Markdown
 */
function formatPlanMarkdown(plan) {
  const lines = [
    `# ${plan.title}`,
    '',
    `**Status**: ${plan.status}`,
    `**Created**: ${plan.createdAt}`,
    `**Updated**: ${plan.updatedAt}`,
    '',
    '## Description',
    '',
    plan.description || '_No description_',
    '',
    '## Implementation Steps',
    ''
  ]

  if (plan.steps.length === 0) {
    lines.push('_No steps defined yet_')
  } else {
    plan.steps.forEach((step, index) => {
      const checkbox = step.completed ? '[x]' : '[ ]'
      lines.push(`${index + 1}. ${checkbox} ${step.title}`)
      if (step.description) {
        lines.push(`   - ${step.description}`)
      }
      if (step.files && step.files.length > 0) {
        lines.push(`   - Files: ${step.files.join(', ')}`)
      }
    })
  }

  lines.push('')
  lines.push('---')
  lines.push(`_Plan ID: ${plan.id}_`)

  return lines.join('\n')
}

/**
 * Add step to plan
 */
export function addStep(planId, step) {
  const plan = loadPlan(planId) || currentPlan

  if (!plan) {
    throw new Error(`Plan not found: ${planId}`)
  }

  const newStep = {
    id: plan.steps.length + 1,
    title: step.title,
    description: step.description || '',
    files: step.files || [],
    completed: false,
    completedAt: null
  }

  plan.steps.push(newStep)
  plan.totalSteps = plan.steps.length
  plan.updatedAt = new Date().toISOString()

  savePlan(plan)
  currentPlan = plan

  return newStep
}

/**
 * Complete a step
 */
export function completeStep(planId, stepId) {
  const plan = loadPlan(planId) || currentPlan

  if (!plan) {
    throw new Error(`Plan not found: ${planId}`)
  }

  const step = plan.steps.find(s => s.id === stepId)
  if (!step) {
    throw new Error(`Step not found: ${stepId}`)
  }

  step.completed = true
  step.completedAt = new Date().toISOString()
  plan.completedSteps = plan.steps.filter(s => s.completed).length
  plan.updatedAt = new Date().toISOString()

  if (plan.completedSteps === plan.totalSteps) {
    plan.status = PlanStatus.COMPLETED
  }

  savePlan(plan)
  currentPlan = plan

  return step
}

/**
 * Enter plan mode
 */
export function enterPlanMode(options = {}) {
  if (planMode) {
    return { success: false, message: 'Already in plan mode' }
  }

  planMode = true
  currentPlan = createPlan(options)

  return {
    success: true,
    planId: currentPlan.id,
    planPath: getPlanPath(currentPlan.id),
    message: `Entered plan mode. Plan file: ${getPlanPath(currentPlan.id)}`
  }
}

/**
 * Exit plan mode
 */
export function exitPlanMode() {
  if (!planMode) {
    return { success: false, message: 'Not in plan mode' }
  }

  if (!currentPlan) {
    planMode = false
    return { success: false, message: 'No plan created' }
  }

  currentPlan.status = PlanStatus.AWAITING_APPROVAL
  currentPlan.updatedAt = new Date().toISOString()
  savePlan(currentPlan)

  const result = {
    success: true,
    planId: currentPlan.id,
    planPath: getPlanPath(currentPlan.id),
    message: `Plan ready for review: ${getPlanPath(currentPlan.id)}`
  }

  planMode = false

  return result
}

// Callbacks invoked when a plan is approved (CC 2.1.x: clear context on accept)
let _onApproveCallbacks = []

/**
 * Register a callback to be called when a plan is approved.
 * The TUI uses this to compact/clear the conversation history,
 * giving the execution phase a full context window (CC 2.1.x parity).
 *
 * @param {Function} callback - (plan) => void | Promise<void>
 * @returns {Function} unregister
 */
export function onPlanApproved(callback) {
  _onApproveCallbacks.push(callback)
  return () => {
    _onApproveCallbacks = _onApproveCallbacks.filter(cb => cb !== callback)
  }
}

/**
 * Approve plan.
 * After approval, fires all onPlanApproved callbacks so the conversation
 * history can be compacted — mirrors CC 2.1.x behaviour where accepting
 * a plan clears the context window before execution begins.
 */
export function approvePlan(planId) {
  const plan = loadPlan(planId)

  if (!plan) {
    return { success: false, message: `Plan not found: ${planId}` }
  }

  if (plan.status !== PlanStatus.AWAITING_APPROVAL) {
    return { success: false, message: `Plan is not awaiting approval: ${plan.status}` }
  }

  plan.status = PlanStatus.IN_PROGRESS
  plan.updatedAt = new Date().toISOString()
  savePlan(plan)

  currentPlan = plan

  // Notify listeners (e.g. the TUI compaction handler) asynchronously.
  // We don't await here to keep this function synchronous; listeners should
  // handle their own async work and error recovery.
  for (const cb of _onApproveCallbacks) {
    try { Promise.resolve(cb(plan)).catch(() => {}) } catch {}
  }

  return {
    success: true,
    planId: plan.id,
    message: 'Plan approved and ready for execution'
  }
}

/**
 * Cancel plan
 */
export function cancelPlan(planId) {
  const plan = loadPlan(planId || currentPlan?.id)

  if (!plan) {
    return { success: false, message: 'No plan to cancel' }
  }

  plan.status = PlanStatus.CANCELLED
  plan.updatedAt = new Date().toISOString()
  savePlan(plan)

  if (currentPlan?.id === plan.id) {
    currentPlan = null
    planMode = false
  }

  return {
    success: true,
    planId: plan.id,
    message: 'Plan cancelled'
  }
}

/**
 * Get current plan state
 */
export function getCurrentPlan() {
  return currentPlan
}

/**
 * Check if in plan mode
 */
export function isInPlanMode() {
  return planMode
}

/**
 * List all plans
 */
export function listPlans() {
  ensurePlanDir()

  const files = fs.readdirSync(PLAN_DIR)
    .filter(f => f.endsWith('.json'))

  return files.map(f => {
    try {
      const content = fs.readFileSync(path.join(PLAN_DIR, f), 'utf8')
      return JSON.parse(content)
    } catch (e) {
      return null
    }
  }).filter(Boolean)
}

/**
 * Update plan content
 */
export function updatePlan(planId, updates) {
  const plan = loadPlan(planId)

  if (!plan) {
    throw new Error(`Plan not found: ${planId}`)
  }

  Object.assign(plan, updates, {
    updatedAt: new Date().toISOString()
  })

  savePlan(plan)

  if (currentPlan?.id === planId) {
    currentPlan = plan
  }

  return plan
}

/**
 * Get plan progress
 */
export function getPlanProgress(planId) {
  const plan = loadPlan(planId || currentPlan?.id)

  if (!plan) {
    return null
  }

  return {
    planId: plan.id,
    status: plan.status,
    completedSteps: plan.completedSteps,
    totalSteps: plan.totalSteps,
    progress: plan.totalSteps > 0 ? (plan.completedSteps / plan.totalSteps * 100).toFixed(1) : 0,
    currentStep: plan.steps.find(s => !s.completed)
  }
}

export default {
  PlanStatus,
  createPlan,
  savePlan,
  loadPlan,
  addStep,
  completeStep,
  enterPlanMode,
  exitPlanMode,
  approvePlan,
  onPlanApproved,
  cancelPlan,
  getCurrentPlan,
  isInPlanMode,
  listPlans,
  updatePlan,
  getPlanProgress
}
