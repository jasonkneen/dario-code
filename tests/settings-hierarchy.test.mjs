/**
 * Tests for 5-level settings hierarchy
 *
 * Levels (lowest to highest precedence):
 *   user → project → local → CLI → managed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock utils before importing config
vi.mock('../src/core/utils.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fileExists: vi.fn(() => false),
    readFile: vi.fn(() => '{}'),
  }
})

// We need to control os.homedir and process.platform
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(() => '/mock/home'),
    },
    homedir: vi.fn(() => '/mock/home'),
  }
})

import { fileExists, readFile } from '../src/core/utils.mjs'
import {
  loadSettings,
  setCliSettings,
  setSettingSources,
  deepMergeSettings,
  getManagedSettingsPath,
} from '../src/core/config.mjs'

// Helper: set up fileExists and readFile mocks for specific paths
function mockFile(pathPattern, content) {
  fileExists.mockImplementation((p) => {
    if (typeof pathPattern === 'function') return pathPattern(p)
    if (pathPattern instanceof RegExp) return pathPattern.test(p)
    return p === pathPattern
  })
  readFile.mockImplementation((p) => {
    if (typeof content === 'function') return content(p)
    return JSON.stringify(content)
  })
}

// Helper: configure multiple mock files at once
function mockFiles(fileMap) {
  fileExists.mockImplementation((p) => {
    return Object.keys(fileMap).some((key) => p.includes(key))
  })
  readFile.mockImplementation((p) => {
    for (const [key, val] of Object.entries(fileMap)) {
      if (p.includes(key)) return JSON.stringify(val)
    }
    return '{}'
  })
}

describe('5-level settings hierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCliSettings(null)
    setSettingSources(null)
  })

  describe('SET-01: 5-level precedence (managed > CLI > local > project > user)', () => {
    it('managed settings override all other levels', () => {
      // All 5 levels set "theme" -- managed should win
      const fileMap = {
        // user: ~/.claude/settings.json and ~/.dario/settings.json
        '.claude/settings.json': { theme: 'user-theme' },
        '.dario/settings.json': { theme: 'user-dario-theme' },
        // project: cwd/.claude/settings.json
        '.claude/settings.json': { theme: 'project-theme' },
        // local: cwd/.claude/settings.local.json
        'settings.local.json': { theme: 'local-theme' },
        // managed: platform path
        'managed-settings.json': { theme: 'managed-theme' },
      }

      // Use more fine-grained mock for all 5 levels
      fileExists.mockImplementation(() => true)
      readFile.mockImplementation((p) => {
        if (p.includes('managed-settings')) return JSON.stringify({ theme: 'managed-theme' })
        if (p.includes('settings.local')) return JSON.stringify({ theme: 'local-theme' })
        if (p.includes('.dario') && p.endsWith('settings.json')) return JSON.stringify({ theme: 'user-dario-theme' })
        if (p.includes('.claude') && p.endsWith('settings.json')) return JSON.stringify({ theme: 'project-theme' })
        return '{}'
      })

      setCliSettings({ theme: 'cli-theme' })
      const result = loadSettings()
      expect(result.theme).toBe('managed-theme')
    })

    it('CLI settings override local, project, and user but not managed', () => {
      // No managed settings file
      fileExists.mockImplementation((p) => {
        if (p.includes('managed-settings')) return false
        return true
      })
      readFile.mockImplementation((p) => {
        if (p.includes('settings.local')) return JSON.stringify({ theme: 'local-theme' })
        if (p.endsWith('settings.json')) return JSON.stringify({ theme: 'file-theme' })
        return '{}'
      })

      setCliSettings({ theme: 'cli-theme' })
      const result = loadSettings()
      expect(result.theme).toBe('cli-theme')
    })

    it('a key that exists only at one level appears in the merged result', () => {
      fileExists.mockImplementation((p) => {
        // Only user-level .dario/settings.json exists
        if (p.includes('.dario') && p.endsWith('settings.json') && !p.includes('settings.local')) return true
        return false
      })
      readFile.mockImplementation((p) => {
        if (p.includes('.dario') && p.endsWith('settings.json')) {
          return JSON.stringify({ uniqueKey: 'only-here' })
        }
        return '{}'
      })

      const result = loadSettings()
      expect(result.uniqueKey).toBe('only-here')
    })
  })

  describe('SET-02: deep merge preserves nested keys across levels', () => {
    it('merges nested objects from different levels without destroying sibling keys', () => {
      const userSettings = {
        permissions: { allow: ['A'] },
      }
      const projectSettings = {
        permissions: { deny: ['B'] },
      }

      const result = deepMergeSettings(userSettings, projectSettings)
      expect(result.permissions.allow).toBeDefined()
      expect(result.permissions.deny).toBeDefined()
      expect(result.permissions.allow).toContain('A')
      expect(result.permissions.deny).toContain('B')
    })

    it('merges nested objects 3+ levels deep correctly', () => {
      const base = {
        sandbox: { permissions: { read: ['/tmp'] } },
      }
      const overlay = {
        sandbox: { permissions: { write: ['/out'] } },
      }

      const result = deepMergeSettings(base, overlay)
      expect(result.sandbox.permissions.read).toContain('/tmp')
      expect(result.sandbox.permissions.write).toContain('/out')
    })
  })

  describe('SET-03: array concatenation for permission keys', () => {
    it('concatenates permissions.allow arrays instead of replacing', () => {
      const base = { permissions: { allow: ['A', 'B'] } }
      const overlay = { permissions: { allow: ['C'] } }

      const result = deepMergeSettings(base, overlay)
      expect(result.permissions.allow).toEqual(expect.arrayContaining(['A', 'B', 'C']))
      expect(result.permissions.allow).toHaveLength(3)
    })

    it('deduplicates array entries after concatenation', () => {
      const base = { permissions: { allow: ['A'] } }
      const overlay = { permissions: { allow: ['A', 'B'] } }

      const result = deepMergeSettings(base, overlay)
      expect(result.permissions.allow).toEqual(expect.arrayContaining(['A', 'B']))
      expect(result.permissions.allow).toHaveLength(2)
    })

    it('concatenates permissions.deny arrays', () => {
      const base = { permissions: { deny: ['X'] } }
      const overlay = { permissions: { deny: ['Y'] } }

      const result = deepMergeSettings(base, overlay)
      expect(result.permissions.deny).toEqual(expect.arrayContaining(['X', 'Y']))
    })

    it('concatenates permissions.ask arrays', () => {
      const base = { permissions: { ask: ['tool1'] } }
      const overlay = { permissions: { ask: ['tool2'] } }

      const result = deepMergeSettings(base, overlay)
      expect(result.permissions.ask).toEqual(expect.arrayContaining(['tool1', 'tool2']))
    })
  })

  describe('SET-04: local settings from settings.local.json', () => {
    it('loads settings.local.json at local precedence (above project, below CLI)', () => {
      // Set up: project has theme=project, local has theme=local, no CLI/managed
      setSettingSources(['project', 'local'])

      fileExists.mockImplementation((p) => {
        if (p.includes('settings.local')) return true
        if (p.endsWith('settings.json') && !p.includes('settings.local')) return true
        return false
      })
      readFile.mockImplementation((p) => {
        if (p.includes('settings.local')) return JSON.stringify({ theme: 'local-theme' })
        if (p.endsWith('settings.json')) return JSON.stringify({ theme: 'project-theme' })
        return '{}'
      })

      const result = loadSettings()
      expect(result.theme).toBe('local-theme')
    })
  })

  describe('SET-05: managed settings per platform', () => {
    it('returns {} when managed settings file is missing', () => {
      fileExists.mockImplementation(() => false)
      setSettingSources(['managed'])

      const result = loadSettings()
      expect(result).toEqual({})
    })

    it('returns correct managed path for darwin', () => {
      const managedPath = getManagedSettingsPath('darwin', '/mock/home')
      expect(managedPath).toContain('Library/Application Support')
      expect(managedPath).toContain('managed-settings.json')
    })

    it('returns correct managed path for linux', () => {
      const managedPath = getManagedSettingsPath('linux', '/mock/home')
      expect(managedPath).toBe('/etc/claude-code/managed-settings.json')
    })

    it('returns correct managed path for win32', () => {
      const managedPath = getManagedSettingsPath('win32', '/mock/home')
      expect(managedPath).toContain('managed-settings.json')
    })
  })
})
