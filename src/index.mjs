/**
 * Dario main module entry point
 *
 * Loads all public subsystems, initializes the global __dario API,
 * and re-exports modules for programmatic use.
 */

import * as agents from './agents/index.mjs'
import * as api from './api/index.mjs'
import * as authModule from './auth/index.mjs'
import * as cli from './cli/index.mjs'
import * as config from './config/index.mjs'
import * as core from './core/index.mjs'
import * as git from './git/index.mjs'
import * as integration from './integration/index.mjs'
import * as keyboard from './keyboard/index.mjs'
import * as mentions from './mentions/index.mjs'
import * as plan from './plan/index.mjs'
import * as plugins from './plugins/index.mjs'
import * as sandbox from './sandbox/index.mjs'
import * as session from './session/index.mjs'
import * as sessions from './sessions/index.mjs'
import * as tasks from './tasks/index.mjs'
import * as terminal from './terminal/index.mjs'
import * as todos from './todos/index.mjs'
import * as tools from './tools/index.mjs'
import * as ui from './ui/index.mjs'
import * as utils from './utils/index.mjs'
import * as wasm from './wasm/index.mjs'
import * as websearch from './tools/websearch.mjs'

import { initializeGlobalAPI } from './core/init.mjs'

const auth = {
  ...authModule,
  authenticate: authModule.authenticate || authModule.authenticateWithOAuth
}

const subsystems = {
  plan,
  agents,
  statusline: ui.statusline || {},
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
  auth,
  cli,
  config,
  terminal,
  core,
  git,
  utils,
  sessions,
  wasm,
  integration
}

const dario = initializeGlobalAPI(subsystems)

export {
  agents,
  api,
  auth,
  cli,
  config,
  core,
  dario,
  git,
  integration,
  keyboard,
  mentions,
  plan,
  plugins,
  sandbox,
  session,
  sessions,
  tasks,
  terminal,
  todos,
  tools,
  ui,
  utils,
  wasm,
  websearch
}

export default dario
