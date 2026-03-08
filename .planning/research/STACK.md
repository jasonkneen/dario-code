# Technology Stack

**Project:** Dario Code — CLI Parity Updates (Hooks, Checkpointing, Settings)
**Researched:** 2026-03-08

## Recommended Stack

This milestone extends an existing codebase. No new frameworks are needed. The recommendations below are for **libraries to add** and **patterns to follow** within the existing Node.js 18+ / ES Modules / Commander / Ink architecture.

### Hook Handler Types (HTTP, Prompt, Agent)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js built-in `fetch` | Node 18+ native | HTTP hook handler POST requests | Already available in Node 18+. No dependency needed. The `undici`-based global `fetch` handles POST, headers, timeouts, and JSON parsing. Do not add `node-fetch` for this — it's already a dependency but the native `fetch` is sufficient and preferred for new code. | HIGH |
| Node.js built-in `AbortController` + `setTimeout` | Node 18+ native | HTTP hook timeout handling | Native `AbortController` integrates with `fetch` for clean timeout cancellation. No library needed. | HIGH |
| Existing `@anthropic-ai/sdk` (^0.32.1) | Already installed | Prompt hook handler (single-turn LLM calls) | Prompt hooks send a single prompt to Claude for yes/no evaluation. The SDK is already installed and used for the main conversation. Reuse it with a one-shot `messages.create()` call. No new dependency. | HIGH |
| Existing subagent system (`src/agents/`) | Already built | Agent hook handler | Agent hooks spawn a subagent with restricted tools (Read, Grep, Glob). The existing `src/agents/subagent.mjs` already handles spawning. Extend it to accept a prompt + tool whitelist. No new dependency. | MEDIUM |

### Checkpointing System

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js `fs` + `crypto.createHash` | Node 18+ native | File snapshot storage | Store file contents before each edit. Hash filenames for deduplication. No external library needed — `fs.copyFileSync` or content-based snapshots are sufficient for session-level undo. | HIGH |
| Existing session JSONL (`src/sessions/`) | Already built | Checkpoint metadata storage | Checkpoints are per-session. Store checkpoint entries in the existing JSONL session log as a new event type (e.g., `{ type: 'checkpoint', ... }`). This keeps checkpoints associated with sessions and gets free cleanup via existing session expiry. | HIGH |
| **NOT** git stash / git commits | N/A | Rejected approach | Claude Code does NOT use git for checkpointing. Checkpoints are internal file snapshots, not git operations. Using git would conflict with the user's own git workflow, create unexpected commits/stashes, and fail in non-git directories. | HIGH |

### Settings Hierarchy

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js `fs` (sync reads) | Node 18+ native | Multi-file settings loading | Read from 5 locations in precedence order and deep-merge. The existing `loadSettings()` already does a simpler version of this (2 locations). Extend it. No library needed. | HIGH |
| `lodash.merge` or custom deep merge | lodash ^4.17.21 (already installed) | Deep merging settings objects | Settings need deep merge (not `Object.assign`) because nested keys like `permissions.allow` must merge arrays, not replace. Lodash is already a dependency. Use `_.merge()` for object merging and custom array concatenation for permission arrays. | HIGH |
| macOS `defaults read` via `child_process` | Node 18+ native | Reading managed settings from plist | On macOS, managed settings can come from MDM plist at `com.anthropic.claudecode`. Use `defaults read` to read them. Falls back gracefully if not present. | MEDIUM |

### Supporting Libraries (No New Dependencies Needed)

| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| `zod` | ^3.22.4 (installed) | Hook config validation | Validate hook handler config shapes (type, url, command, prompt fields) at load time. Already used elsewhere in the codebase. | HIGH |
| `commander` | ^14.0.2 (installed) | New CLI flags | Add ~20 missing flags to existing CLI parser. Already the CLI framework. | HIGH |
| `chalk` | ^5.3.0 (installed) | Checkpoint/rewind UI messages | Status messages for checkpoint operations. Already used throughout. | HIGH |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| HTTP requests | Native `fetch` | `node-fetch` (installed), `got`, `axios` | `node-fetch` is already a dep but native fetch is cleaner for new code. `got`/`axios` would add dependencies for a simple POST. |
| Deep merge | `lodash.merge` | `deepmerge` npm package | Lodash is already installed. Adding another package for one function is wasteful. |
| File snapshots | Direct fs copy | `fs-extra` | `fs-extra` adds nothing over native `fs` for this use case. Node 18+ has `fs.cp` for recursive copy. |
| Checkpointing storage | JSONL session log + file snapshots | SQLite (`better-sqlite3`) | Over-engineered. Checkpoints are append-only within a session, perfectly suited to JSONL. SQLite would add a native binary dependency. |
| Managed settings (macOS) | `defaults read` via exec | `node-plist` parser | Exec is simpler and handles the MDM delivery case. Only needed on macOS. |
| Config validation | `zod` | `ajv` / JSON Schema | Zod is already installed and used. Consistent tooling. |

## Key Implementation Notes

### Hook Handler Architecture

The current `executeHook()` function in `src/core/hooks.mjs` only handles `type: "command"` (shell execution via `spawn`). The new architecture needs a handler dispatch:

```javascript
// Extend executeHook to dispatch by type
async function executeHook(hook, context, verbose) {
  switch (hook.type || 'command') {
    case 'command': return executeCommandHook(hook, context, verbose)
    case 'http':    return executeHttpHook(hook, context, verbose)
    case 'prompt':  return executePromptHook(hook, context, verbose)
    case 'agent':   return executeAgentHook(hook, context, verbose)
    default:        throw new Error(`Unknown hook type: ${hook.type}`)
  }
}
```

### Hook Config Schema Change

Claude Code's current hook format uses a nested structure different from Dario's flat format:

```json
// Claude Code format (target):
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [           // <-- inner array of handlers
          { "type": "command", "command": "..." },
          { "type": "http", "url": "..." }
        ]
      }
    ]
  }
}

// Dario's current format:
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": ["..."],  // <-- flat, command-only
        "timeout": 5000
      }
    ]
  }
}
```

Must support both formats for backward compatibility.

### Settings Precedence (5 Levels)

```
1. Managed    /Library/Application Support/ClaudeCode/managed-settings.json (or plist)
2. CLI flags  --model, --permission-mode, etc. (runtime only)
3. Local      .claude/settings.local.json (gitignored, per-project)
4. Project    .claude/settings.json (committed, per-project)
5. User       ~/.claude/settings.json (or ~/.dario/settings.json)
```

Array-valued settings (permissions, hooks) MERGE across levels. Scalar settings use highest-precedence value.

### Checkpoint Data Model

```javascript
// Checkpoint entry in session JSONL
{
  "type": "checkpoint",
  "id": "chk_<uuid>",
  "timestamp": "2026-03-08T12:00:00Z",
  "messageIndex": 5,        // which user message triggered this
  "prompt": "original prompt text",
  "files": [
    {
      "path": "/abs/path/to/file.js",
      "hash": "sha256:...",
      "snapshotPath": "~/.dario/checkpoints/<session>/<hash>"
    }
  ]
}
```

Files are snapshotted before edit tools (Write, Edit, MultiEdit, NotebookEdit) execute. Content-addressable storage (hash-based filenames) means duplicate file contents share storage.

## Installation

```bash
# No new dependencies needed for this milestone.
# Everything uses existing deps or Node.js built-ins.
npm install  # existing deps are sufficient
```

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) — Official docs, verified 2026-03-08 (HIGH confidence)
- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing) — Official docs, verified 2026-03-08 (HIGH confidence)
- [Claude Code Settings](https://code.claude.com/docs/en/settings) — Official docs, verified 2026-03-08 (HIGH confidence)
- [Claude Code Hooks Guide](https://claudefa.st/blog/tools/hooks/hooks-guide) — Community reference (MEDIUM confidence)
