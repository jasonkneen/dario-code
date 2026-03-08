# Dario Code — Claude Code Parity Updates

## What This Is

Dario Code is an open-source CLI implementation of Claude Code, currently at ~97% feature parity with Claude Code 2.1.50+. This milestone closes the remaining gaps by implementing missing CLI flags, hook types, slash commands, settings, and system capabilities to reach full parity with Claude Code's latest feature set.

## Core Value

Every feature available in official Claude Code should have an equivalent implementation in Dario Code, so users can switch between them without losing functionality.

## Requirements

### Validated

- ✓ 22 tools implemented (Bash, Read, Write, Edit, MultiEdit, Glob, Grep, WebSearch, WebFetch, Task, LSP, NotebookEdit, etc.) — existing
- ✓ 31 slash commands — existing
- ✓ 27 CLI flags — existing
- ✓ 13 hook types (PreToolUse, PostToolUse, SessionStart, SessionEnd, PreCompact, SubagentStop, UserPromptSubmit, PermissionRequest, Notification, Stop, Setup, TeammateIdle, TaskCompleted) — existing
- ✓ 9 model providers (Anthropic, OpenRouter, Groq, Mistral, xAI, DeepSeek, Together, Moonshot, Ollama/LM Studio) — existing
- ✓ MCP integration (SSE + stdio) — existing
- ✓ Plugin system with NPM support — existing
- ✓ Session management with resume/fork — existing
- ✓ Sandbox system — existing
- ✓ Worktree isolation for subagents — existing

### Active

- [ ] Missing CLI flags (~20 flags)
- [ ] Missing hook event types (6 new types + 4 handler types)
- [ ] Missing slash commands (5 commands)
- [ ] Missing settings keys (~15 settings)
- [ ] Checkpointing system (track/rewind file changes)
- [ ] Advanced permission rule syntax
- [ ] Settings hierarchy (managed > CLI > local > project > user)

### Out of Scope

- Remote control / web sessions — requires server infrastructure not appropriate for OSS CLI
- IDE integrations (VS Code, JetBrains) — separate projects/repos
- Bedrock/Vertex/Foundry providers — enterprise cloud auth requires separate credentials flow
- Keybindings config (`~/.claude/keybindings.json`) — low demand, can add later
- `claude auth/agents/mcp/update` subcommands — convenience aliases, not core functionality

## Context

- **Tech stack**: Node.js 18+, ES Modules, Ink/React for TUI, Commander for CLI
- **Entry point**: `cli.mjs` (main), `dario.mjs` (readable tools mode)
- **Source**: `src/` with modular structure (tools/, api/, cli/, core/, hooks/, plugins/, agents/, sessions/)
- **Testing**: Vitest for unit tests, integration tests via npm
- **Last sync target**: Claude Code 2.1.50+ (February 2026)
- **Current version**: 1.1.2

## Constraints

- **ES Modules**: All code uses `import`/`export`, no CommonJS
- **No breaking changes**: Existing CLI flags and tool APIs must remain backward-compatible
- **Minimal dependencies**: Prefer built-in Node.js APIs; vendor only what's necessary
- **Single-file hooks**: `src/core/hooks.mjs` contains the entire hooks system — extend in-place

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Shell-first hooks extended with HTTP/prompt/agent handlers | Claude Code supports multiple handler types; we only have shell | — Pending |
| Checkpointing via git snapshots vs file-level tracking | Need to decide approach for rewind capability | — Pending |
| Settings hierarchy in config.mjs vs separate module | Current config is flat; need precedence chain | — Pending |

---
*Last updated: 2026-03-08 after initialization*
