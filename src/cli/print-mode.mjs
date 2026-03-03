/**
 * Print Mode - Non-interactive CLI mode with tool support
 */

import { streamConversation } from '../api/streaming.mjs'
import { getSystemInstructions, getSystemPromptIntro } from '../prompts/system.mjs'
import { createMessage } from '../utils/messages.mjs'
import { createAllTools } from '../tools/index.mjs'
import path from 'path'
import { existsSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export async function runPrintMode(prompt, options = {}) {
  const outputFormat = options.outputFormat || 'text'
  const streamJson = outputFormat === 'stream-json'

  // Check if prompt is a slash command - handle directly
  if (prompt.startsWith('/')) {
    const commands = await import('./commands.mjs')
    const cmdName = prompt.slice(1).split(/\s+/)[0].toLowerCase()

    // Route all commands through getLocalCommands for consistency
    const localCommands = commands.getLocalCommands()
    const cmdArgs = prompt.slice(1 + cmdName.length).trim()
    const cmd = localCommands.find(c =>
      c.userFacingName?.() === cmdName ||
      c.name === cmdName ||
      c.aliases?.includes(cmdName)
    )

    if (cmd) {
      const result = await cmd.call(null, {
        args: cmdArgs ? cmdArgs.split(/\s+/) : [],
        getMessages: () => [],
        setMessages: () => {},
        clearMessages: () => {},
      })
      if (result && typeof result === 'string') {
        console.log(result)
      } else if (result && typeof result === 'object' && result.action === 'clear_messages') {
        console.log('✓ Messages cleared (no messages in print mode)')
      }
      process.exit(0)
      return
    }

    // Built-in print-mode-only commands
    if (cmdName === 'version') {
      console.log(`Dario version: ${options.version || '1.0.0'}`)
      process.exit(0)
      return
    } else if (cmdName === 'help') {
      const cmdList = localCommands
        .filter(c => !c.isHidden)
        .map(c => `  /${c.userFacingName()} - ${c.description}`)
        .join('\n')
      console.log(`Available commands:\n${cmdList}\n  /version - Show version\n  /help    - Show this help\n  /quit    - Exit`)
      process.exit(0)
      return
    }

    // Unknown command
    console.error(`Unknown command in print mode: /${cmdName}`)
    console.error('Use interactive mode (./cli.mjs) for full command support')
    process.exit(1)
    return
  }

  try {
    // Simple exec without sandbox
    const executeCommand = async (cmd, opts) => {
      const result = await execAsync(cmd, { ...opts, maxBuffer: 30 * 1024 * 1024 })
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    }

    // Setup tools with dependencies
    const utils = await import('../core/utils.mjs')
    const fs = await import('fs')
    const os = await import('os')

    // Create LSP client for code intelligence
    const { createLspClient } = await import('../lsp/client.mjs')
    const lspClient = createLspClient({ rootUri: `file://${process.cwd()}` })

    const toolObjects = createAllTools({
      fs, path, os,
      lspClient,
      executeCommand,
      getCurrentDir: utils.getCurrentDir,
      getOriginalDir: utils.getOriginalDir,
      resolvePath: utils.resolvePath,
      isAbsolutePath: utils.isAbsolutePath,
      fileExists: utils.fileExists,
      getFileStats: utils.getFileStats,
      findSimilarFile: utils.findSimilarFile,
      isInAllowedDirectory: () => true,
      detectEncoding: utils.detectEncoding,
      detectLineEnding: utils.detectLineEnding,
      getDefaultLineEnding: utils.getDefaultLineEnding,
      normalizeLineEndings: utils.normalizeLineEndings,
      writeFile: utils.writeFile,
      globFiles: utils.globFiles,
      runRipgrep: utils.runRipgrep,
      processImage: utils.processImage,
      logError: () => {},
      logEvent: () => {}
    })
    const tools = Object.values(toolObjects)

    // Build system prompts
    const systemIntro = getSystemPromptIntro()
    const systemInstructions = await getSystemInstructions()
    const systemPrompts = [systemIntro, ...systemInstructions]

    // Create user message
    const userMessage = createMessage('user', prompt)
    const controller = new AbortController()

    // Stream conversation with tool support
    for await (const message of streamConversation(
      [userMessage],
      systemPrompts,
      tools,
      { model: options.model, maxTokens: 8192, dangerouslySkipPermissions: options.dangerouslySkipPermissions },
      controller
    )) {
      // Stream-JSON format: output each message as JSON line
      if (streamJson) {
        process.stdout.write(JSON.stringify(message) + '\n')
        continue
      }

      // Text format: pretty output
      if (message.type === 'assistant' || message.message?.role === 'assistant') {
        const content = message.message?.content || message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              process.stdout.write(block.text)
            } else if (block.type === 'tool_use') {
              if (options.verbose) {
              }
            }
          }
        } else if (typeof content === 'string') {
          process.stdout.write(content)
        }
      } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            const status = block.is_error ? '✗' : '✓'
            const color = block.is_error ? '\x1b[31m' : '\x1b[32m'
            if (options.verbose || block.is_error) {
            }
          }
        }
      }
    }

    if (!streamJson) {
      process.stdout.write('\n')
    }
    process.exit(0)
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

