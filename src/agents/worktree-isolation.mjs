/**
 * Worktree Isolation for Named Agents (CC 2.1.50 parity)
 *
 * When an agent declares `isolation: worktree` in its frontmatter, it runs
 * inside an isolated git worktree rather than the main working tree. This
 * prevents the agent from accidentally modifying the main working tree until
 * its changes are explicitly merged.
 *
 * Behaviour:
 * - A temp branch + worktree is created before the agent runs.
 * - If the agent makes no file changes, the worktree is auto-cleaned.
 * - If the agent makes changes, the result includes the worktree path and
 *   branch name so the user can review and merge manually.
 *
 * Requires: git >= 2.5
 */

import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Check whether the current directory is a git repo
 */
function isGitRepo(dir) {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Generate a short unique branch name for the agent worktree
 */
function worktreeBranchName(agentName) {
  const ts = Date.now().toString(36)
  const safe = agentName.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  return `agent/${safe}-${ts}`
}

/**
 * Create a git worktree for an agent session.
 *
 * @param {string} agentName - Name of the agent (used in branch name)
 * @param {string} projectDir - The project root (must be a git repo)
 * @returns {{ worktreePath: string, branch: string, cleanup: Function }}
 */
export async function createAgentWorktree(agentName, projectDir = process.cwd()) {
  if (!isGitRepo(projectDir)) {
    throw new Error(
      `isolation:worktree requires a git repository. '${projectDir}' is not a git repo.`
    )
  }

  const branch = worktreeBranchName(agentName)
  const worktreePath = path.join(os.tmpdir(), `occ-agent-${branch.replace(/\//g, '-')}`)

  // Create the branch and worktree
  execSync(`git worktree add -b ${branch} ${JSON.stringify(worktreePath)}`, {
    cwd: projectDir,
    stdio: 'pipe',
  })

  /**
   * Cleanup function — removes the worktree and branch.
   * If `keepIfChanged` is true and there are uncommitted changes,
   * the worktree + branch are preserved for the user to review.
   *
   * @param {{ keepIfChanged?: boolean }} options
   * @returns {{ kept: boolean, worktreePath: string, branch: string }}
   */
  async function cleanup({ keepIfChanged = true } = {}) {
    try {
      if (keepIfChanged) {
        // Check for uncommitted changes or commits ahead of HEAD
        const statusOut = spawnSync('git', ['status', '--porcelain'], {
          cwd: worktreePath, encoding: 'utf-8'
        })
        const logOut = spawnSync('git', ['log', 'HEAD..@{upstream}', '--oneline'], {
          cwd: worktreePath, encoding: 'utf-8'
        })
        const hasChanges = (statusOut.stdout || '').trim().length > 0
        const hasCommits = (logOut.stdout || '').trim().length > 0

        if (hasChanges || hasCommits) {
          return { kept: true, worktreePath, branch }
        }
      }

      // Fire WorktreeRemove hook before removal
      try {
        const { runWorktreeRemove } = await import('../core/hooks.mjs')
        await runWorktreeRemove(worktreePath, { branch, projectDir })
      } catch (e) {
        // Non-fatal: hook failure should not prevent cleanup
      }

      // No changes — remove worktree and branch
      execSync(`git worktree remove --force ${JSON.stringify(worktreePath)}`, {
        cwd: projectDir, stdio: 'pipe'
      })
      execSync(`git branch -d ${branch}`, { cwd: projectDir, stdio: 'pipe' })
      return { kept: false, worktreePath, branch }
    } catch {
      // Best-effort cleanup
      return { kept: true, worktreePath, branch }
    }
  }

  return { worktreePath, branch, cleanup }
}

/**
 * High-level helper: run an agent task in a worktree.
 * Creates the worktree, runs `taskFn(worktreePath)`, then cleans up.
 *
 * @param {string} agentName
 * @param {Function} taskFn - async (worktreePath: string) => any
 * @param {string} projectDir
 * @returns {Promise<{ result: any, kept: boolean, worktreePath: string, branch: string }>}
 */
export async function runInWorktree(agentName, taskFn, projectDir = process.cwd()) {
  const { worktreePath, branch, cleanup } = createAgentWorktree(agentName, projectDir)
  let result
  try {
    result = await taskFn(worktreePath)
  } finally {
    const cleanupResult = cleanup({ keepIfChanged: true })
    return { result, ...cleanupResult }
  }
}
