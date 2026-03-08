# Requirements: Dario Code — Claude Code Parity Updates

**Defined:** 2026-03-08
**Core Value:** Every Claude Code feature has an equivalent Dario Code implementation

## v1 Requirements

### Settings Hierarchy

- [x] **SET-01**: Settings load from 5 levels: managed > CLI > local > project > user
- [x] **SET-02**: Object-valued settings deep-merge across levels (not shallow assign)
- [x] **SET-03**: Array-valued settings (permissions.allow, etc.) concatenate across scopes
- [x] **SET-04**: Local project settings read from `.claude/settings.local.json` (gitignored)
- [x] **SET-05**: Managed settings read from platform-specific read-only path
- [x] **SET-06**: `--setting-sources` flag selects which scopes to load
- [x] **SET-07**: `--settings` flag loads settings from JSON file or inline string

### Hook Schema Migration

- [x] **HOOK-01**: Support nested hook format `{ matcher, hooks: [{ type, command }] }` alongside current flat format
- [x] **HOOK-02**: Absent `type` field defaults to `"command"` for backward compatibility
- [x] **HOOK-03**: `statusMessage` field for custom spinner text during hook execution
- [x] **HOOK-04**: `once` field to run hook only once per session
- [x] **HOOK-05**: Hook deduplication (identical handlers run only once)
- [x] **HOOK-06**: Hook snapshot at startup with warning on mid-session modification

### Hook Event Types

- [x] **HEVT-01**: `PostToolUseFailure` event fires after tool call failure
- [x] **HEVT-02**: `SubagentStart` event fires before subagent spawns
- [x] **HEVT-03**: `InstructionsLoaded` event fires after CLAUDE.md is loaded
- [x] **HEVT-04**: `ConfigChange` event fires when config files change (can block)
- [x] **HEVT-05**: `WorktreeCreate` event fires when worktree is created
- [x] **HEVT-06**: `WorktreeRemove` event fires when worktree is removed

### Hook Handler Types

- [x] **HTYP-01**: HTTP handler (`type: "http"`) POSTs event JSON to URL, reads decision from response
- [x] **HTYP-02**: Prompt handler (`type: "prompt"`) sends prompt to Claude for yes/no evaluation
- [x] **HTYP-03**: Agent handler (`type: "agent"`) spawns subagent with Read/Grep/Glob tools
- [x] **HTYP-04**: Async mode (`async: true`) runs command hooks in background without blocking

### Permission Rules

- [ ] **PERM-01**: `Tool(specifier)` syntax for permission rules (e.g. `Bash(npm run *)`)
- [ ] **PERM-02**: Gitignore-style path patterns for Read/Edit/Write tools
- [ ] **PERM-03**: Domain matching for WebFetch (`domain:example.com`)
- [ ] **PERM-04**: Word-boundary wildcards for Bash command matching
- [ ] **PERM-05**: 3-tier rule evaluation: deny > ask > allow (first match wins)
- [ ] **PERM-06**: Permission modes: default, plan, acceptEdits, dontAsk, bypassPermissions
- [ ] **PERM-07**: `permissions` settings object with allow/ask/deny arrays and defaultMode

### CLI Flags — Simple

- [ ] **FLAG-01**: `--append-system-prompt <text>` appends to default system prompt
- [ ] **FLAG-02**: `--append-system-prompt-file <path>` appends file contents to system prompt
- [ ] **FLAG-03**: `--system-prompt-file <path>` replaces system prompt from file
- [ ] **FLAG-04**: `--fallback-model <model>` auto-fallback on overload (print mode)
- [ ] **FLAG-05**: `--max-budget-usd <n>` stops execution when spend exceeds budget
- [ ] **FLAG-06**: `--json-schema <schema>` validates output against JSON schema (print mode)
- [ ] **FLAG-07**: `--no-session-persistence` disables session save to disk
- [ ] **FLAG-08**: `--include-partial-messages` includes streaming events in stream-json output
- [ ] **FLAG-09**: `--betas <features>` passes beta headers to API
- [ ] **FLAG-10**: `--disable-slash-commands` disables all skills/commands for session
- [ ] **FLAG-11**: `--plugin-dir <path>` loads plugins from specified directory
- [ ] **FLAG-12**: `--allow-dangerously-skip-permissions` enables bypass as option without activating
- [ ] **FLAG-13**: `--strict-mcp-config` only uses MCP servers from --mcp-config

