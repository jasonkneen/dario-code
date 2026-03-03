/**
 * LSP Client Manager
 *
 * Zero-dependency LSP client using raw JSON-RPC over stdio.
 * Spawns language servers lazily, caches connections, handles lifecycle.
 */

import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { extname, resolve, isAbsolute } from 'path'
import { homedir } from 'os'

// ─── Built-in server registry ────────────────────────────────────────────────

const DEFAULT_SERVERS = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    languageIds: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' },
    installHint: 'npm i -g typescript-language-server typescript'
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py'],
    languageIds: { '.py': 'python' },
    installHint: 'npm i -g pyright'
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    extensions: ['.go'],
    languageIds: { '.go': 'go' },
    installHint: 'go install golang.org/x/tools/gopls@latest'
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    languageIds: { '.rs': 'rust' },
    installHint: 'rustup component add rust-analyzer'
  },
  c: {
    command: 'clangd',
    args: [],
    extensions: ['.c', '.cpp', '.cc', '.h', '.hpp', '.hh'],
    languageIds: { '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.h': 'c', '.hpp': 'cpp', '.hh': 'cpp' },
    installHint: 'Install clangd via your system package manager'
  }
}

// ─── JSON-RPC transport ──────────────────────────────────────────────────────

/**
 * Create a JSON-RPC connection over a child process's stdio.
 * Returns { sendRequest, sendNotification, dispose }
 */
