# Roadmap: Dario Code — Claude Code Parity Updates

## Overview

This roadmap closes the remaining feature gaps between Dario Code and Claude Code 2.1.50+. The settings hierarchy is the dependency root -- hooks, permissions, and CLI flags all read from config. Hook work splits into config migration (schema changes) then event/handler expansion. Permissions and CLI flags follow once their foundations are stable. Checkpointing is an independent subsystem built in parallel-safe order. New settings keys and slash commands cap the milestone as polish.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Settings Hierarchy** - 5-level settings precedence with deep merge and array concatenation (completed 2026-03-08)
- [ ] **Phase 2: Hook Config Migration** - Nested config format, backward compat, deduplication, and session snapshot
- [ ] **Phase 3: Hook Events & Handlers** - 6 new event types and 4 new handler types (HTTP, prompt, agent, async)
- [ ] **Phase 4: Permission Rules** - Advanced permission syntax with Tool(specifier), path patterns, and 3-tier evaluation
- [ ] **Phase 5: CLI Flags** - All 18 missing CLI flags (simple and complex)
- [ ] **Phase 6: Checkpointing** - File change tracking, checkpoint creation, and rewind UI
- [ ] **Phase 7: New Settings & Slash Commands** - 11 new settings keys and 3 slash commands for hooks/agents/plugins

## Phase Details

### Phase 1: Settings Hierarchy
**Goal**: Settings load from five levels with correct precedence, deep merge, and array concatenation so all downstream features (hooks, permissions, flags) consume config correctly
**Depends on**: Nothing (first phase)
**Requirements**: SET-01, SET-02, SET-03, SET-04, SET-05, SET-06, SET-07
**Success Criteria** (what must be TRUE):
  1. Settings from managed, CLI, local, project, and user sources merge in correct precedence order (managed wins over all)
  2. Nested object settings (e.g., permissions, sandbox) deep-merge across levels without losing keys
  3. Array settings (e.g., permissions.allow) concatenate across scopes rather than overwriting
  4. `.claude/settings.local.json` is loaded as local scope and is gitignored by default
  5. `--setting-sources` and `--settings` flags control which scopes load and inject inline settings
**Plans**: 2 plans

Plans:
- [ ] 01-01-PLAN.md — 5-level settings engine with deep merge and array concatenation (TDD)
- [ ] 01-02-PLAN.md — Wire --setting-sources and --settings CLI flags

### Phase 2: Hook Config Migration
**Goal**: Hook configuration supports the nested format alongside the existing flat format, with deduplication and session snapshot
**Depends on**: Phase 1
**Requirements**: HOOK-01, HOOK-02, HOOK-03, HOOK-04, HOOK-05, HOOK-06
**Success Criteria** (what must be TRUE):
  1. Hooks can be defined in nested format `{ matcher, hooks: [{ type, command }] }` and flat format interchangeably
  2. Omitting the `type` field defaults to `"command"` -- existing configs work without changes
  3. `statusMessage` and `once` fields are respected during hook execution
  4. Identical hook handlers are deduplicated (run only once even if defined in multiple scopes)
  5. Hooks are snapshot at startup; mid-session config changes trigger a warning but do not alter running hooks
**Plans**: 2 plans

Plans:
- [ ] 02-01-PLAN.md — Hook config normalization, new fields (statusMessage/once), and deduplication (TDD)
- [ ] 02-02-PLAN.md — Session snapshot with change detection

### Phase 3: Hook Events & Handlers
**Goal**: All six new event types fire at the correct lifecycle points, and HTTP/prompt/agent/async handler types execute hooks beyond shell commands
**Depends on**: Phase 2
**Requirements**: HEVT-01, HEVT-02, HEVT-03, HEVT-04, HEVT-05, HEVT-06, HTYP-01, HTYP-02, HTYP-03, HTYP-04
**Success Criteria** (what must be TRUE):
  1. `PostToolUseFailure`, `SubagentStart`, `InstructionsLoaded`, `ConfigChange`, `WorktreeCreate`, and `WorktreeRemove` events fire at their documented lifecycle points
  2. HTTP hooks POST event JSON to a URL and read allow/deny decisions from the response
  3. Prompt hooks send a prompt to Claude for yes/no evaluation and return the decision
  4. Agent hooks spawn a subagent with read-only tools (Read, Grep, Glob) and return its output
  5. Async-mode hooks run in background without blocking the tool pipeline
**Plans**: 2 plans

