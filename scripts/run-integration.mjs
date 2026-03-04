#!/usr/bin/env node

import path from 'path'
import { pathToFileURL } from 'url'

const args = process.argv.slice(2)
if (args.includes('--readable')) process.env.DARIO_USE_READABLE_TOOLS = '1'
if (args.includes('--debug')) process.env.DEBUG = 'true'

const testPath = path.resolve(process.cwd(), 'tests', 'integration.test.mjs')
process.argv = [process.argv[0], testPath]

await import(pathToFileURL(testPath).href)

