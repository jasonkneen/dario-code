/**
 * Commander.js CLI Setup
 *
 * Sets up the command-line interface using Commander.js library.
 * Defines all commands, options, and their handlers.
 *
 */

import { program as commander } from 'commander';

/**
 * Sets up the CLI with all commands and options
 *
 * Creates the Commander.js program with:
 * - Main command: claude [prompt]
 * - Config management: get, set, remove, list
 * - Approved tools: list, remove
 * - MCP server management: serve, add, remove, list, get
 * - Doctor command: health check
 *
 * @param {string} stdin - Content from stdin (for piped input)
 * @param {Object} options - CLI options
 * @param {string} options.cwd - Current working directory
 * @returns {Promise<Command>} The configured Commander program
 */
export async function setupCommanderCLI(stdin, options = {}) {
  const { cwd = process.cwd() } = options;

  // Set up main command
  const program = commander
    .name('claude')
    .version('1.0.0')
    .description('AI-powered coding assistant')
    .argument('[prompt]', 'Optional prompt to start with')
    .option('-c, --cwd <cwd>', 'Current working directory', process.cwd())
    .option('-d, --debug', 'Enable debug mode')
    .option('--verbose', 'Override verbose setting from config')
    .option('-ea, --enable-architect', 'Enable Architect tool')
    .option('-p, --print', 'Print response and exit (for pipes)')
    .option('--dangerously-skip-permissions', 'Skip permission checks (Docker only, no internet)')
    .action(async (prompt, cmdOptions) => {
      await handleMainCommand(prompt, cmdOptions, stdin);
    });

  // Config command group
  const configCmd = program
    .command('config')
    .description('Manage configuration');

  configCmd
    .command('get')
    .argument('<key>', 'Configuration key to get')
    .option('-c, --cwd <cwd>', 'Current working directory')
    .option('-g, --global', 'Use global config')
    .action(async (key, options) => {
      await handleConfigGet(key, options);
    });

  configCmd
    .command('set')
    .argument('<key>', 'Configuration key to set')
    .argument('<value>', 'Value to set')
    .option('-c, --cwd <cwd>', 'Current working directory')
    .option('-g, --global', 'Use global config')
    .action(async (key, value, options) => {
      await handleConfigSet(key, value, options);
    });

  configCmd
    .command('remove')
    .argument('<key>', 'Configuration key to remove')
    .option('-c, --cwd <cwd>', 'Current working directory')
    .option('-g, --global', 'Use global config')
    .action(async (key, options) => {
      await handleConfigRemove(key, options);
    });

  configCmd
    .command('list')
    .description('List all configuration values')
    .option('-c, --cwd <cwd>', 'Current working directory')
    .option('-g, --global', 'Use global config')
    .action(async (options) => {
      await handleConfigList(options);
    });

  // Approved tools command group
  const approvedToolsCmd = program
    .command('approved-tools')
    .description('Manage approved tools');

  approvedToolsCmd
    .command('list')
    .description('List all approved tools')
    .action(async () => {
      await handleApprovedToolsList();
    });

  approvedToolsCmd
    .command('remove')
    .argument('<tool>', 'Tool to remove from approved list')
    .action(async (tool) => {
      await handleApprovedToolsRemove(tool);
    });

  // MCP command group
  const mcpCmd = program
    .command('mcp')
    .description('Configure and manage MCP servers');

  mcpCmd
    .command('serve')
    .description('Start MCP server')
    .action(async () => {
      await handleMCPServe();
    });

  mcpCmd
    .command('add')
    .argument('<name>', 'Server name')
    .argument('<command>', 'Command to run')
    .argument('[args...]', 'Command arguments')
    .option('-s, --scope <scope>', 'Scope (user/project)')
    .option('-e, --env <env...>', 'Environment variables')
    .action(async (name, command, args, options) => {
      await handleMCPAdd(name, command, args, options);
    });

  mcpCmd
    .command('remove')
    .argument('<name>', 'Server name to remove')
    .option('-s, --scope <scope>', 'Scope (user/project)')
    .action(async (name, options) => {
      await handleMCPRemove(name, options);
    });

  mcpCmd
    .command('list')
    .description('List configured MCP servers')
    .action(async () => {
      await handleMCPList();
    });

  mcpCmd
    .command('get')
    .argument('<name>', 'Server name')
    .description('Get MCP server details')
    .action(async (name) => {
      await handleMCPGet(name);
    });

  // Doctor command
  program
    .command('doctor')
    .description('Check auto-updater health status')
    .action(async () => {
      await handleDoctor();
    });

  // Agents subcommand — lists all configured agents (CC 2.1.50 parity)
  program
    .command('agents')
    .description('List all configured agents from .claude/agents/ and ~/.claude/agents/')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await handleAgentsList(options);
    });

  // Parse command line arguments
  await program.parseAsync(process.argv);

  return program;
}

