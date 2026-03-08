# Feature Landscape

**Domain:** CLI tool parity -- Claude Code hooks, checkpointing, settings, and advanced CLI flags
**Researched:** 2026-03-08
**Overall confidence:** HIGH (sourced from official Claude Code documentation)

---

## Table Stakes

Features required for parity with Claude Code. Missing = users cannot switch from Claude Code without losing functionality.

### 1. Missing CLI Flags

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| `--fallback-model` | Auto-fallback to specified model when default is overloaded (print mode) | Low | No | Simple: try primary, catch overload error, retry with fallback |
| `--max-budget-usd` | Spending limit that stops execution when exceeded (print mode) | Med | No | Requires token cost tracking per turn; accumulate and check threshold |
| `--append-system-prompt` | Append text to default system prompt (preserves built-in behavior) | Low | No | Have `--system-prompt` (replaces). Need append variant |
| `--append-system-prompt-file` | Append file contents to default system prompt | Low | No | Same as above but reads from file |
| `--system-prompt-file` | Replace system prompt from file contents | Low | No | Simple file read, same effect as `--system-prompt` |
| `--json-schema` | Validated JSON output matching a schema (print mode) | Med | No | Need JSON schema validation on final output; use ajv or similar |
| `--no-session-persistence` | Disable session save-to-disk (print mode) | Low | No | Skip session write step |
| `--setting-sources` | Comma-separated list of setting scopes to load (`user`, `project`, `local`) | Med | No | Requires settings hierarchy refactor first |
| `--teammate-mode` | Agent team display: `auto`, `in-process`, `tmux` | Med | No | Depends on agent teams infrastructure |
| `--mcp-config` | Load MCP servers from JSON files/strings (space-separated) | Med | No | Have MCP support; need CLI-level config file loading |
| `--agents` (inline JSON) | Define subagents dynamically via JSON | Med | No | Have `--agent` for named agents. Need inline JSON with fields: description, prompt, tools, disallowedTools, model, skills, mcpServers, maxTurns |
| `--permission-mode` | Start in specific permission mode (default/plan/acceptEdits/dontAsk/bypassPermissions) | Med | No | Partially covered by `--dangerously-skip-permissions`; need full mode system |
| `--allow-dangerously-skip-permissions` | Enable bypass as option without activating it; composable with `--permission-mode` | Low | No | Gate flag |
| `--permission-prompt-tool` | MCP tool to handle permission prompts in non-interactive mode | Med | No | For headless/CI usage |
| `--betas` | Beta headers for API requests | Low | No | Pass-through to API client headers |
| `--disable-slash-commands` | Disable all skills/commands for session | Low | No | Simple boolean flag check in command dispatcher |
| `--include-partial-messages` | Include partial streaming events (stream-json output mode) | Low | No | Already have stream-json; add partial event emission |
| `--settings` | Load settings from JSON file or inline JSON string | Low | No | Parse and merge with existing settings chain |
| `--strict-mcp-config` | Only use MCP servers from `--mcp-config`, ignore all other sources | Low | No | Flag to skip other MCP config files |
| `--worktree` / `-w` | Start in isolated git worktree | Med | No | Have worktree isolation for subagents; expose at CLI level |
| `--plugin-dir` | Load plugins from specified directories (repeatable) | Low | No | Have plugin system; add directory override |

### 2. Hook Handler Types

Current state: **Only shell command hooks implemented.** Claude Code supports 4 handler types.

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| HTTP hooks (`type: "http"`) | POST event JSON to a URL, read decision from response body | Med | No | URL field, optional headers with env var interpolation (`$VAR_NAME`), `allowedEnvVars` whitelist. Non-2xx = non-blocking error. Block via 2xx JSON body with `decision: "block"` |
| Prompt hooks (`type: "prompt"`) | Send prompt + event JSON to Claude model for single-turn yes/no evaluation | Med | No | `prompt` field with `$ARGUMENTS` placeholder, optional `model` field, returns yes/no decision as JSON |
| Agent hooks (`type: "agent"`) | Spawn subagent with tools (Read, Grep, Glob) to verify conditions | High | No | Lightweight subagent with restricted tool set; prompt template; timeout (default 60s) |
| Async hooks (`async: true`) | Run command hooks in background without blocking | Low | No | Fire-and-forget spawn; command type only; no result processing |