function createJsonRpcConnection(serverProcess) {
  let nextId = 1
  const pending = new Map()
  let buffer = Buffer.alloc(0)
  let contentLength = -1

  // Parse incoming messages from server stdout
  serverProcess.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])

    while (true) {
      if (contentLength === -1) {
        // Look for header terminator
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) break

        const header = buffer.subarray(0, headerEnd).toString('ascii')
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) {
          // Malformed header — skip past it
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }
        contentLength = parseInt(match[1], 10)
        buffer = buffer.subarray(headerEnd + 4)
      }

      if (buffer.length < contentLength) break

      const messageBytes = buffer.subarray(0, contentLength)
      buffer = buffer.subarray(contentLength)
      contentLength = -1

      try {
        const message = JSON.parse(messageBytes.toString('utf8'))

        // Response to a request we sent
        if (message.id !== undefined && pending.has(message.id)) {
          const { resolve, reject, timer } = pending.get(message.id)
          pending.delete(message.id)
          clearTimeout(timer)

          if (message.error) {
            reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`))
          } else {
            resolve(message.result)
          }
        }
        // Server notifications (diagnostics, etc.) — ignore silently
      } catch {
        // Malformed JSON — skip
      }
    }
  })

  // Log server errors but don't crash
  serverProcess.stderr.on('data', () => {
    // Swallow stderr — language servers are noisy
  })

  function writeMessage(message) {
    const json = JSON.stringify(message)
    const byteLength = Buffer.byteLength(json, 'utf8')
    serverProcess.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${json}`)
  }

  function sendRequest(method, params, timeoutMs = 15000) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      pending.set(id, { resolve, reject, timer })
      writeMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  function sendNotification(method, params) {
    writeMessage({ jsonrpc: '2.0', method, params })
  }

  function dispose() {
    for (const [id, { reject, timer }] of pending) {
      clearTimeout(timer)
      reject(new Error('Connection disposed'))
    }
    pending.clear()
  }

  return { sendRequest, sendNotification, dispose }
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

/**
 * Initialize an LSP server connection.
 * Sends initialize + initialized, returns server capabilities.
 */
async function initializeServer(connection, rootUri) {
  const result = await connection.sendRequest('initialize', {
    processId: process.pid,
    rootUri,
    rootPath: rootUri.replace('file://', ''),
    capabilities: {
      textDocument: {
        definition: { dynamicRegistration: false, linkSupport: false },
        references: { dynamicRegistration: false },
        hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
        documentSymbol: { dynamicRegistration: false },
        implementation: { dynamicRegistration: false },
        callHierarchy: { dynamicRegistration: false },
      },
      workspace: {
        symbol: { dynamicRegistration: false },
        workspaceFolders: true,
      }
    },
    workspaceFolders: [{ uri: rootUri, name: 'workspace' }]
  })

  connection.sendNotification('initialized', {})
  return result
}

// ─── LSP Client Manager ─────────────────────────────────────────────────────

/**
 * Create an LSP client manager.
 *
 * @param {object} options
 * @param {string} options.rootUri - Workspace root URI (file:///path/to/project)
 * @returns {object} LSP client matching the interface expected by src/tools/lsp.mjs
 */
export function createLspClient(options = {}) {
  const { rootUri = `file://${process.cwd()}` } = options

  // Running servers: languageKey → { process, connection, capabilities, openDocs }
  const servers = new Map()

  // Merge built-in + user-configured servers
  function getServerRegistry() {
    const registry = { ...DEFAULT_SERVERS }

    try {
      const configPath = resolve(homedir(), '.dario', 'config.json')
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        if (config.lspServers) {
          for (const [key, serverConfig] of Object.entries(config.lspServers)) {
            if (serverConfig === false) {
              // Explicitly disable a built-in server
              delete registry[key]
            } else {
              registry[key] = { ...registry[key], ...serverConfig }
            }
          }
        }
      }
    } catch {
      // Config read failure — use defaults
    }

    return registry
  }

  /**
   * Find the server config for a given file path.
   */
  function findServerForFile(filePath) {
    const ext = extname(filePath).toLowerCase()
    const registry = getServerRegistry()

    for (const [key, config] of Object.entries(registry)) {
      if (config.extensions?.includes(ext)) {
        return { key, config, languageId: config.languageIds?.[ext] || key }
      }
    }
    return null
  }

  /**
   * Get or spawn a server for the given language key.
   */
  async function getServer(serverKey, serverConfig) {
    if (servers.has(serverKey)) {
      return servers.get(serverKey)
    }

    // Check if the command exists
    const command = serverConfig.command
    const args = serverConfig.args || []

    let serverProcess
    try {
      serverProcess = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        cwd: rootUri.replace('file://', '')
      })
    } catch (err) {
      throw new Error(
        `Failed to start language server '${command}': ${err.message}. ` +
        (serverConfig.installHint ? `Install with: ${serverConfig.installHint}` : '')
      )
    }

    // Handle spawn errors (command not found)
    const spawnError = await new Promise((resolve) => {
      serverProcess.on('error', (err) => resolve(err))
      // Give it a moment to fail or succeed
      setTimeout(() => resolve(null), 500)
    })

    if (spawnError) {
      throw new Error(
        `Language server '${command}' not found. ` +
        (serverConfig.installHint ? `Install with: ${serverConfig.installHint}` : `Ensure '${command}' is on your PATH.`)
      )
    }

    const connection = createJsonRpcConnection(serverProcess)

    let capabilities
    try {
      const result = await initializeServer(connection, rootUri)
      capabilities = result?.capabilities || {}
    } catch (err) {
      serverProcess.kill()
      connection.dispose()
      throw new Error(`Failed to initialize language server '${command}': ${err.message}`)
    }

    const serverEntry = {
      process: serverProcess,
      connection,
      capabilities,
      openDocs: new Set()
    }

    // Clean up if server exits unexpectedly
    serverProcess.on('exit', () => {
      servers.delete(serverKey)
      connection.dispose()
    })

    servers.set(serverKey, serverEntry)
    return serverEntry
  }

  /**
   * Ensure a document is open on the server.
   */
  function ensureDocumentOpen(server, filePath, languageId) {
    const uri = `file://${filePath}`
    if (server.openDocs.has(uri)) return

    try {
      const text = readFileSync(filePath, 'utf8')
      server.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text }
      })
      server.openDocs.add(uri)
    } catch (err) {
      throw new Error(`Cannot read file '${filePath}': ${err.message}`)
    }
  }

  /**
   * Resolve a file path to absolute and get its server + open the doc.
   */
  async function prepareRequest(filePath) {
    const absPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath)
    const match = findServerForFile(absPath)

    if (!match) {
      const ext = extname(absPath)
      throw new Error(
        `No LSP server configured for '${ext}' files. ` +
        `Configure one in ~/.dario/config.json under "lspServers".`
      )
    }

    const server = await getServer(match.key, match.config)
    ensureDocumentOpen(server, absPath, match.languageId)

    return { server, uri: `file://${absPath}` }
  }

  // ─── Public interface (matches src/tools/lsp.mjs expectations) ───────────

  const client = {
    async textDocumentDefinition({ textDocument, position }) {
      const { server } = await prepareRequest(textDocument.uri.replace('file://', ''))
      return server.connection.sendRequest('textDocument/definition', { textDocument, position })
    },

    async textDocumentReferences({ textDocument, position, context }) {
      const { server } = await prepareRequest(textDocument.uri.replace('file://', ''))
      return server.connection.sendRequest('textDocument/references', { textDocument, position, context })
    },

    async textDocumentHover({ textDocument, position }) {
      const { server } = await prepareRequest(textDocument.uri.replace('file://', ''))
      return server.connection.sendRequest('textDocument/hover', { textDocument, position })
    },

    async textDocumentDocumentSymbol({ textDocument }) {
      const { server } = await prepareRequest(textDocument.uri.replace('file://', ''))
      return server.connection.sendRequest('textDocument/documentSymbol', { textDocument })
    },

    async workspaceSymbol({ query }) {
      // Use the first available server for workspace symbol queries
      if (servers.size === 0) {
        throw new Error('No LSP servers are running. Make a request on a specific file first.')
      }
      const server = servers.values().next().value
      return server.connection.sendRequest('workspace/symbol', { query })
    },

    async textDocumentImplementation({ textDocument, position }) {
      const { server } = await prepareRequest(textDocument.uri.replace('file://', ''))
      return server.connection.sendRequest('textDocument/implementation', { textDocument, position })
    },

    async textDocumentPrepareCallHierarchy({ textDocument, position }) {
      const { server } = await prepareRequest(textDocument.uri.replace('file://', ''))
      return server.connection.sendRequest('textDocument/prepareCallHierarchy', { textDocument, position })
    },

    async callHierarchyIncomingCalls({ item }) {
      // Route to whichever server owns the item's URI
      const { server } = await prepareRequest(item.uri.replace('file://', ''))
      return server.connection.sendRequest('callHierarchy/incomingCalls', { item })
    },

    async callHierarchyOutgoingCalls({ item }) {
      const { server } = await prepareRequest(item.uri.replace('file://', ''))
      return server.connection.sendRequest('callHierarchy/outgoingCalls', { item })
    },

    /**
     * Shut down all running servers gracefully.
     */
    async shutdown() {
      const shutdownPromises = []
      for (const [key, server] of servers) {
        shutdownPromises.push(
          server.connection.sendRequest('shutdown', null, 5000)
            .then(() => server.connection.sendNotification('exit', null))
            .catch(() => {})
            .finally(() => {
              server.process.kill()
              server.connection.dispose()
            })
        )
      }
      servers.clear()
      await Promise.allSettled(shutdownPromises)
    }
  }

  // Clean up on process exit
  const cleanup = () => {
    for (const [, server] of servers) {
      try {
        server.process.kill()
      } catch {}
    }
    servers.clear()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  return client
}

export default createLspClient