### CLI Flags — Complex

- [ ] **FLAG-14**: `--permission-mode <mode>` starts in specific permission mode
- [ ] **FLAG-15**: `--mcp-config <path>` loads MCP servers from JSON file
- [ ] **FLAG-16**: `--agents <json>` defines subagents dynamically via inline JSON
- [ ] **FLAG-17**: `-w <name>` / `--worktree <name>` starts in isolated git worktree
- [ ] **FLAG-18**: `--teammate-mode <mode>` controls agent team display (auto/in-process/tmux)

### Checkpointing

- [ ] **CHKP-01**: Automatic file change tracking before Write/Edit/MultiEdit tool execution
- [ ] **CHKP-02**: Per-prompt checkpoints created automatically
- [ ] **CHKP-03**: `/checkpoint` slash command for manual checkpoint creation
- [ ] **CHKP-04**: `/rewind` slash command with scrollable prompt list TUI
- [ ] **CHKP-05**: Restore code only (revert files, keep conversation)
- [ ] **CHKP-06**: Restore conversation only (rewind conversation, keep files)
- [ ] **CHKP-07**: Restore both code and conversation to checkpoint
- [ ] **CHKP-08**: Checkpoint storage with retention limits (prevent unbounded growth)

### New Settings

- [ ] **SETT-01**: `availableModels` restricts user model choices
- [ ] **SETT-02**: `attribution` controls git commit/PR metadata
- [ ] **SETT-03**: `outputStyle` sets response formatting style
- [ ] **SETT-04**: `alwaysThinkingEnabled` defaults extended thinking on
- [ ] **SETT-05**: `statusLine` configures custom status display
- [ ] **SETT-06**: `fileSuggestion` customizes `@` autocomplete behavior
- [ ] **SETT-07**: `respectGitignore` honors .gitignore in file picker
- [ ] **SETT-08**: `disableAllHooks` kill switch for all hooks
- [ ] **SETT-09**: `cleanupPeriodDays` auto-deletes stale sessions
- [ ] **SETT-10**: `fastModePerSessionOptIn` requires opt-in for fast mode
- [ ] **SETT-11**: `autoUpdatesChannel` selects stable/latest update channel

### Slash Commands

- [ ] **CMD-01**: `/hooks` command for hook configuration and debugging
- [ ] **CMD-02**: `/agents` command lists configured subagents
- [ ] **CMD-03**: `/plugins` command manages installed plugins

## v2 Requirements

### Advanced Checkpointing

- **CHKP-09**: Summarize from checkpoint (compress conversation from point forward)
- **CHKP-10**: Cross-session checkpoint persistence
- **CHKP-11**: Esc+Esc keyboard shortcut opens rewind menu
- **CHKP-12**: Original prompt restoration after rewind

### Hook Enhancements

- **HOOK-07**: Plugin/skill/agent frontmatter hooks
- **HOOK-08**: Per-event matcher semantics (event-specific field matching)
- **HOOK-09**: Environment variables ($CLAUDE_PROJECT_DIR, etc.)

### Permission Enhancements

- **PERM-08**: MCP tool matching patterns (`mcp__server__tool`)
- **PERM-09**: Agent matching patterns (`Agent(name)`)

## Out of Scope