### 3. Missing Hook Event Types

Current state: 13 events implemented. Claude Code has **17 events**.

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| `PostToolUseFailure` | Fires after a tool call fails | Low | No | Mirror of PostToolUse for error path; stderr shown to Claude |
| `SubagentStart` | Fires when a subagent is spawned; matcher filters on agent type | Low | No | Complement to existing SubagentStop |
| `InstructionsLoaded` | Fires when CLAUDE.md or rules files are loaded into context | Low | No | Notification-only; exit code ignored; no decision control |
| `ConfigChange` | Fires when config files change during session; can block the change | Med | No | Needs file watcher on settings files; matcher filters on config source |
| `WorktreeCreate` | Fires when worktree is created; hook prints path to created worktree | Med | No | Replaces default git worktree behavior; non-zero exit fails creation |
| `WorktreeRemove` | Fires when worktree is removed (session exit or subagent finish) | Low | No | Cleanup notification; failures logged in debug mode only |

### 4. Hook Configuration Schema Changes

The hook config structure in Claude Code **differs from Dario's current format**.

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| Nested `hooks` array in matcher groups | CC format: `{ matcher: "X", hooks: [{ type: "command", command: "..." }] }`. Dario format: `{ matcher: "X", command: [...] }` | Med | **Different format** | **Migration required.** Support both formats for backward compat |
| `type` field on handlers | Each handler specifies `type: "command"`, `"http"`, `"prompt"`, or `"agent"` | Low | No | Discriminated union dispatch |
| `statusMessage` field | Custom spinner text displayed while hook runs | Low | No | UI feedback during hook execution |
| `once` field | Run only once per session then removed (skills/agents only) | Low | No | Track executed hooks, skip after first run |
| Per-event matcher semantics | Different events match on different fields (tool name, session start reason, notification type, config source) | Med | Partial | Currently match on toolName only; need event-specific matching |
| Regex matchers (not glob) | Matchers are regex patterns, e.g., `Edit\|Write`, `mcp__.*` | Low | Partial | Have glob + regex; CC uses pure regex |
| Hook deduplication | Identical handlers (same command string or URL) run only once | Low | No | Dedupe before execution |
| Plugin/skill/agent frontmatter hooks | Hooks defined in YAML frontmatter of skills and agents | Med | No | Parse frontmatter, register hooks scoped to component lifetime |
| Hook snapshot at startup | Capture hooks at startup; warn if modified mid-session | Med | No | Security feature; prevent mid-session hook injection |
| Environment variables | `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PLUGIN_ROOT}`, `$CLAUDE_CODE_REMOTE` available to hooks | Low | Partial | Set these env vars before hook execution |

### 5. Checkpointing System

Current state: **No checkpointing exists.** This is a significant feature gap.

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| Automatic file change tracking | Snapshot file content before Write/Edit/MultiEdit edits | Med | No | Intercept tool execution, save pre-edit content. Per-session storage |
| Per-prompt checkpoints | Every user prompt creates a new checkpoint automatically | Med | No | Track prompt boundaries, associate file snapshots with prompt index |
| `/rewind` command with menu | Scrollable list of prompts; select restore point, then choose action | High | No | TUI component: list view, action picker, file restore logic |
| Restore code + conversation | Revert both files and conversation to checkpoint | High | No | File restore from snapshots + conversation truncation |
| Restore conversation only | Rewind conversation, keep current file state | Med | No | Conversation truncation without file changes |
| Restore code only | Revert files, keep conversation | Med | No | File restore from snapshots without conversation changes |
| Summarize from here | Compress conversation from selected point forward into AI summary | Med | No | API call to generate summary; replace messages; keep originals in transcript |
| Cross-session persistence | Checkpoints persist across session resume | Med | No | Store checkpoints in session data directory |
| Esc+Esc shortcut | Double-escape opens rewind menu | Low | No | Keyboard shortcut binding in TUI |
| Original prompt restoration | After restore/summarize, original prompt text returned to input field | Low | No | UX detail: pre-fill input with original prompt |

### 6. Settings Hierarchy

