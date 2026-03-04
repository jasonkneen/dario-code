import { describe, it, expect } from 'vitest'
import path from 'path'
import { isAbsolutePath, normalizeUserPath, resolvePath } from '../src/core/utils.mjs'

describe.skipIf(process.platform !== 'win32')('Windows UNC path normalization', () => {
  it('keeps backslash UNC paths absolute and unchanged', () => {
    const unc = '\\\\server\\share\\project'
    expect(isAbsolutePath(unc)).toBe(true)
    expect(normalizeUserPath(unc)).toBe(unc)
    expect(resolvePath(unc, 'C:\\temp\\test')).toBe(path.normalize(unc))
  })

  it('resolves forward-slash UNC paths to Windows UNC form', () => {
    const unc = '//server/share/project'
    expect(isAbsolutePath(unc)).toBe(true)
    expect(resolvePath(unc, 'C:\\temp\\test')).toBe(path.normalize('\\\\server\\share\\project'))
  })

  it('keeps extended-length UNC paths absolute', () => {
    const unc = '\\\\?\\UNC\\server\\share\\project'
    expect(isAbsolutePath(unc)).toBe(true)
    expect(resolvePath(unc, 'C:\\temp\\test')).toBe(path.normalize(unc))
  })
})
