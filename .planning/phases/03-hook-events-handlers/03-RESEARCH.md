# Phase 3: Hook Events & Handlers - Research

**Researched:** 2026-03-08
**Domain:** Hook lifecycle events, multi-type handler dispatch (command/http/prompt/agent/async)
**Confidence:** HIGH

## Summary

Phase 3 extends the existing hook system in `src/core/hooks.mjs` with six new event types and four new handler types. The codebase already has a well-structured hook infrastructure from Phase 2 (normalization, dedup, once-tracking, snapshot) and a clean dispatch pattern via `dispatchHook()`. The new event types require finding the correct lifecycle insertion points across existing modules. The new handler types require extending `dispatchHook()` to route by `handler.type` instead of always calling `executeHook` (which spawns a shell command).

The project uses `@anthropic-ai/sdk` for API calls (via `src/api/client.mjs`), native `node-fetch` is already imported, and the subagent system in `src/agents/subagent.mjs` provides patterns for spawning agents. No new dependencies are needed.

**Primary recommendation:** Extend `dispatchHook()` as a type-based router (switch on `handler.type`), add the six new event types to `HookType`, create helper functions for each new event, and wire them into the existing lifecycle call sites.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| HEVT-01 | `PostToolUseFailure` event fires after tool call failure | Extend `notifyToolComplete` in `src/core/init.mjs:328` to also call a failure variant when tool errors |
| HEVT-02 | `SubagentStart` event fires before subagent spawns | Insert hook call at top of `spawnAgent()` in `src/agents/subagent.mjs:165` before agent creation |
| HEVT-03 | `InstructionsLoaded` event fires after CLAUDE.md is loaded | Insert after `loadClaudeMd()` call in `src/prompts/system.mjs:267` |
| HEVT-04 | `ConfigChange` event fires when config files change (can block) | Extend `checkHookIntegrity()` pattern or add periodic check; fire event when settings files change |
| HEVT-05 | `WorktreeCreate` event fires when worktree is created | Insert after worktree add in `src/agents/worktree-isolation.mjs:62` |
| HEVT-06 | `WorktreeRemove` event fires when worktree is removed | Insert in `cleanup()` function in `src/agents/worktree-isolation.mjs:75` before removal |
| HTYP-01 | HTTP handler POSTs event JSON to URL | New `executeHttpHook()` function using native `fetch` |
| HTYP-02 | Prompt handler sends prompt to Claude for yes/no | New `executePromptHook()` using `getClient()` from `src/api/client.mjs` with Haiku model |
| HTYP-03 | Agent handler spawns subagent with Read/Grep/Glob tools | New `executeAgentHook()` using existing subagent system with explore-like config |
| HTYP-04 | Async mode runs command hooks in background | Modify `dispatchHook()` to fire-and-forget when `handler.async === true` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | (existing) | Prompt hook API calls | Already used throughout project for all Claude API calls |
| `node-fetch` | (existing) | HTTP hook POST requests | Already imported in `src/api/client.mjs`; available globally |
| `child_process` | Node built-in | Command hooks (existing) | Already used by `executeHook()` |
| `crypto` | Node built-in | Hashing (existing) | Already used for hook snapshot integrity |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fs` | Node built-in | Config change detection | HEVT-04: watching settings files for changes |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node-fetch` for HTTP hooks | Built-in `fetch` (Node 18+) | Node 18+ has global fetch; could use either. `node-fetch` already in project. |
| Haiku for prompt hooks | Sonnet or other models | Haiku is fastest/cheapest for yes/no decisions; STATE.md notes this needs verification |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Extension Point: dispatchHook() as Type Router

The key architectural change is transforming `dispatchHook()` from a command-only dispatcher to a type-based router:

```javascript
// Current (Phase 2) - always calls executeHook (shell command)
async function dispatchHook(handler, context, verbose) {
  const hookObj = { command: handler.command, timeout: handler.timeout, environment: handler.environment }
  return executeHook(hookObj, context, verbose)
}

// Phase 3 target - routes by handler.type
async function dispatchHook(handler, context, verbose) {
  // Handle async mode first
  if (handler.async && handler.type === 'command') {
    executeCommandHook(handler, context, verbose).catch(err => {
      if (verbose) process.stderr.write(`[Hook] Async error: ${err.message}\n`)
    })
    return { success: true, action: 'continue', statusMessage: handler.statusMessage }
  }

  switch (handler.type) {
    case 'http':    return executeHttpHook(handler, context, verbose)
    case 'prompt':  return executePromptHook(handler, context, verbose)
    case 'agent':   return executeAgentHook(handler, context, verbose)
    case 'command':
    default:        return executeCommandHook(handler, context, verbose)
  }
}
```