Current state: **Flat 2-level merge** (`.claude` then `.dario`). Claude Code has **5 levels**.

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| 5-level precedence chain | managed > CLI args > local > project > user | High | 2-level only | Core refactor of `loadSettings()` and `loadConfig()` |
| Local project settings | `.claude/settings.local.json` (gitignored) | Low | No | New file location in merge chain |
| Shared project settings | `.claude/settings.json` in project root `.claude/` dir | Low | Partial | Currently read from project root, not `.claude/` subdir |
| Managed settings (file-based) | `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `/etc/claude-code/managed-settings.json` (Linux) | Med | No | Enterprise read-only policy; cannot be overridden |
| Array setting merge | Array-valued settings **concatenate** across scopes, not replace | Med | No | Current `Object.assign` overwrites. Need deep merge logic |
| `$schema` support | JSON schema URL for settings validation | Low | No | `https://json.schemastore.org/claude-code-settings.json` |
| Settings backup | Auto-backup with 5 recent timestamped copies | Low | No | Write backup before save |

### 7. Permission Rule Syntax

Current state: Basic `--allowed-tools` / `--disallowed-tools` with comma-separated tool names.

| Feature | Description | Complexity | Currently Have | Notes |
|---------|-------------|------------|----------------|-------|
| `Tool(specifier)` syntax | e.g., `Bash(npm run *)`, `Read(./.env*)`, `Edit(src/*)` | Med | No | Parse tool name + specifier pattern from rule string |
| Gitignore-style path patterns | `*` (non-recursive), `**` (recursive) for file path matching | Med | No | Path matching for Read/Edit/Write tool specifiers |
| Domain matching | `WebFetch(domain:example.com)` matches domain + all subdomains | Med | No | Domain extraction from URL, wildcard subdomain matching |
| Word-boundary wildcards | `Bash(npm *)` does NOT match `npm-script` -- word boundary enforcement | Med | No | Word boundary aware pattern matching in Bash specifiers |
| 3-tier rule evaluation | deny > ask > allow, first match wins | Med | No | Currently boolean allow/disallow. Need 3-tier with ask escalation |
| Permission modes | `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions` | Med | Partial | Have `bypassPermissions`. Missing plan, acceptEdits, dontAsk, default |
| `permissions` settings object | `permissions.allow`, `permissions.ask`, `permissions.deny`, `permissions.additionalDirectories`, `permissions.defaultMode` | Med | No | New settings schema shape |
| MCP tool matching | `mcp__<server>__<tool>` pattern, e.g., `mcp__memory__.*` | Low | No | Regex pattern against MCP tool names |
| Agent matching | `Agent(research-agent)` pattern for subagent permission rules | Low | No | Match against agent type names |

---

## Differentiators

Nice-to-have features that improve on Claude Code. Not required for parity.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Checkpoint diff preview | Show file diffs before restoring -- visual safety net | Med | `diff` snapshot against current, display in TUI |
| Hook dry-run mode | Test hooks without executing tool calls | Low | Development aid for hook authors |
| Hook debugging panel | Show hook execution details, timing, input/output in dedicated view | Med | Better than CC's verbose-mode-only output |
| Settings source attribution | `/settings-debug` showing which file each active setting came from | Low | CC has `/status` but it's limited |
| Budget tracking display | Show accumulated cost, remaining budget, cost per turn during session | Low | Enhancement over CC's simple threshold-stop |

---

## Anti-Features

Things to deliberately NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| `--remote` / `--teleport` | Requires server infrastructure; explicitly out of scope in PROJECT.md | Exit with clear unsupported message if flags used |
| `--ide` | Requires IDE extension infrastructure; separate project | Exit with message pointing to future integration |
| `--chrome` browser automation | Requires Puppeteer/Playwright subsystem; large dependency | Could be added as plugin rather than core feature |
| Git-based checkpointing | Conflicts with user's git workflow, creates noise in history, fails in non-git dirs | File-level snapshots stored in `~/.dario/checkpoints/{session}/` |
| Bash command tracking in checkpoints | Claude Code explicitly does NOT track Bash file changes -- users expect this boundary | Document the limitation clearly, match CC behavior |
| Enterprise MDM (macOS plist, Windows registry) | Platform-specific admin deployment mechanisms; low demand in OSS | Support file-based managed settings only (`managed-settings.json`) |
| Real-time hook file watching | Claude Code snapshots hooks at startup and warns on external changes | Same approach: load once at startup, warn on change via `ConfigChange` event |
| Bedrock/Vertex/Foundry auth | Complex cloud credential flows; out of scope per PROJECT.md | Document as unsupported; can be added later as provider plugins |

