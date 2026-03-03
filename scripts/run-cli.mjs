#!/usr/bin/env node

import path from 'path'
import { pathToFileURL } from 'url'

const args = process.argv.slice(2)
let tui = null
let readable = false
let debug = false
const passthrough = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--tui') {
    const nextArg = args[i + 1]
    if (!nextArg || nextArg.startsWith('-')) {
      console.error('Missing value for --tui. Usage: --tui <name>')
      process.exit(1)
    }
    tui = args[i + 1]
    i++
    continue
  }
  if (arg === '--readable') {
    readable = true
    continue
  }
  if (arg === '--debug') {
    debug = true
    continue
  }
  passthrough.push(arg)
}

if (tui) process.env.DARIO_TUI = tui
if (readable) process.env.DARIO_USE_READABLE_TOOLS = '1'
if (debug) process.env.DEBUG = 'true'

const cliPath = path.resolve(process.cwd(), 'cli.mjs')
process.argv = [process.argv[0], cliPath, ...passthrough]

await import(pathToFileURL(cliPath).href)
