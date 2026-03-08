# Architecture Patterns

**Domain:** CLI tool parity — hook handlers, checkpointing, settings hierarchy
**Researched:** 2026-03-08

## Recommended Architecture

### Component Boundaries

| Component | Responsibility | Communicates With | File(s) |
|-----------|---------------|-------------------|---------|
| Hook Dispatcher | Routes hook execution to correct handler type | Hook Registry, all handler types | `src/core/hooks.mjs` (extend in-place) |
| Command Handler | Executes shell commands (existing) | `child_process.spawn` | `src/core/hooks.mjs` (existing `executeHook`) |
| HTTP Handler | POSTs JSON to URL, parses response | Native `fetch` | `src/core/hooks.mjs` (new function) |
| Prompt Handler | Sends single-turn prompt to Claude | `@anthropic-ai/sdk` | `src/core/hooks.mjs` (new function) |
| Agent Handler | Spawns restricted subagent | `src/agents/subagent.mjs` | `src/core/hooks.mjs` (new function) |
| Hook Config Parser | Loads + validates + normalizes hook config | Settings Loader, Zod | `src/core/hooks.mjs` (extend `loadHooks`) |
| Checkpoint Manager | Creates/stores/retrieves file snapshots | Session Manager, File System | `src/core/checkpoints.mjs` (new file) |
| Rewind Controller | UI for selecting and applying checkpoints | Checkpoint Manager, TUI | `src/core/checkpoints.mjs` + TUI integration |
| Settings Loader | 5-level precedence merge | File System, Platform APIs | `src/core/config.mjs` (extend in-place) |
| Managed Settings Reader | Platform-specific policy loading | macOS plist / Linux file | `src/core/config.mjs` (new function) |

### Data Flow

#### Hook Execution Flow (Extended)

```
Tool call initiated
    |
    v
runPreToolUse(toolName, input)
    |
    v
loadHooks() -> normalizeConfig() -> filter by matcher
    |
    v
For each matching hook group:
    For each handler in group.hooks[]:
        |
        +-- type:"command" --> spawn shell, pipe JSON to stdin, parse stdout
        +-- type:"http"    --> fetch(url, {method:'POST', body:JSON}), parse response
        +-- type:"prompt"  --> messages.create({prompt with $ARGUMENTS}), parse yes/no
        +-- type:"agent"   --> spawnSubagent({prompt, tools:['Read','Grep','Glob']})
        |
        v
    Collect results, apply decision (allow/deny/block)
    |
    v
Return to tool executor
```

#### Checkpoint Flow

```
User submits prompt
    |
    v
Create checkpoint entry (id, timestamp, messageIndex, prompt)
    |
    v
Tool execution begins
    |
    +-- Write tool called --> snapshotFile(path) before write
    +-- Edit tool called  --> snapshotFile(path) before edit
    +-- MultiEdit called  --> snapshotFile(path) for each file
    +-- NotebookEdit      --> snapshotFile(path) before edit
    |
    v
Checkpoint entry updated with file list
    |
    v
Append checkpoint to session JSONL
```

#### Settings Resolution Flow

```
loadSettings()
    |
    v
1. loadManagedSettings()     -- /Library/.../managed-settings.json or plist
    |
    v
2. getCLIOverrides()         -- from Commander parsed args (runtime)
    |
    v
3. loadLocalSettings()       -- .claude/settings.local.json
    |
    v
4. loadProjectSettings()     -- .claude/settings.json
    |
    v
5. loadUserSettings()        -- ~/.claude/settings.json + ~/.dario/settings.json
    |
    v
deepMerge(5, 4, 3, 2, 1)    -- highest priority applied last
    |
    v
Return merged settings object
```

## Patterns to Follow

### Pattern 1: Handler Dispatch (Strategy Pattern)

**What:** Each hook handler type is an independent function with the same interface. A dispatcher selects the right one based on `type`.

**When:** Always -- this is the core architectural change for hooks.

**Example:**
```javascript
const handlers = {
  command: executeCommandHook,
  http: executeHttpHook,
  prompt: executePromptHook,
  agent: executeAgentHook
}

async function executeHook(hook, context, verbose) {
  const type = hook.type || 'command'
  const handler = handlers[type]
  if (!handler) {
    return { success: false, action: 'continue', error: `Unknown hook type: ${type}` }
  }
  return handler(hook, context, verbose)
}
```

### Pattern 2: Config Normalization (Adapter Pattern)

**What:** Normalize old flat format to new nested format at load time, so all downstream code only deals with one shape.

**When:** During `loadHooks()` -- convert once, use everywhere.

