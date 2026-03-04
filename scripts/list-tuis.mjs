#!/usr/bin/env node

import fs from 'fs'
import path from 'path'

const tuiDir = path.resolve(process.cwd(), 'src', 'tui')
const excluded = new Set(['interface.mjs', 'loader.mjs'])
const entries = fs
  .readdirSync(tuiDir)
  .filter((name) => !excluded.has(name))
  .sort((a, b) => a.localeCompare(b))

console.log('Available TUIs:')
for (const entry of entries) {
  console.log(entry)
}