| Feature | Reason |
|---------|--------|
| `--remote` / `--teleport` | Requires server infrastructure; not appropriate for OSS CLI |
| `--ide` | Requires IDE extension infrastructure; separate project |
| `--chrome` / `--no-chrome` | Large dependency (Puppeteer/Playwright); better as plugin |
| Bedrock/Vertex/Foundry providers | Complex cloud credential flows; can be provider plugins |
| macOS plist / Windows registry managed settings | File-based managed settings sufficient for OSS |
| Bash command tracking in checkpoints | Claude Code explicitly excludes this; match their behavior |
| `claude auth/agents/mcp/update` subcommands | Convenience aliases; not core functionality |
| Keybindings config | Low demand; can add later |
| IDE integrations | Separate projects/repos |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SET-01 | Phase 1 | Complete |
| SET-02 | Phase 1 | Complete |
| SET-03 | Phase 1 | Complete |
| SET-04 | Phase 1 | Complete |
| SET-05 | Phase 1 | Complete |
| SET-06 | Phase 1 | Complete |
| SET-07 | Phase 1 | Complete |
| HOOK-01 | Phase 2 | Complete |
| HOOK-02 | Phase 2 | Complete |
| HOOK-03 | Phase 2 | Complete |
| HOOK-04 | Phase 2 | Complete |
| HOOK-05 | Phase 2 | Complete |
| HOOK-06 | Phase 2 | Complete |
| HEVT-01 | Phase 3 | Complete |
| HEVT-02 | Phase 3 | Complete |
| HEVT-03 | Phase 3 | Complete |
| HEVT-04 | Phase 3 | Complete |
| HEVT-05 | Phase 3 | Complete |
| HEVT-06 | Phase 3 | Complete |
| HTYP-01 | Phase 3 | Complete |
| HTYP-02 | Phase 3 | Complete |
| HTYP-03 | Phase 3 | Complete |
| HTYP-04 | Phase 3 | Complete |
| PERM-01 | Phase 4 | Pending |
| PERM-02 | Phase 4 | Pending |
| PERM-03 | Phase 4 | Pending |
| PERM-04 | Phase 4 | Pending |
| PERM-05 | Phase 4 | Pending |
| PERM-06 | Phase 4 | Pending |
| PERM-07 | Phase 4 | Pending |
| FLAG-01 | Phase 5 | Pending |
| FLAG-02 | Phase 5 | Pending |
| FLAG-03 | Phase 5 | Pending |
| FLAG-04 | Phase 5 | Pending |
| FLAG-05 | Phase 5 | Pending |
| FLAG-06 | Phase 5 | Pending |
| FLAG-07 | Phase 5 | Pending |
| FLAG-08 | Phase 5 | Pending |
| FLAG-09 | Phase 5 | Pending |
| FLAG-10 | Phase 5 | Pending |
| FLAG-11 | Phase 5 | Pending |
| FLAG-12 | Phase 5 | Pending |
| FLAG-13 | Phase 5 | Pending |
| FLAG-14 | Phase 5 | Pending |
| FLAG-15 | Phase 5 | Pending |
| FLAG-16 | Phase 5 | Pending |
| FLAG-17 | Phase 5 | Pending |
| FLAG-18 | Phase 5 | Pending |
| CHKP-01 | Phase 6 | Pending |
| CHKP-02 | Phase 6 | Pending |
| CHKP-03 | Phase 6 | Pending |
| CHKP-04 | Phase 6 | Pending |
| CHKP-05 | Phase 6 | Pending |
| CHKP-06 | Phase 6 | Pending |
| CHKP-07 | Phase 6 | Pending |
| CHKP-08 | Phase 6 | Pending |
| SETT-01 | Phase 7 | Pending |
| SETT-02 | Phase 7 | Pending |
| SETT-03 | Phase 7 | Pending |
| SETT-04 | Phase 7 | Pending |
| SETT-05 | Phase 7 | Pending |
| SETT-06 | Phase 7 | Pending |
| SETT-07 | Phase 7 | Pending |
| SETT-08 | Phase 7 | Pending |
| SETT-09 | Phase 7 | Pending |
| SETT-10 | Phase 7 | Pending |
| SETT-11 | Phase 7 | Pending |
| CMD-01 | Phase 7 | Pending |
| CMD-02 | Phase 7 | Pending |
| CMD-03 | Phase 7 | Pending |

**Coverage:**
- v1 requirements: 70 total
- Mapped to phases: 70
- Unmapped: 0

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after roadmap creation*
