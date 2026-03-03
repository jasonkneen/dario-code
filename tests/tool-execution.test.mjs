/**
 * Tool Execution Tests
 * Tests the actual execution of tool calls with real tool implementations
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { executeToolUse } from '../src/tools/executor.mjs'
import { initializeTools, resetTools } from '../src/integration/bootstrap.mjs'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

describe('Tool Execution', () => {
  let tools
  let toolsArray
  let tempDir
  let readFileTimestamps

  beforeEach(async () => {
    // Reset and initialize fresh tools for each test
    resetTools()
    const toolsObj = initializeTools()
    tools = toolsObj
    toolsArray = Object.values(toolsObj)

    // Track file read timestamps (required by Edit/Write tools)
    readFileTimestamps = {}

    // Debug: check tools array structure
    if (toolsArray.length === 0) {
      throw new Error('No tools loaded')
    }

    // Create temp directory for tests
    tempDir = path.join(os.tmpdir(), `dario-test-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  describe('Bash Tool', () => {
    it('should execute simple command', async () => {
      const toolUse = {
        name: 'Bash',
        input: {
          command: 'echo "hello world"'
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true, readFileTimestamps
      })

      expect(result.is_error).toBe(false)
      expect(result.content).toContain('hello world')
    })

    it('should capture stderr', async () => {
      const toolUse = {
        name: 'Bash',
        input: {
          command: 'echo "error" >&2'
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true, readFileTimestamps
      })

      expect(result.is_error).toBe(false)
      expect(result.content).toContain('error')
    })

    it('should timeout long-running commands', async () => {
      const toolUse = {
        name: 'Bash',
        input: {
          command: 'sleep 10',
          timeout: 100
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      // Should timeout — content indicates interruption or exit code
      expect(result.content).toMatch(/abort|interrupt|Exit code|timeout|143/i)
    }, 30_000)
  })

  describe('Write Tool', () => {
    it('should write file', async () => {
      const testFile = path.join(tempDir, 'test.txt')
      const toolUse = {
        name: 'Write',
        input: {
          file_path: testFile,
          content: 'test content'
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(false)

      // Verify file was written
      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('test content')
    })
  })

  describe('Read Tool', () => {
    it('should read file', async () => {
      const testFile = path.join(tempDir, 'read-test.txt')
      await fs.writeFile(testFile, 'line 1\nline 2\nline 3')

      const toolUse = {
        name: 'Read',
        input: {
          file_path: testFile
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(false)
      expect(result.content).toContain('line 1')
      expect(result.content).toContain('line 2')
      expect(result.content).toContain('line 3')
    })

    it('should read file with offset and limit', async () => {
      const testFile = path.join(tempDir, 'read-offset-test.txt')
      await fs.writeFile(testFile, 'line 1\nline 2\nline 3\nline 4\nline 5')

      const toolUse = {
        name: 'Read',
        input: {
          file_path: testFile,
          offset: 2,
          limit: 2
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(false)
      expect(result.content).toContain('line 2')
      expect(result.content).toContain('line 3')
      expect(result.content).not.toContain('line 4')
      expect(result.content).not.toContain('line 5')
    })
  })

  describe('Edit Tool', () => {
    it('should edit file', async () => {
      const testFile = path.join(tempDir, 'edit-test.txt')
      await fs.writeFile(testFile, 'hello world')

      // Read file first (required by Edit tool validation)
      await executeToolUse({ name: 'Read', input: { file_path: testFile } }, toolsArray, {
        dangerouslySkipPermissions: true, readFileTimestamps
      })

      const toolUse = {
        name: 'Edit',
        input: {
          file_path: testFile,
          old_string: 'world',
          new_string: 'universe'
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(false)

      // Verify file was edited
      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('hello universe')
    })

    it('should replace all occurrences', async () => {
      const testFile = path.join(tempDir, 'edit-all-test.txt')
      await fs.writeFile(testFile, 'foo bar foo baz foo')

      // Read file first (required by Edit tool validation)
      await executeToolUse({ name: 'Read', input: { file_path: testFile } }, toolsArray, {
        dangerouslySkipPermissions: true, readFileTimestamps
      })

      const toolUse = {
        name: 'Edit',
        input: {
          file_path: testFile,
          old_string: 'foo',
          new_string: 'FOO',
          replace_all: true
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(false)

      // Verify all occurrences were replaced
      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('FOO bar FOO baz FOO')
    })
  })

  describe('Glob Tool', () => {
    it('should find files matching pattern', async () => {
      // Create test files
      await fs.writeFile(path.join(tempDir, 'test1.js'), '')
      await fs.writeFile(path.join(tempDir, 'test2.js'), '')
      await fs.writeFile(path.join(tempDir, 'test.txt'), '')

      const toolUse = {
        name: 'Glob',
        input: {
          pattern: '*.js',
          path: tempDir
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(false)
      expect(result.content).toContain('test1.js')
      expect(result.content).toContain('test2.js')
      expect(result.content).not.toContain('test.txt')
    })
  })

  describe('Error Handling', () => {
    it('should handle unknown tool', async () => {
      const toolUse = {
        name: 'NonExistentTool',
        input: {}
      }

      const result = await executeToolUse(toolUse, toolsArray)

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('Unknown tool')
    })

    it('should handle invalid input', async () => {
      const toolUse = {
        name: 'Bash',
        input: {
          // Missing required 'command' field
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true, readFileTimestamps
      })

      expect(result.is_error).toBe(true)
    })

    it('should handle file not found', async () => {
      const toolUse = {
        name: 'Read',
        input: {
          file_path: '/nonexistent/file.txt'
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        readFileTimestamps
      })

      expect(result.is_error).toBe(true)
      expect(result.content).toMatch(/ENOENT|does not exist|not found/i)
    })
  })

  describe('Generator Pattern', () => {
    it('should handle async generator results', async () => {
      const toolUse = {
        name: 'Bash',
        input: {
          command: 'echo "test"'
        }
      }

      const result = await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true, readFileTimestamps
      })

      expect(result.is_error).toBe(false)
      expect(result.content).toBeTruthy()
      expect(typeof result.content).toBe('string')
    })

    it('should capture progress updates if provided', async () => {
      const progressUpdates = []

      const toolUse = {
        name: 'Bash',
        input: {
          command: 'echo "step 1" && sleep 0.1 && echo "step 2"'
        }
      }

      await executeToolUse(toolUse, toolsArray, {
        dangerouslySkipPermissions: true,
        onProgress: (progress) => {
          progressUpdates.push(progress)
        }
      })

      // Progress updates are tool-dependent
      // This test just ensures the callback doesn't break execution
    })
  })
})