---

## Feature Dependencies

```
Settings Hierarchy ───> Permission Rule Syntax (rules live in scoped settings)
Settings Hierarchy ───> --setting-sources flag (selects which scopes to load)
Settings Hierarchy ───> --settings flag (inject settings into chain)
Settings Hierarchy ───> Local/Project/Managed file locations

Hook Config Schema Change ───> HTTP Hooks (need { type: "http", url } format)
Hook Config Schema Change ───> Prompt Hooks (need { type: "prompt", prompt } format)
Hook Config Schema Change ───> Agent Hooks (need { type: "agent", prompt } format)
Hook Config Schema Change ───> Async Hooks (need { async: true } field)

Checkpointing (file tracking) ───> /rewind command
/rewind command ───> Restore modes (code/conversation/both/summarize)
/rewind command ───> Esc+Esc shortcut

Permission Rule Syntax ───> --permission-mode flag
Permission Rule Syntax ───> Tool(specifier) matching in --allowedTools / --disallowedTools
Permission Rule Syntax ───> permissions settings object

--agents inline JSON ───> Subagent spawn infrastructure
--mcp-config ───> --strict-mcp-config
--max-budget-usd ───> Token cost tracking per API call
```

---

## MVP Recommendation

### Priority 1: Foundation (highest dependency count)

1. **Settings hierarchy refactor** -- Core change that all settings-related features depend on
2. **Hook config schema migration** -- Must change format before adding new handler types. Support both old and new format for backward compat
3. **Permission rule syntax** -- `Tool(specifier)` parsing, 3-tier evaluation, permission modes

### Priority 2: Core Feature Parity

4. **Simple CLI flags** -- `--append-system-prompt`, `--append-system-prompt-file`, `--system-prompt-file`, `--fallback-model`, `--max-budget-usd`, `--json-schema`, `--no-session-persistence`, `--betas`, `--disable-slash-commands`, `--settings`, `--include-partial-messages`, `--plugin-dir`, `--allow-dangerously-skip-permissions`
5. **Missing hook event types** -- 6 new events (PostToolUseFailure, SubagentStart, InstructionsLoaded, ConfigChange, WorktreeCreate, WorktreeRemove)
6. **HTTP hook handler** -- Most commonly requested after command; validates the multi-handler dispatch pattern

### Priority 3: Advanced Features

7. **Checkpointing system** -- File tracking infrastructure, /rewind TUI, restore modes
8. **Prompt hooks + Agent hooks** -- LLM-powered hook evaluation
9. **Async hooks** -- Background execution without blocking
10. **Complex CLI flags** -- `--mcp-config`, `--agents` inline JSON, `--permission-mode`, `--teammate-mode`, `--worktree`, `--permission-prompt-tool`

### Defer

- `--teleport`, `--remote`, `--ide`, `--chrome` -- Out of scope per PROJECT.md
- Enterprise managed settings from plist/registry -- File-based only for OSS
- Hook snapshot + mid-session change detection -- Security hardening, lower priority

---

## Complexity Summary

| Complexity | Count | Key Items |
|------------|-------|-----------|
| Low | ~22 | Simple CLI flags, new hook event types, async hooks, basic settings keys |
| Medium | ~24 | HTTP hooks, permission syntax, settings hierarchy, checkpointing tracking, prompt hooks |
| High | ~6 | Rewind TUI with restore modes, agent hooks, settings hierarchy refactor, hook schema migration (breaking change risk) |

**Risk areas:**
- Settings hierarchy refactor touches `loadSettings()` and `loadConfig()` which are called everywhere -- high regression risk
- Hook config schema migration is a breaking change for existing users -- must support both formats
- Checkpointing is the largest net-new subsystem -- needs its own design doc before implementation

## Sources

- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- Official documentation, all CLI flags
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- Official documentation, all hook events and handler types
- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing) -- Official documentation, checkpoint behavior
- [Claude Code Settings](https://code.claude.com/docs/en/settings) -- Official documentation, settings hierarchy and all keys
