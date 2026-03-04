import { describe, it, expect } from 'vitest'
import path from 'path'
import { resolvePath, isInAllowedDirectory } from '../src/core/utils.mjs'
import { validateCommand } from '../src/tools/bash.mjs'

describe.skipIf(process.platform !== 'win32')('Windows Git Bash path normalization', () => {
  it('resolves /c/... paths to Windows absolute paths', () => {
    const resolved = resolvePath('/c/temp/test')
    expect(resolved).toBe(path.normalize('C:\\temp\\test'))
  })

  it('resolves c/... paths to Windows absolute drive paths', () => {
    const resolved = resolvePath('c/temp/Tetris')
    expect(resolved).toBe(path.normalize('C:\\temp\\Tetris'))
  })

  it('treats /c child paths as inside allowed directory', () => {
    const allowed = isInAllowedDirectory('/c/temp/test/Tetris', 'C:\\temp\\test')
    expect(allowed).toBe(true)
  })

  it('allows cd into same directory when using /c path syntax', () => {
    const result = validateCommand(
      'cd /c/temp/test',
      'C:\\temp\\test',
      'C:\\temp\\test',
      (target, cwd) => resolvePath(target, cwd)
    )
    expect(result).toEqual({ result: true })
  })

  it('still blocks cd outside the original working directory', () => {
    const result = validateCommand(
      'cd /c/temp',
      'C:\\temp\\test',
      'C:\\temp\\test',
      (target, cwd) => resolvePath(target, cwd)
    )
    expect(result.result).toBe(false)
    expect(result.message).toContain("ERROR: cd to 'C:\\temp'")
  })
})
