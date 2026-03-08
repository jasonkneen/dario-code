# Domain Pitfalls

**Domain:** CLI tool parity -- hook handlers, checkpointing, settings hierarchy
**Project:** Dario Code -- Claude Code parity updates
**Researched:** 2026-03-08

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: Breaking Existing Hook Config Format

**What goes wrong:** Switching to Claude Code's nested `{ matcher, hooks: [{type, command}] }` format breaks all existing user configurations that use Dario's flat `{ matcher, command, timeout }` format.
**Why it happens:** Temptation to "just adopt the new format" without migration.
**Consequences:** All existing hook users' configs silently stop working. Hooks don't fire, no error shown.
**Prevention:** Implement config normalization in `loadHooks()` that detects and converts the old format. Both formats must work indefinitely.
**Detection:** Test with both old-format and new-format configs. Add a warning log when old format is detected.

### Pitfall 2: HTTP Hook Failures Blocking Tool Execution

**What goes wrong:** Treating network errors or non-2xx HTTP responses as blocking decisions, preventing tool calls when a webhook server is down.
**Why it happens:** Natural assumption that hook failure = block. This is how command hooks work (exit 2 = block).
**Consequences:** A flaky webhook server makes the entire CLI unusable. Enterprise users with centralized hook servers get blocked by network blips.
**Prevention:** HTTP hooks MUST follow Claude Code's semantics: network errors, timeouts, and non-2xx responses are NON-BLOCKING. Only a 2xx response with explicit `decision: "block"` or `permissionDecision: "deny"` blocks. This is fundamentally different from command hooks.
**Detection:** Test with unreachable URLs, timeout scenarios, 500 responses. Verify tool call proceeds in all cases.

### Pitfall 3: Object.assign Settings Merge Destroying Nested Config

**What goes wrong:** The current `loadSettings()` uses `Object.assign(settings, darioSettings)` which replaces entire nested objects instead of merging them.
**Why it happens:** `Object.assign` is a shallow merge. Current code works because settings are currently flat.
**Consequences:** Adding the 5-level hierarchy with nested `permissions`, `sandbox`, and `hooks` objects means a project-level `permissions.deny` would delete user-level `permissions.allow`. Security-critical settings silently disappear.
**Prevention:** Replace `Object.assign` with deep merge using lodash `merge()`. Add special handling for array-valued keys that should concatenate (permissions.allow, permissions.deny, etc.) rather than replace.
**Detection:** Unit test: user has `permissions.allow: ["Bash(npm test)"]`, project has `permissions.deny: ["Bash(curl *)"]`. Merged result must contain both.

### Pitfall 4: Checkpoint Restoration Race Condition

**What goes wrong:** Restoring a checkpoint while a tool is mid-execution overwrites a file that the tool is actively writing.
**Why it happens:** Rewind is user-initiated (Esc+Esc) and can happen at any time.
**Consequences:** Corrupted files, half-written state.
**Prevention:** Disable rewind while a tool call is in progress. Only allow rewind between turns (after tool completes, before next prompt).
**Detection:** Try to rewind during a long-running Bash command or multi-file edit.

## Moderate Pitfalls

### Pitfall 5: Prompt Hook Cost Explosion

**What goes wrong:** Users configure prompt hooks on high-frequency events (PostToolUse, PreToolUse) and each hook makes an LLM API call.
**Prevention:** Default prompt hooks to a fast/cheap model (Haiku-class). Document the cost implications. Consider rate-limiting or caching recent identical prompt hook calls.

### Pitfall 6: Checkpoint Storage Bloat

**What goes wrong:** Long sessions with many file edits accumulate large checkpoint directories that consume disk space.
**Prevention:** Content-addressable storage (hash-based dedup) reduces duplicates. Tie checkpoint cleanup to session cleanup (existing `cleanupPeriodDays`). Set a per-session size limit with a warning.

### Pitfall 7: Hook Environment Variable Leakage in HTTP Headers

**What goes wrong:** HTTP hooks support `$VAR_NAME` in header values. Without an allowlist, sensitive env vars (API keys, tokens) could be sent to arbitrary URLs.
**Prevention:** Implement `allowedEnvVars` field. Only variables explicitly listed get resolved. Unlisted `$VAR` references become empty strings. This is how Claude Code does it.

### Pitfall 8: Settings Hierarchy Confusion for Users

**What goes wrong:** Users set a permission in `~/.claude/settings.json` (user level) but it gets overridden by `.claude/settings.json` (project level) and they don't understand why.
**Prevention:** Implement a `/settings-debug` or enhance `/status` to show which file each active setting comes from and what was overridden. Claude Code shows this in its `/status` output.

### Pitfall 9: Managed Settings on Non-macOS Platforms

**What goes wrong:** Implementing plist reading on macOS but forgetting the Linux file path `/etc/claude-code/managed-settings.json`, or failing gracefully when neither exists.
**Prevention:** Abstract managed settings loading behind a platform-detection function. Return empty object when no managed settings exist. Never throw on missing managed settings.

### Pitfall 10: Async Hooks Never Completing

**What goes wrong:** Async command hooks (`"async": true`) run in the background. If they hang or crash, no one notices. If they write to shared state, race conditions occur.
**Prevention:** Async hooks should be fire-and-forget with a timeout. Log errors to verbose output only. Never let async hooks modify shared state (no `modifiedInput`, no `decision`).

## Minor Pitfalls

### Pitfall 11: Hook Deduplication by URL vs Command

**What goes wrong:** Two hook configs point to the same URL or command. Without dedup, the hook runs twice.
**Prevention:** Before executing, deduplicate handlers by command string (for command type) or URL (for HTTP type). Claude Code does this explicitly.

### Pitfall 12: Checkpoint for Non-Existent Files (Create vs Edit)

**What goes wrong:** Write tool creates a new file. Snapshot tries to read the file before it exists, throws ENOENT.
**Prevention:** In `snapshotFile()`, handle ENOENT gracefully. For new files, record `{ path, previouslyExisted: false }` so rewind can delete the file.

### Pitfall 13: Hook `$ARGUMENTS` Placeholder in Prompt Hooks

**What goes wrong:** The prompt text uses `$ARGUMENTS` as a placeholder for the hook input JSON. If not replaced, the LLM sees the literal string `$ARGUMENTS`.
**Prevention:** String-replace `$ARGUMENTS` with `JSON.stringify(context)` before sending to the model. If `$ARGUMENTS` is missing from the prompt, append the input JSON at the end.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Hook config migration | Pitfall 1 (breaking existing format) | Normalization layer with backward compat |
| HTTP hook handler | Pitfall 2 (blocking on failure) | Non-blocking error semantics, explicit block-only-on-2xx |
| Settings hierarchy | Pitfall 3 (shallow merge) | Deep merge with lodash, array concatenation |
| Checkpointing | Pitfall 4 (race condition), Pitfall 12 (new files) | Disable rewind mid-tool, handle ENOENT |
| Prompt hooks | Pitfall 5 (cost), Pitfall 13 ($ARGUMENTS) | Default cheap model, template replacement |
| Managed settings | Pitfall 9 (platform handling) | Platform abstraction, graceful fallback |

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- HTTP hook error semantics, deduplication, env var allowlist
- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing) -- What is/isn't tracked, limitations
- [Claude Code Settings](https://code.claude.com/docs/en/settings) -- Merge behavior, managed settings platforms
- Existing codebase analysis: `src/core/hooks.mjs` (flat config format), `src/core/config.mjs` (`Object.assign` merge)