**Example:**
```javascript
function normalizeHookConfig(hookList) {
  return hookList.map(entry => {
    if (entry.hooks && Array.isArray(entry.hooks)) return entry
    return {
      matcher: entry.matcher,
      hooks: [{
        type: 'command',
        command: Array.isArray(entry.command) ? entry.command.join(' ') : entry.command,
        timeout: entry.timeout
      }]
    }
  })
}
```

### Pattern 3: Content-Addressable Snapshots

**What:** Store file snapshots by content hash. Same content = same file on disk.

**When:** Checkpoint file storage.

**Example:**
```javascript
import { createHash } from 'crypto'

function getSnapshotPath(sessionId, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  return path.join(CHECKPOINTS_DIR, sessionId, hash)
}

async function snapshotFile(filePath, sessionId) {
  const content = await fs.readFile(filePath)
  const snapshotPath = getSnapshotPath(sessionId, content)
  try { await fs.access(snapshotPath) } catch {
    await fs.writeFile(snapshotPath, content)
  }
  return { path: filePath, hash: snapshotPath, size: content.length }
}
```

### Pattern 4: Layered Settings Merge

**What:** Load settings from 5 locations, deep-merge with array concatenation for specific keys.

**When:** Every call to `loadSettings()`.

**Example:**
```javascript
import merge from 'lodash/merge.js'

const ARRAY_MERGE_KEYS = ['permissions.allow', 'permissions.deny', 'permissions.ask']

function mergeSettings(...layers) {
  let result = {}
  for (const layer of layers) {
    if (!layer) continue
    result = merge({}, result, layer)
    for (const key of ARRAY_MERGE_KEYS) {
      const pathParts = key.split('.')
      const resultArr = getNestedValue(result, pathParts)
      const layerArr = getNestedValue(layer, pathParts)
      if (Array.isArray(resultArr) && Array.isArray(layerArr)) {
        setNestedValue(result, pathParts, [...new Set([...resultArr, ...layerArr])])
      }
    }
  }
  return result
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Git for Checkpointing

**What:** Using `git stash`, `git commit`, or `git diff` for checkpoint storage.
**Why bad:** Pollutes user's git history, fails in non-git directories, creates merge conflicts, and contradicts Claude Code's design (which explicitly avoids git for checkpoints).
**Instead:** File-level snapshots in `~/.dario/checkpoints/<session>/`.

### Anti-Pattern 2: Re-reading Config on Every Hook

**What:** Calling `loadSettings()` inside every hook execution to get the latest config.
**Why bad:** Hooks fire frequently during tool calls. Reading 5+ files from disk on each hook is wasteful. Claude Code explicitly snapshots hooks at startup and warns on changes.
**Instead:** Load and cache hook config at session start. Expose a refresh mechanism for the `ConfigChange` event.

### Anti-Pattern 3: Blocking on HTTP Hook Failures

**What:** Treating HTTP hook connection failures or timeouts as blocking errors.
**Why bad:** Claude Code explicitly makes HTTP hook failures non-blocking. A down webhook server should not prevent the user from working.
**Instead:** Non-2xx responses, connection failures, and timeouts produce non-blocking errors. Only a 2xx response with explicit `decision: "block"` actually blocks.

### Anti-Pattern 4: Flat Object.assign for Settings

**What:** Using `Object.assign(base, overlay)` for settings merge (current implementation).
**Why bad:** Destroys nested objects. If user settings has `permissions: { allow: [...] }` and project settings has `permissions: { deny: [...] }`, `Object.assign` replaces the entire `permissions` object.
**Instead:** Deep merge with lodash `merge()` plus custom array concatenation.

## Scalability Considerations

| Concern | Current (Single User) | At Scale (Team/Enterprise) |
|---------|----------------------|---------------------------|
| Checkpoint storage | Fine -- few sessions, auto-cleanup after 30 days | Could grow large. Content-addressable dedup helps. Add configurable `cleanupPeriodDays`. |
| Settings file reads | 5 files read once at startup, negligible | Same -- startup cost only, cached after. |
| HTTP hooks | Single endpoint, fast | Could have latency. Use `AbortController` timeout (default 30s). Async hooks help. |
| Prompt hooks | One LLM call per hook | Can be expensive if many fire. Default to fast/cheap model (Haiku-class). |
| Hook deduplication | Not critical with few hooks | Important when plugins + project + user all define hooks. Dedupe by command/URL. |

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- Handler types, config schema, deduplication
- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing) -- Checkpoint design, limitations
- [Claude Code Settings](https://code.claude.com/docs/en/settings) -- Hierarchy, merge behavior, managed settings
- Existing codebase: `src/core/hooks.mjs`, `src/core/config.mjs`, `src/sessions/index.mjs`