### Event Insertion Points

Each new event type needs a specific lifecycle insertion point:

```
PostToolUseFailure:  src/core/init.mjs  notifyToolComplete() -> add notifyToolFailure()
SubagentStart:       src/agents/subagent.mjs  spawnAgent() top
InstructionsLoaded:  src/prompts/system.mjs  after loadClaudeMd() line 267
ConfigChange:        src/core/hooks.mjs  extend checkHookIntegrity() or new watcher
WorktreeCreate:      src/agents/worktree-isolation.mjs  after worktree add line 62
WorktreeRemove:      src/agents/worktree-isolation.mjs  in cleanup() before removal
```

### Handler Type Return Contracts

All handler types must return the same shape for compatibility with `runHooks()`:

```javascript
{
  success: boolean,
  action: 'continue' | 'block' | 'modify' | 'skip',
  stdout: string | undefined,
  stderr: string | undefined,
  message: string | undefined,
  reason: string | undefined,
  modifiedInput: any | undefined,
  statusMessage: string | undefined
}
```

### normalizeHandler Updates

The current `normalizeHandler()` only preserves command-specific fields. It must be extended to preserve handler-type-specific fields:

```javascript
function normalizeHandler(handler) {
  const command = handler.command
    ? (Array.isArray(handler.command) ? handler.command : [handler.command])
    : []

  return {
    type: handler.type || 'command',
    command,
    ...(handler.timeout != null ? { timeout: handler.timeout } : {}),
    ...(handler.environment != null ? { environment: handler.environment } : {}),
    statusMessage: handler.statusMessage ?? null,
    once: handler.once ?? false,
    // Phase 3 additions:
    async: handler.async ?? false,
    url: handler.url ?? null,       // HTTP hooks
    prompt: handler.prompt ?? null,  // Prompt hooks
    model: handler.model ?? null,    // Prompt hooks (model override)
  }
}
```

### Anti-Patterns to Avoid
- **Blocking event loops with sync HTTP:** HTTP hooks must use async fetch, never sync requests
- **Infinite recursion with ConfigChange:** ConfigChange hooks must not trigger config reloads that fire more ConfigChange events
- **Agent hooks spawning agent hooks:** Agent handlers should not have hook capability to prevent recursion
- **Unbounded async hooks:** Async hooks still need timeouts; fire-and-forget does not mean fire-and-ignore-forever

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP POST to webhook URL | Custom HTTP client | `fetch()` (native or node-fetch) | Error handling, redirects, timeouts all built in |
| LLM yes/no evaluation | Custom prompt parsing | `getClient().messages.create()` with structured prompt | SDK handles auth, retries, rate limits |
| Subagent spawning | Custom process management | Existing `spawnAgent()` from `src/agents/subagent.mjs` | Already handles worktree isolation, cleanup |
| Config file watching | Custom polling loop | Periodic `checkHookIntegrity()` calls at lifecycle points | Built-in hash comparison already exists |

**Key insight:** Every handler type has an existing implementation path in the codebase. HTTP hooks use the same fetch the API client uses. Prompt hooks use the same SDK. Agent hooks reuse the subagent system.

## Common Pitfalls

### Pitfall 1: ConfigChange Infinite Loop
**What goes wrong:** ConfigChange hook triggers config reload, which detects change, fires ConfigChange again
**Why it happens:** Hook execution itself touches config-related state
**How to avoid:** Use a guard flag (e.g., `_firingConfigChange = true`) that prevents re-entrancy. Only compare hashes, don't reload during the event.
**Warning signs:** Stack overflow, infinite log output

### Pitfall 2: Prompt Hook Model Not Available
**What goes wrong:** Prompt hook tries to call Claude API but no API key/OAuth token is configured
**Why it happens:** Hooks can be configured in settings.json before auth is set up
**How to avoid:** Wrap prompt hook execution in try/catch, return `{ success: false, action: 'continue' }` on auth failure. Log warning.
**Warning signs:** Unhandled promise rejection on session start

### Pitfall 3: HTTP Hook Timeout vs Default Timeout
**What goes wrong:** HTTP hooks to slow endpoints block the tool pipeline for 10+ seconds
**Why it happens:** Default hook timeout is 10000ms, but HTTP endpoints may be slow
**How to avoid:** HTTP hooks should respect `handler.timeout` (default 10s). Always use AbortController with fetch.
**Warning signs:** User reports tool execution seems frozen when hooks are configured

