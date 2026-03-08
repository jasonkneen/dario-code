#!/usr/bin/env -S node --no-warnings=ExperimentalWarning --disable-warning=DEP0040 --enable-source-maps

/**
 * Dario CLI Entry Point
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const _require = createRequire(import.meta.url);
const _pkg = _require('./package.json');

const program = new Command();

// Load .env files
const loadEnvFile = (path) => {
    if (!existsSync(path)) return;
    const content = readFileSync(path, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
    }
};

// Load .env files
loadEnvFile(join(process.cwd(), '.env'));
loadEnvFile(join(homedir(), '.dario', '.env'));
loadEnvFile(join(homedir(), '.env'));

program
  .name('dario')
  .description('Dario Code - an open source CLI for Claude')
  .version(_pkg.version || '1.0.0')
  .argument('[prompt]', 'Your prompt')
  .option('-c, --cwd <cwd>', 'Current working directory', process.cwd())
  .option('-d, --debug', 'Enable debug mode')
  .option('--verbose', 'Enable verbose output')
  .option('-p, --print', 'Print response and exit (non-interactive)')
  .option('-f, --file <path>', 'Read prompt from file')
  .option('--output-format <format>', 'Output format: "text", "json", "stream-json" (use with -p)', 'text')
  .option('--model <model>', 'Model to use')
  .option('--continue', 'Continue most recent conversation')
  .option('-r, --resume [id]', 'Resume a session by ID, name, or most recent')
  .option('--session-id <uuid>', 'Use specific session ID')
  .option('--fork-session', 'Fork from resumed session instead of continuing it')
  .option('--system-prompt <prompt>', 'Custom system prompt')
  .option('--dangerously-skip-permissions', 'Skip permission checks')
  .option('--allowed-tools <tools>', 'Comma-separated allowed tools')
  .option('--disallowed-tools <tools>', 'Comma-separated disallowed tools')
  .option('--tools <tools>', 'Restrict to specific tools (comma-separated)')
  .option('--add-dir <dirs...>', 'Additional working directories')
  .option('--agent <name>', 'Use a named agent from .claude/agents/')
  .option('--thinking', 'Enable extended thinking mode')
  .option('--no-thinking', 'Disable extended thinking mode')
  .option('--init', 'Run setup hooks and create CLAUDE.md if missing')
  .option('--init-only', 'Run setup hooks and exit')
  .option('--maintenance', 'Run maintenance hooks')
  .option('--from-pr <pr>', 'Resume session linked to a GitHub PR number or URL')
  .option('--max-turns <n>', 'Maximum number of agentic turns (0 = unlimited)', parseInt)
  .option('--input-format <format>', 'Input format for stdin: text, stream-json')
  .option('--setting-sources <sources>', 'Comma-separated setting scopes to load (user,project,local,cli,managed)')
  .option('--settings <json>', 'Load settings from JSON file path or inline JSON string')
  .action(async (prompt, options) => {
    // Set options in env for TUI to read
    if (options.debug) process.env.DEBUG_TUI = '1';
    if (options.verbose) process.env.VERBOSE = '1';
    if (options.model) process.env.CLAUDE_MODEL = options.model;
    if (options.cwd) process.chdir(options.cwd);
    if (options.thinking) process.env.DARIO_THINKING = '1';
    if (options.thinking === false) process.env.DARIO_THINKING = '0';
    if (options.resume) process.env.DARIO_RESUME = typeof options.resume === 'string' ? options.resume : 'latest';
    if (options.forkSession) process.env.DARIO_FORK_SESSION = '1';
    if (options.agent) process.env.DARIO_AGENT = options.agent;
    if (options.tools) process.env.DARIO_TOOLS = options.tools;
    if (options.fromPr) process.env.DARIO_FROM_PR = options.fromPr;
    if (options.maxTurns !== undefined) process.env.DARIO_MAX_TURNS = String(options.maxTurns);
    if (options.dangerouslySkipPermissions) process.env.DARIO_DANGEROUSLY_SKIP_PERMISSIONS = '1';
    if (options.inputFormat) process.env.DARIO_INPUT_FORMAT = options.inputFormat;
    if (options.addDir) {
      for (const dir of options.addDir) {
        const resolvedDir = dir.startsWith('/') ? dir : join(process.cwd(), dir);
        process.env.DARIO_ADD_DIRS = (process.env.DARIO_ADD_DIRS || '') + resolvedDir + ':';
      }
    }

    // Handle --setting-sources
    if (options.settingSources) {
      const { setSettingSources } = await import('./src/core/config.mjs')
      setSettingSources(options.settingSources.split(',').map(s => s.trim()))
    }

    // Handle --settings (inline JSON or file path)
    if (options.settings) {
      const { setCliSettings } = await import('./src/core/config.mjs')
      let parsed
      if (options.settings.startsWith('{')) {
        parsed = JSON.parse(options.settings)
      } else {
        parsed = JSON.parse(readFileSync(options.settings, 'utf8'))
      }
      setCliSettings(parsed)
    }

    // Handle --init-only
    if (options.initOnly) {
      const { runSetupHooks } = await import('./src/core/hooks.mjs');
      await runSetupHooks();
      process.exit(0);
    }

    // Handle --init
    if (options.init) {
      const { runSetupHooks } = await import('./src/core/hooks.mjs');
      await runSetupHooks();
      // Continue to interactive mode after setup
    }

    // Handle --maintenance
    if (options.maintenance) {
      const { runSetupHooks } = await import('./src/core/hooks.mjs');
      await runSetupHooks({ maintenance: true });
      process.exit(0);
    }

    // Handle --file flag
    let effectivePrompt = prompt;
    if (options.file) {
      try {
        const filePath = options.file.startsWith('/') ? options.file : join(process.cwd(), options.file);
        effectivePrompt = readFileSync(filePath, 'utf8');
        if (options.verbose) {
          console.error(`Read prompt from: ${filePath}`);
        }
      } catch (error) {
        console.error(`Error reading file ${options.file}: ${error.message}`);
        process.exit(1);
      }
    }

    // Handle print mode
    if (options.print) {
      if (!effectivePrompt) {
        console.error('Error: prompt required in --print mode (use argument or --file)');
        process.exit(1);
      }

      // Run in print mode
      const { runPrintMode } = await import('./src/cli/print-mode.mjs');
      await runPrintMode(effectivePrompt, options);
      return;
    }

    // Start interactive TUI
    if (effectivePrompt) {
      process.env.INITIAL_PROMPT = effectivePrompt;
    }

    await import('./src/tui/claude/main.mjs');
  });

program.parse();
