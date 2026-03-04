/**
 * Runtime API entrypoint used by integration tests and tooling.
 * Initializes globalThis.__dario in a way compatible with cli.mjs.
 */

import { initializeGlobalAPI, loadAllEnvFiles, registerExitHandlers } from './core/init.mjs'
import * as plan from './plan/index.mjs'
import * as agents from './agents/index.mjs'
import * as statusline from './ui/statusline.mjs'
import * as sandbox from './sandbox/sandbox.mjs'
import * as tasks from './tasks/index.mjs'
import * as session from './session/index.mjs'
import * as todos from './todos/index.mjs'
import * as plugins from './plugins/index.mjs'
import * as keyboard from './keyboard/index.mjs'
import * as mentions from './mentions/index.mjs'
import * as websearch from './tools/websearch.mjs'
import * as tools from './tools/index.mjs'
import * as api from './api/index.mjs'
import * as auth from './auth/index.mjs'
import * as cli from './cli/index.mjs'
import * as config from './config/index.mjs'
import * as terminal from './terminal/index.mjs'
import * as core from './core/utils.mjs'
import * as git from './git/index.mjs'
import * as utils from './utils/index.mjs'
import * as sessions from './sessions/index.mjs'
import * as wasm from './wasm/index.mjs'
import * as integration from './integration/bootstrap.mjs'

loadAllEnvFiles(process.cwd())
registerExitHandlers(false)

const dario = initializeGlobalAPI({
  plan,
  agents,
  statusline,
  sandbox,
  tasks,
  session,
  todos,
  plugins,
  keyboard,
  mentions,
  websearch,
  tools,
  api,
  auth: {
    ...auth,
    authenticate: auth.authenticateWithOAuth || auth.authenticate
  },
  cli,
  config,
  terminal,
  core,
  git,
  utils,
  sessions,
  wasm,
  integration
})

if (process.env.DARIO_USE_READABLE_TOOLS === '1') {
  const readableTools = integration.initializeTools()
  for (const [toolName, readableTool] of Object.entries(readableTools)) {
    dario.registerToolOverride(toolName, readableTool)
  }
}

export default dario