### Pitfall 4: Async Hook Error Swallowing
**What goes wrong:** Async hooks fail silently, user never knows
**Why it happens:** Fire-and-forget pattern discards errors
**How to avoid:** Log errors to stderr in verbose mode. Optionally track failed async hooks in a counter.
**Warning signs:** Hooks configured but never seem to execute

### Pitfall 5: Event Context Missing Required Fields
**What goes wrong:** New event types pass different context shapes than existing events, handlers crash
**Why it happens:** Each event type has different relevant data (e.g., WorktreeCreate has path, SubagentStart has agent config)
**How to avoid:** Document the context shape per event type. Ensure env vars in executeHook handle missing fields gracefully (already does with `|| ''`).
**Warning signs:** Undefined values in hook environment variables

### Pitfall 6: normalizeHandler Doesn't Preserve New Fields
**What goes wrong:** `normalizeHandler()` currently does not propagate `async`, `url` (for HTTP), `prompt` (for prompt type) fields
**Why it happens:** Function was written for command-only handlers
**How to avoid:** Update `normalizeHandler()` to pass through handler-type-specific fields (url, prompt, async flag, model)
**Warning signs:** Config values lost after normalization

## Code Examples

### HTTP Hook Handler
```javascript
async function executeHttpHook(handler, context, verbose = false) {
  const url = handler.url || handler.command[0]
  const timeout = handler.timeout || DEFAULT_TIMEOUT

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hookType: context.hookType,
        toolName: context.toolName || null,
        input: context.input || null,
        output: context.output || null,
        sessionId: context.sessionId || null,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    const body = await response.json()
    return {
      success: response.ok,
      action: body.action || 'continue',
      message: body.message || null,
      reason: body.reason || null,
      modifiedInput: body.modifiedInput || null,
    }
  } catch (err) {
    clearTimeout(timeoutId)
    if (verbose) process.stderr.write(`[Hook] HTTP hook error: ${err.message}\n`)
    return { success: false, action: 'continue', error: err.message }
  }
}
```

### Prompt Hook Handler
```javascript
async function executePromptHook(handler, context, verbose = false) {
  try {
    const { getClient } = await import('../api/client.mjs')
    const client = await getClient()

    const promptText = handler.prompt || handler.command[0]
    const model = handler.model || 'claude-haiku-4-5-20251001'
    const contextJson = JSON.stringify({
      hookType: context.hookType,
      toolName: context.toolName,
      input: context.input,
    })

    const response = await client.messages.create({
      model,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `${promptText}\n\nContext:\n${contextJson}\n\nRespond with JSON: {"decision": "allow"} or {"decision": "deny", "reason": "..."}`
      }],
    })

    const text = response.content[0].text
    const parsed = JSON.parse(text)
    return {
      success: true,
      action: parsed.decision === 'deny' ? 'block' : 'continue',
      reason: parsed.reason || null,
      message: text,
    }
  } catch (err) {
    if (verbose) process.stderr.write(`[Hook] Prompt hook error: ${err.message}\n`)
    return { success: false, action: 'continue', error: err.message }
  }
}
```

### Agent Hook Handler
```javascript
async function executeAgentHook(handler, context, verbose = false) {
  try {
    const { createAgentConfig, spawnAgent, AgentType } = await import('../agents/subagent.mjs')
    const config = createAgentConfig({
      type: AgentType.EXPLORE, // Read-only tools: Glob, Grep, Read
      systemPrompt: handler.command[0],
      maxTokens: 2048,
      timeout: handler.timeout || DEFAULT_TIMEOUT,
    })

    const result = await spawnAgent(config, JSON.stringify(context), context)
    return {
      success: true,
      action: 'continue',
      message: result.message,
    }
  } catch (err) {
    if (verbose) process.stderr.write(`[Hook] Agent hook error: ${err.message}\n`)
    return { success: false, action: 'continue', error: err.message }
  }
}
```

