---
phase: 03-hook-events-handlers
verified: 2026-03-08T21:45:00Z
status: gaps_found
score: 10/11 must-haves verified
gaps:
  - truth: "WorktreeCreate event fires when a worktree is created"
    status: failed
    reason: "runWorktreeCreate is defined and exported from hooks.mjs but never called from worktree-isolation.mjs"
    artifacts:
      - path: "src/agents/worktree-isolation.mjs"
        issue: "No import or call to runWorktreeCreate after createAgentWorktree succeeds (line ~62)"
    missing:
      - "Add dynamic import of runWorktreeCreate in createAgentWorktree() after the git worktree add call succeeds"
---

# Phase 3: Hook Events & Handlers Verification Report

**Phase Goal:** All six new event types fire at the correct lifecycle points, and HTTP/prompt/agent/async handler types execute hooks beyond shell commands
**Verified:** 2026-03-08T21:45:00Z
**Status:** gaps_found
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | HTTP hooks POST event JSON to a URL and return allow/deny decisions from the response | VERIFIED | `executeHttpHook` at hooks.mjs:458 uses fetch+AbortController, parses action/message/reason/modifiedInput from JSON response. 7 tests pass. |
| 2 | Prompt hooks send a prompt to Claude and return allow/deny based on the response | VERIFIED | `executePromptHook` at hooks.mjs:509 uses dynamic import of getClient, sends prompt+context, maps deny->block/allow->continue. 5 tests pass. |
| 3 | Agent hooks spawn a read-only subagent and return its output | VERIFIED | `executeAgentHook` at hooks.mjs:559 uses AgentType.EXPLORE, dynamic import of subagent module. 3 tests pass. |
| 4 | Async-mode command hooks run in background without blocking the tool pipeline | VERIFIED | dispatchHook at hooks.mjs:598 fire-and-forgets for command+async, non-command types with async run sync. 2 tests pass. |
| 5 | normalizeHandler preserves url, prompt, model, and async fields | VERIFIED | normalizeHandler at hooks.mjs:200-217 sets defaults for all 4 fields. 8 tests pass. |
| 6 | PostToolUseFailure event fires after a tool call fails | VERIFIED | HookType.POST_TOOL_USE_FAILURE defined, runPostToolUseFailure exported, notifyToolFailure method in init.mjs calls it. 3 tests pass. |
| 7 | SubagentStart event fires before a subagent spawns | VERIFIED | runSubagentStart dynamically imported and called at top of spawnAgent() in subagent.mjs:168-169, with block support. 2 tests pass. |
| 8 | InstructionsLoaded event fires after CLAUDE.md is loaded | VERIFIED | runInstructionsLoaded dynamically imported and called in system.mjs:276-277 after claudeMdContent is loaded. 2 tests pass. |
| 9 | ConfigChange event fires when config files change and can block | VERIFIED | runConfigChange called from checkHookIntegrity at hooks.mjs:173 when hash differs, with _firingConfigChange re-entrancy guard. 2 tests pass. |
| 10 | WorktreeCreate event fires when a worktree is created | FAILED | runWorktreeCreate is defined and exported from hooks.mjs:920-925 but NOT called from worktree-isolation.mjs. createAgentWorktree (line 62) creates the worktree but has no hook call after it. |
| 11 | WorktreeRemove event fires when a worktree is removed | VERIFIED | runWorktreeRemove dynamically imported and called in worktree-isolation.mjs:95-96 before cleanup removal. 2 tests pass. |

