/**
 * CLI Module Entry Point
 *
 * Command handling, argument parsing, and CLI-related functionality.
 */

// Command handling
export {
  isCommand,
  processCommand,
  getLocalCommands,
  commandExists,
  findCommand,
  // Individual commands
  modelCommand,
  authCommand,
  contextCommand,
  tasksCommand,
  todosCommand,
  addDirCommand,
  pluginCommand,
  resumeCommand,
  exportCommand,
  // State management
  AVAILABLE_MODELS,
  MODEL_LIMITS,
  getAllWorkingDirs,
  addWorkingDir,
  removeWorkingDir,
  getTodos,
  setTodos,
  getTodoStatistics
} from './commands.mjs'

// Argument parsing
export { parseArgs, printHelp } from './parse-args.mjs'

// Default export with all functionality
export default {
  // Commands
  isCommand: (await import('./commands.mjs')).isCommand,
  processCommand: (await import('./commands.mjs')).processCommand,
  getLocalCommands: (await import('./commands.mjs')).getLocalCommands,
  commandExists: (await import('./commands.mjs')).commandExists,
  findCommand: (await import('./commands.mjs')).findCommand,

  // Individual commands
  modelCommand: (await import('./commands.mjs')).modelCommand,
  authCommand: (await import('./commands.mjs')).authCommand,
  contextCommand: (await import('./commands.mjs')).contextCommand,
  tasksCommand: (await import('./commands.mjs')).tasksCommand,
  todosCommand: (await import('./commands.mjs')).todosCommand,
  addDirCommand: (await import('./commands.mjs')).addDirCommand,
  pluginCommand: (await import('./commands.mjs')).pluginCommand,
  resumeCommand: (await import('./commands.mjs')).resumeCommand,
  exportCommand: (await import('./commands.mjs')).exportCommand,

  // State management
  AVAILABLE_MODELS: (await import('./commands.mjs')).AVAILABLE_MODELS,
  MODEL_LIMITS: (await import('./commands.mjs')).MODEL_LIMITS,
  getAllWorkingDirs: (await import('./commands.mjs')).getAllWorkingDirs,
  addWorkingDir: (await import('./commands.mjs')).addWorkingDir,
  removeWorkingDir: (await import('./commands.mjs')).removeWorkingDir,
  getTodos: (await import('./commands.mjs')).getTodos,
  setTodos: (await import('./commands.mjs')).setTodos,
  getTodoStatistics: (await import('./commands.mjs')).getTodoStatistics,

  // Argument parsing
  parseArgs: (await import('./parse-args.mjs')).parseArgs,
  printHelp: (await import('./parse-args.mjs')).printHelp
}