### New Event Type Registration
```javascript
// Add to HookType object in hooks.mjs
export const HookType = {
  // ... existing types ...
  POST_TOOL_USE_FAILURE: 'PostToolUseFailure',
  SUBAGENT_START: 'SubagentStart',
  INSTRUCTIONS_LOADED: 'InstructionsLoaded',
  CONFIG_CHANGE: 'ConfigChange',
  WORKTREE_CREATE: 'WorktreeCreate',
  WORKTREE_REMOVE: 'WorktreeRemove',
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell-only hooks | Multi-type hooks (command/http/prompt/agent) | Phase 3 | Enables webhook integrations, AI-powered gating |
| 10 event types | 16 event types | Phase 3 | Full lifecycle coverage including failures and config changes |
| Sync-only hooks | Async mode option | Phase 3 | Non-blocking hooks for logging/telemetry use cases |

## Open Questions

1. **Prompt hook model selection**
   - What we know: STATE.md says "fast model default needs verification during Phase 3". Haiku (`claude-haiku-4-5-20251001`) is the current fast model in `AgentModels`.
   - What is unclear: Whether users should be able to override the model per-hook
   - Recommendation: Default to Haiku. Allow `model` field in handler config as optional override. This matches the agent system pattern.

2. **ConfigChange detection mechanism**
   - What we know: `checkHookIntegrity()` already computes hashes of hook config. Settings files are at known paths.
   - What is unclear: Whether ConfigChange should use fs.watch (push) or periodic polling (pull)
   - Recommendation: Use periodic check at natural lifecycle points (before each tool use, on user prompt submit) rather than fs.watch. fs.watch is unreliable across platforms and adds complexity. The existing `checkHookIntegrity()` pattern is the right foundation.

3. **HTTP hook URL source**
   - What we know: HTYP-01 says "POSTs event JSON to URL"
   - What is unclear: Is the URL the `command` field, or a new `url` field?
   - Recommendation: Use `url` field for clarity. Update `normalizeHandler()` to preserve it. Fall back to `command[0]` if `url` not set for backward compatibility.

4. **Agent hook return value**
   - What we know: Agent hooks spawn a subagent. Current `spawnAgent()` is async but does not wait for completion.
   - What is unclear: Should agent hooks block until the subagent finishes?
   - Recommendation: For hook purposes, the agent hook should run synchronously (await completion) and return the agent output. This differs from the normal subagent flow. May need a simpler inline execution path rather than full `spawnAgent()`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | Implicit (vitest via package.json) |
| Quick run command | `npx vitest run tests/hook-events.test.mjs tests/hook-handlers.test.mjs` |
| Full suite command | `npm run test:unit` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HEVT-01 | PostToolUseFailure fires after tool failure | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-01"` | No - Wave 0 |
| HEVT-02 | SubagentStart fires before spawn | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-02"` | No - Wave 0 |
| HEVT-03 | InstructionsLoaded fires after CLAUDE.md load | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-03"` | No - Wave 0 |
| HEVT-04 | ConfigChange fires when config changes (can block) | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-04"` | No - Wave 0 |
| HEVT-05 | WorktreeCreate fires on worktree creation | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-05"` | No - Wave 0 |
| HEVT-06 | WorktreeRemove fires on worktree removal | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-06"` | No - Wave 0 |
| HTYP-01 | HTTP handler POSTs JSON, reads response | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-01"` | No - Wave 0 |
| HTYP-02 | Prompt handler sends to Claude for yes/no | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-02"` | No - Wave 0 |
| HTYP-03 | Agent handler spawns subagent with read tools | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-03"` | No - Wave 0 |
| HTYP-04 | Async mode runs without blocking | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-04"` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/hook-events.test.mjs tests/hook-handlers.test.mjs`
- **Per wave merge:** `npm run test:unit`
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `tests/hook-events.test.mjs` -- covers HEVT-01 through HEVT-06
- [ ] `tests/hook-handlers.test.mjs` -- covers HTYP-01 through HTYP-04
- [ ] Mocks needed: `fetch` for HTTP hooks, `@anthropic-ai/sdk` for prompt hooks, `spawnAgent` for agent hooks

## Sources

### Primary (HIGH confidence)
- `src/core/hooks.mjs` - Full hook system implementation, dispatch pattern, normalization
- `src/core/init.mjs` - Tool lifecycle hooks (notifyToolComplete at line 328)
- `src/agents/subagent.mjs` - Agent spawning, models, tools configuration
- `src/agents/worktree-isolation.mjs` - Worktree create/remove lifecycle
- `src/prompts/system.mjs` - CLAUDE.md loading at line 267
- `src/api/client.mjs` - Anthropic SDK usage pattern, getClient()
- `tests/hooks-migration.test.mjs` - Existing test patterns for hooks

### Secondary (MEDIUM confidence)
- STATE.md blocker note on prompt hook model selection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already exist in the project
- Architecture: HIGH - Clear extension point in dispatchHook(), well-defined insertion points
- Pitfalls: HIGH - Based on direct codebase analysis of existing patterns
- Event insertion points: HIGH - Exact line numbers identified in source files

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable internal architecture)