Plans:
- [ ] 03-01-PLAN.md — Multi-type handler dispatch: HTTP, prompt, agent, and async mode (TDD)
- [ ] 03-02-PLAN.md — Six new event types with lifecycle wiring (TDD)

### Phase 4: Permission Rules
**Goal**: Users can define fine-grained permission rules using Tool(specifier) syntax, path patterns, and domain matching with 3-tier deny/ask/allow evaluation
**Depends on**: Phase 1
**Requirements**: PERM-01, PERM-02, PERM-03, PERM-04, PERM-05, PERM-06, PERM-07
**Success Criteria** (what must be TRUE):
  1. Permission rules use `Tool(specifier)` syntax (e.g., `Bash(npm run *)`) and match tool calls correctly
  2. Read/Edit/Write tools support gitignore-style path patterns in permission rules
  3. WebFetch supports `domain:example.com` matching
  4. Rules evaluate in deny > ask > allow order with first-match-wins semantics
  5. Permission modes (default, plan, acceptEdits, dontAsk, bypassPermissions) control the overall permission behavior
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: CLI Flags
**Goal**: All 18 missing CLI flags are implemented so Dario Code accepts every flag that Claude Code does
**Depends on**: Phase 1, Phase 4
**Requirements**: FLAG-01, FLAG-02, FLAG-03, FLAG-04, FLAG-05, FLAG-06, FLAG-07, FLAG-08, FLAG-09, FLAG-10, FLAG-11, FLAG-12, FLAG-13, FLAG-14, FLAG-15, FLAG-16, FLAG-17, FLAG-18
**Success Criteria** (what must be TRUE):
  1. System prompt flags (`--append-system-prompt`, `--append-system-prompt-file`, `--system-prompt-file`) modify the system prompt as specified
  2. Budget and output flags (`--max-budget-usd`, `--json-schema`, `--fallback-model`) control print-mode execution
  3. Session and security flags (`--no-session-persistence`, `--betas`, `--allow-dangerously-skip-permissions`) modify session behavior
  4. MCP and agent flags (`--mcp-config`, `--agents`, `--strict-mcp-config`) configure external integrations
  5. Permission and worktree flags (`--permission-mode`, `--worktree`, `--teammate-mode`) set operational modes
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Checkpointing
**Goal**: Users can track file changes, create checkpoints, and rewind code and/or conversation to any previous checkpoint
**Depends on**: Nothing (architecturally independent)
**Requirements**: CHKP-01, CHKP-02, CHKP-03, CHKP-04, CHKP-05, CHKP-06, CHKP-07, CHKP-08
**Success Criteria** (what must be TRUE):
  1. File contents are automatically captured before Write/Edit/MultiEdit tool execution
  2. Per-prompt checkpoints are created automatically and can be created manually via `/checkpoint`
  3. `/rewind` opens a scrollable TUI showing prompt history with checkpoint selection
  4. User can restore code only, conversation only, or both code and conversation to a checkpoint
  5. Checkpoint storage respects retention limits to prevent unbounded disk growth
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: New Settings & Slash Commands
**Goal**: All remaining settings keys are recognized and all management slash commands are available
**Depends on**: Phase 1, Phase 2
**Requirements**: SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06, SETT-07, SETT-08, SETT-09, SETT-10, SETT-11, CMD-01, CMD-02, CMD-03
**Success Criteria** (what must be TRUE):
  1. Settings keys (`availableModels`, `attribution`, `outputStyle`, `alwaysThinkingEnabled`, `statusLine`, `fileSuggestion`, `respectGitignore`, `disableAllHooks`, `cleanupPeriodDays`, `fastModePerSessionOptIn`, `autoUpdatesChannel`) are read from the settings hierarchy and affect behavior
  2. `/hooks` command displays hook configuration and supports debugging
  3. `/agents` command lists configured subagents
  4. `/plugins` command lists and manages installed plugins
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7
Note: Phase 6 (Checkpointing) is architecturally independent and could execute in parallel with Phases 4-5 if desired.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Settings Hierarchy | 2/2 | Complete   | 2026-03-08 |
| 2. Hook Config Migration | 1/2 | In Progress|  |
| 3. Hook Events & Handlers | 1/2 | In Progress|  |
| 4. Permission Rules | 0/0 | Not started | - |
| 5. CLI Flags | 0/0 | Not started | - |
| 6. Checkpointing | 0/0 | Not started | - |
| 7. New Settings & Slash Commands | 0/0 | Not started | - |
