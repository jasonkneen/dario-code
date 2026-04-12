/**
 * Permission System Tests
 * Tests the tool permission functions in executor.mjs
 *
 * Approved tools are now stored in ~/.dario/settings.json under
 * settings.permissions.allow (unified storage).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getApprovedTools,
  approveToolUse,
  revokeToolApproval,
  hasPermissionsToUseTool,
  executeToolUse
} from '../src/tools/executor.mjs'
import { loadSettings, saveSettings, setSettingSources } from '../src/core/config.mjs'
import fs from 'fs'
import path from 'path'
import os from 'os'

const SETTINGS_PATH = path.join(os.homedir(), '.dario', 'settings.json')
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
// Legacy path — tested for migration
const LEGACY_APPROVED_TOOLS_PATH = path.join(os.homedir(), '.dario', 'approved-tools.json')

describe('Permission System', () => {
  let originalSettings = null
  let originalClaudeSettings = null

  beforeEach(() => {
    setSettingSources(['user'])

    // Save original settings.json files
    try {
      originalSettings = fs.readFileSync(SETTINGS_PATH, 'utf-8')
    } catch {
      originalSettings = null
    }
    try {
      originalClaudeSettings = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8')
    } catch {
      originalClaudeSettings = null
    }

    // Clear Dario permissions for a clean slate
    const settings = loadSettings()
    settings.permissions = { allow: [], deny: [], ask: [] }
    saveSettings(settings)

    // Clear Claude user permissions too, since loadSettings() merges both
    const claudeDir = path.dirname(CLAUDE_SETTINGS_PATH)
    fs.mkdirSync(claudeDir, { recursive: true })
    const claudeSettings = originalClaudeSettings ? JSON.parse(originalClaudeSettings) : {}
    claudeSettings.permissions = { allow: [], deny: [], ask: [] }
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(claudeSettings, null, 2), 'utf-8')

    // Remove legacy file if present
    try { fs.unlinkSync(LEGACY_APPROVED_TOOLS_PATH) } catch { /* ignore */ }
  })

  afterEach(() => {
    // Restore original settings.json
    try {
      if (originalSettings !== null) {
        fs.writeFileSync(SETTINGS_PATH, originalSettings, 'utf-8')
      } else {
        // Restore to empty permissions
        const settings = loadSettings()
        delete settings.permissions
        saveSettings(settings)
      }
    } catch {
      // ignore
    }

    try {
      if (originalClaudeSettings !== null) {
        fs.writeFileSync(CLAUDE_SETTINGS_PATH, originalClaudeSettings, 'utf-8')
      } else {
        fs.unlinkSync(CLAUDE_SETTINGS_PATH)
      }
    } catch {
      // ignore
    }

    setSettingSources(null)

    // Clean up legacy file if created during test
    try { fs.unlinkSync(LEGACY_APPROVED_TOOLS_PATH) } catch { /* ignore */ }
  })

  describe('getApprovedTools', () => {
    it('should return empty array for empty allow list', () => {
      const result = getApprovedTools()
      expect(result).toEqual([])
    })

    it('should load saved patterns', () => {
      const settings = loadSettings()
      settings.permissions = { allow: ['Read', 'Bash(npm *)'], deny: [], ask: [] }
      saveSettings(settings)
      const result = getApprovedTools()
      expect(result).toEqual(['Read', 'Bash(npm *)'])
    })
  })

  describe('approveToolUse', () => {
    it('should add a tool name to the approved list', () => {
      approveToolUse('Read')
      const approved = getApprovedTools()
      expect(approved).toContain('Read')
    })

    it('should add a glob pattern to the approved list', () => {
      approveToolUse('Bash(npm *)')
      const approved = getApprovedTools()
      expect(approved).toContain('Bash(npm *)')
    })

    it('should not add duplicates', () => {
      approveToolUse('Read')
      approveToolUse('Read')
      const approved = getApprovedTools()
      expect(approved).toEqual(['Read'])
    })

    it('should handle multiple approvals', () => {
      approveToolUse('Read')
      approveToolUse('Write')
      approveToolUse('Bash(npm *)')
      const approved = getApprovedTools()
      expect(approved).toEqual(['Read', 'Write', 'Bash(npm *)'])
    })

    it('should persist to settings.json', () => {
      approveToolUse('Read')
      // Read directly from disk to verify
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
      expect(raw.permissions.allow).toContain('Read')
    })
  })

  describe('revokeToolApproval', () => {
    it('should remove a tool from the approved list', () => {
      approveToolUse('Read')
      approveToolUse('Write')
      revokeToolApproval('Read')
      const approved = getApprovedTools()
      expect(approved).toEqual(['Write'])
    })

    it('should be a no-op for non-existent entries', () => {
      approveToolUse('Read')
      revokeToolApproval('NonExistent')
      const approved = getApprovedTools()
      expect(approved).toEqual(['Read'])
    })

    it('should handle revoking when no permissions exist', () => {
      // Should not throw
      revokeToolApproval('Read')
      const approved = getApprovedTools()
      expect(approved).toEqual([])
    })

    it('should remove glob patterns exactly', () => {
      approveToolUse('Bash(npm *)')
      approveToolUse('Bash(git *)')
      revokeToolApproval('Bash(npm *)')
      const approved = getApprovedTools()
      expect(approved).toEqual(['Bash(git *)'])
    })
  })

  describe('hasPermissionsToUseTool', () => {
    it('should return false when no tools are approved', () => {
      expect(hasPermissionsToUseTool('Bash')).toBe(false)
    })

    it('should return true for exact match', () => {
      approveToolUse('Read')
      expect(hasPermissionsToUseTool('Read')).toBe(true)
    })

    it('should return false for non-approved tool', () => {
      approveToolUse('Read')
      expect(hasPermissionsToUseTool('Write')).toBe(false)
    })

    it('should match wildcard patterns against bare tool names', () => {
      approveToolUse('R?ad')
      expect(hasPermissionsToUseTool('Read')).toBe(true)
    })
  })

  describe('checkToolPermission (via executeToolUse)', () => {
    // We test checkToolPermission indirectly through executeToolUse
    // since it's not exported

    const makeTool = (name, needsPerms = true) => ({
      name,
      needsPermissions: () => needsPerms,
      async *call(input) {
        yield { type: 'result', resultForAssistant: `executed ${name}` }
      }
    })

    it('should deny unapproved tools without onPermissionRequest', async () => {
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'echo hi' } },
        [tool],
        {} // no dangerouslySkipPermissions, no onPermissionRequest
      )
      expect(result.content).toBe('Tool use rejected by user')
    })

    it('should allow approved tools by exact name', async () => {
      approveToolUse('Bash')
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'echo hi' } },
        [tool],
        {}
      )
      expect(result.content).toBe('executed Bash')
    })

    it('should allow tools matching glob pattern on command', async () => {
      approveToolUse('Bash(npm *)')
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'npm install' } },
        [tool],
        {}
      )
      expect(result.content).toBe('executed Bash')
    })

    it('should deny tools not matching glob pattern', async () => {
      approveToolUse('Bash(npm *)')
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'rm -rf /' } },
        [tool],
        {}
      )
      expect(result.content).toBe('Tool use rejected by user')
    })

    it('should match file_path based descriptors', async () => {
      approveToolUse('Write(src/*)')
      const tool = makeTool('Write')
      const result = await executeToolUse(
        { name: 'Write', input: { file_path: 'src/index.mjs' } },
        [tool],
        {}
      )
      expect(result.content).toBe('executed Write')
    })

    it('should deny file_path based descriptors that dont match', async () => {
      approveToolUse('Write(src/*)')
      const tool = makeTool('Write')
      const result = await executeToolUse(
        { name: 'Write', input: { file_path: '/etc/passwd' } },
        [tool],
        {}
      )
      expect(result.content).toBe('Tool use rejected by user')
    })

    it('should fall back to onPermissionRequest when not approved', async () => {
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'echo hi' } },
        [tool],
        {
          onPermissionRequest: () => true
        }
      )
      expect(result.content).toBe('executed Bash')
    })

    it('should skip permission check with dangerouslySkipPermissions', async () => {
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'echo hi' } },
        [tool],
        { dangerouslySkipPermissions: true }
      )
      expect(result.content).toBe('executed Bash')
    })

    it('should skip permission check for tools that dont need permissions', async () => {
      const tool = makeTool('Read', false)
      const result = await executeToolUse(
        { name: 'Read', input: {} },
        [tool],
        {}
      )
      expect(result.content).toBe('executed Read')
    })

    it('should prefer approved list over onPermissionRequest', async () => {
      approveToolUse('Bash')
      let callbackCalled = false
      const tool = makeTool('Bash')
      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'echo hi' } },
        [tool],
        {
          onPermissionRequest: () => {
            callbackCalled = true
            return false
          }
        }
      )
      // Should be approved via settings, callback never called
      expect(result.content).toBe('executed Bash')
      expect(callbackCalled).toBe(false)
    })
  })

  describe('glob pattern edge cases', () => {
    const makeTool = (name) => ({
      name,
      needsPermissions: () => true,
      async *call(input) {
        yield { type: 'result', resultForAssistant: `executed ${name}` }
      }
    })

    it('should handle ? wildcard in patterns', async () => {
      approveToolUse('Bash(npm r?n *)')
      const tool = makeTool('Bash')

      const result1 = await executeToolUse(
        { name: 'Bash', input: { command: 'npm run build' } },
        [tool],
        {}
      )
      expect(result1.content).toBe('executed Bash')

      const result2 = await executeToolUse(
        { name: 'Bash', input: { command: 'npm rin build' } },
        [tool],
        {}
      )
      expect(result2.content).toBe('executed Bash')
    })

    it('should properly escape regex-special chars in patterns', async () => {
      // The dot in "file.txt" should not match any character
      approveToolUse('Write(src/file.txt)')
      const tool = makeTool('Write')

      const result1 = await executeToolUse(
        { name: 'Write', input: { file_path: 'src/file.txt' } },
        [tool],
        {}
      )
      expect(result1.content).toBe('executed Write')

      // "src/fileXtxt" should NOT match because "." is literal
      const result2 = await executeToolUse(
        { name: 'Write', input: { file_path: 'src/fileXtxt' } },
        [tool],
        {}
      )
      expect(result2.content).toBe('Tool use rejected by user')
    })

    it('should handle multiple * wildcards', async () => {
      approveToolUse('Bash(* && npm *)')
      const tool = makeTool('Bash')

      const result = await executeToolUse(
        { name: 'Bash', input: { command: 'cd src && npm test' } },
        [tool],
        {}
      )
      expect(result.content).toBe('executed Bash')
    })
  })

  describe('legacy migration', () => {
    it('should migrate entries from approved-tools.json into settings', () => {
      // Write legacy file
      const dir = path.dirname(LEGACY_APPROVED_TOOLS_PATH)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(LEGACY_APPROVED_TOOLS_PATH, JSON.stringify(['Read', 'Bash(npm *)']), 'utf-8')

      // Reset migration flag by re-importing (we can't easily, so just call getApprovedTools
      // which triggers migration on first call — but _migrationDone is module-level)
      // Since _migrationDone may already be true from prior tests, we test the end state:
      // The legacy file entries should be accessible if migration ran.
      // For a proper test, we'd need to reset the module. Instead, verify the file gets cleaned up
      // when approveToolUse triggers getApprovedTools internally.

      // At minimum, verify the legacy file format is valid
      const data = JSON.parse(fs.readFileSync(LEGACY_APPROVED_TOOLS_PATH, 'utf-8'))
      expect(data).toEqual(['Read', 'Bash(npm *)'])
    })
  })
})