/**
 * Main command handler
 *
 * Handles the default 'claude [prompt]' command.
 * Can run in two modes:
 * 1. Interactive mode: Starts chat UI
 * 2. Print mode: Executes prompt and prints result
 *
 * @param {string} prompt - Initial prompt text
 * @param {Object} options - Command options
 * @param {string} stdin - Content from stdin
 */
async function handleMainCommand(prompt, options, stdin) {
  const {
    cwd,
    debug,
    verbose,
    enableArchitect,
    print: printMode,
    dangerouslySkipPermissions
  } = options;

  // Initialize the application
  await initialize(cwd, dangerouslySkipPermissions);

  // Show onboarding if needed
  await showOnboardingIfNeeded(dangerouslySkipPermissions, printMode);

  // Load enabled tools
  const tools = await loadEnabledTools(enableArchitect);

  // Run SessionStart hooks (OpenClaude feature)
  await runSessionStartHooks();

  if (printMode) {
    // Non-interactive mode: execute and print
    const result = await executePromptAndPrint({
      prompt: prompt || stdin,
      cwd,
      tools,
      verbose,
      dangerouslySkipPermissions
    });
    process.exit(0);
  } else {
    // Interactive mode: start chat UI
    await startInteractiveChatUI({
      commands: await loadCommands(),
      tools,
      debug,
      verbose,
      dangerouslySkipPermissions,
      initialPrompt: prompt || stdin,
      cwd
    });
  }
}

// Placeholder functions for command handlers
async function handleConfigGet(key, options) {
  throw new Error('Not implemented');
}

async function handleConfigSet(key, value, options) {
  throw new Error('Not implemented');
}

async function handleConfigRemove(key, options) {
  throw new Error('Not implemented');
}

async function handleConfigList(options) {
  throw new Error('Not implemented');
}

async function handleApprovedToolsList() {
  throw new Error('Not implemented');
}

async function handleApprovedToolsRemove(tool) {
  throw new Error('Not implemented');
}

async function handleMCPServe() {
  throw new Error('Not implemented');
}

async function handleMCPAdd(name, command, args, options) {
  throw new Error('Not implemented');
}

async function handleMCPRemove(name, options) {
  throw new Error('Not implemented');
}

async function handleMCPList() {
  throw new Error('Not implemented');
}

async function handleMCPGet(name) {
  throw new Error('Not implemented');
}

async function handleDoctor() {
  throw new Error('Not implemented');
}

async function initialize(cwd, skipPermissions) {
  throw new Error('Not implemented');
}

async function showOnboardingIfNeeded(skipPermissions, printMode) {
  throw new Error('Not implemented');
}

/**
 * Handle `claude agents` — list all configured agents.
 * Mirrors CC 2.1.50 behaviour: scans ~/.claude/agents/ and .claude/agents/
 * and prints a summary table (or JSON with --json).
 */
async function handleAgentsList({ json } = {}) {
  try {
    const { listAgents } = await import('../agents/named-agents.mjs');
    const agents = listAgents(process.cwd());

    if (json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }

    if (agents.length === 0) {
      console.log('No agents configured.\n');
      console.log('Add agent definitions to:');
      console.log('  ~/.claude/agents/<name>.md   (global)');
      console.log('  .claude/agents/<name>.md      (project)');
      return;
    }

    console.log(`\n${'NAME'.padEnd(20)} ${'MODEL'.padEnd(20)} ${'TOOLS'.padEnd(30)} SOURCE`);
    console.log('─'.repeat(85));
    for (const agent of agents) {
      const name = (agent.name || '?').padEnd(20);
      const model = (agent.model || 'default').padEnd(20);
      const tools = ((agent.tools || []).join(', ') || 'all').slice(0, 28).padEnd(30);
      const source = agent.source || '';
      console.log(`${name} ${model} ${tools} ${source}`);
    }
    console.log();
  } catch (err) {
    console.error('Failed to list agents:', err.message);
    process.exit(1);
  }
}

async function loadEnabledTools(enableArchitect) {
  throw new Error('Not implemented');
}

async function loadCommands() {
  throw new Error('Not implemented');
}

async function runSessionStartHooks() {
  throw new Error('Not implemented');
}

async function executePromptAndPrint(options) {
  throw new Error('Not implemented');
}

async function startInteractiveChatUI(options) {
  throw new Error('Not implemented');
}