**Score:** 10/11 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/core/hooks.mjs` | Type-based dispatch router and handler implementations | VERIFIED | 984 lines, all 6 HookType constants, 3 execute functions, type-based switch, 6 helper functions exported |
| `tests/hook-handlers.test.mjs` | Tests for all 4 handler types | VERIFIED | 496 lines, 34 tests covering HTYP-01 through HTYP-04 |
| `tests/hook-events.test.mjs` | Tests for all 6 new event types | VERIFIED | 141 lines (exceeds 80 min), 19 tests covering HEVT-01 through HEVT-06 |
| `src/core/init.mjs` | PostToolUseFailure wiring via notifyToolFailure | VERIFIED | notifyToolFailure method at line 349 calls runPostToolUseFailure |
| `src/agents/subagent.mjs` | SubagentStart hook call before agent creation | VERIFIED | Dynamic import + call at lines 168-169 with block support |
| `src/prompts/system.mjs` | InstructionsLoaded hook call after CLAUDE.md load | VERIFIED | Dynamic import + call at lines 276-277 |
| `src/agents/worktree-isolation.mjs` | WorktreeCreate and WorktreeRemove hook calls | PARTIAL | WorktreeRemove wired at lines 95-96. WorktreeCreate NOT wired -- no import or call. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| dispatchHook() | executeHttpHook/executePromptHook/executeAgentHook | switch on handler.type | WIRED | hooks.mjs:618-638 switch statement routes correctly |
| normalizeHandler() | handler config | preserves url, prompt, model, async fields | WIRED | hooks.mjs:212-215 preserves all 4 fields with defaults |
| src/core/init.mjs | src/core/hooks.mjs | import runPostToolUseFailure | WIRED | Line 21 imports, line 351 calls |
| src/agents/subagent.mjs | src/core/hooks.mjs | import runSubagentStart | WIRED | Dynamic import at line 168, call at line 169 |
| src/prompts/system.mjs | src/core/hooks.mjs | import runInstructionsLoaded | WIRED | Dynamic import at line 276, call at line 277 |
| src/agents/worktree-isolation.mjs | src/core/hooks.mjs | runWorktreeRemove | WIRED | Dynamic import at line 95, call at line 96 |
| src/agents/worktree-isolation.mjs | src/core/hooks.mjs | runWorktreeCreate | NOT_WIRED | No import, no call anywhere in worktree-isolation.mjs |
| checkHookIntegrity | runConfigChange | fires ConfigChange when hash differs | WIRED | hooks.mjs:173 calls runConfigChange inside hash mismatch branch |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| HTYP-01 | 03-01 | HTTP handler POSTs event JSON to URL | SATISFIED | executeHttpHook implemented with fetch+AbortController |
| HTYP-02 | 03-01 | Prompt handler sends prompt to Claude | SATISFIED | executePromptHook uses Claude API with model override |
| HTYP-03 | 03-01 | Agent handler spawns subagent with read-only tools | SATISFIED | executeAgentHook uses AgentType.EXPLORE |
| HTYP-04 | 03-01 | Async mode runs command hooks in background | SATISFIED | dispatchHook fire-and-forgets for command+async |
| HEVT-01 | 03-02 | PostToolUseFailure fires after tool failure | SATISFIED | Helper + wiring in init.mjs |
| HEVT-02 | 03-02 | SubagentStart fires before subagent spawns | SATISFIED | Wired in subagent.mjs with block support |
| HEVT-03 | 03-02 | InstructionsLoaded fires after CLAUDE.md load | SATISFIED | Wired in system.mjs |
| HEVT-04 | 03-02 | ConfigChange fires when config files change | SATISFIED | Wired in checkHookIntegrity with re-entrancy guard |
| HEVT-05 | 03-02 | WorktreeCreate fires when worktree is created | BLOCKED | Helper defined but NOT wired into createAgentWorktree |
| HEVT-06 | 03-02 | WorktreeRemove fires when worktree is removed | SATISFIED | Wired in worktree-isolation.mjs cleanup |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | - | No TODOs, FIXMEs, placeholders, or stub implementations found | - | - |

### Human Verification Required

### 1. HTTP Hook Timeout Behavior

**Test:** Configure an HTTP hook with a very short timeout pointing to a slow endpoint
**Expected:** Hook should abort and return {success: false, action: 'continue'} without blocking the pipeline
**Why human:** AbortController timeout behavior depends on runtime fetch implementation

### 2. Async Command Fire-and-Forget

**Test:** Configure an async command hook with a slow script, verify the tool pipeline is not blocked
**Expected:** dispatchHook returns immediately, script runs in background
**Why human:** Background execution timing is non-deterministic and depends on process scheduling

### Gaps Summary

One gap found: **HEVT-05 (WorktreeCreate)** -- the helper function `runWorktreeCreate` is correctly defined and exported from `hooks.mjs`, but it is never called from `worktree-isolation.mjs`. The `createAgentWorktree` function creates the worktree at line 62 but has no hook call after the successful creation. In contrast, `runWorktreeRemove` IS correctly wired in the cleanup path at lines 95-96. The SUMMARY claimed both were wired, but only WorktreeRemove was actually added.

All 77 tests pass (34 handler + 19 event + 24 migration). The gap is a wiring omission, not a logic error.

---

_Verified: 2026-03-08T21:45:00Z_
_Verifier: Claude (gsd-verifier)_
