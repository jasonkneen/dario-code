# Research Summary: Dario Code CLI Parity Updates

**Domain:** CLI tool feature parity (hooks, checkpointing, settings)
**Researched:** 2026-03-08
**Overall confidence:** HIGH

## Executive Summary

This research covers the three major systems needed for Dario Code's next parity milestone: extended hook handlers, file checkpointing, and settings hierarchy. All three areas were verified against Claude Code's official documentation (March 2026) and the existing Dario codebase.

The hook system needs the most architectural change. Dario currently supports only shell command hooks with a flat config format (`{ matcher, command, timeout }`). Claude Code now supports four handler types (command, HTTP, prompt, agent) with a nested config format (`{ matcher, hooks: [{ type, ... }] }`). The key insight is that backward compatibility with the old format is critical -- existing users have configs in the flat format, and breaking them would be a major regression.

Checkpointing is a new subsystem but architecturally straightforward. Claude Code stores file snapshots before each edit tool executes, indexed per user prompt. It explicitly does NOT use git for this -- it's internal file-level storage with content-addressable dedup. The rewind UI offers four actions: restore code, restore conversation, restore both, or summarize from a point.

The settings hierarchy is the most impactful change because it touches `config.mjs`, which is used everywhere. The current implementation uses `Object.assign` (shallow merge) with only 2 levels (user + dario). Claude Code uses 5 levels with deep merge and array concatenation for permission/sandbox keys. This must be changed carefully since every settings consumer depends on it.

No new npm dependencies are needed. Native `fetch` (Node 18+) handles HTTP hooks, the existing `@anthropic-ai/sdk` handles prompt hooks, and the existing subagent system handles agent hooks. Lodash (already installed) provides deep merge.

## Key Findings

**Stack:** Zero new dependencies. Native fetch for HTTP hooks, existing SDK for prompt hooks, existing subagent for agent hooks, lodash for deep merge.

**Architecture:** Three subsystems to extend/create: hook dispatcher with handler strategy pattern, checkpoint manager with content-addressable storage, settings loader with 5-level deep merge.

**Critical pitfall:** The current `Object.assign` settings merge will silently destroy nested config keys (permissions, sandbox) when the hierarchy is added. This must be fixed before adding new settings levels.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Settings Hierarchy** - Foundation phase
   - Addresses: 5-level precedence, deep merge, managed settings, `settings.local.json`
   - Avoids: Object.assign pitfall (Pitfall 3) -- must fix before adding features that depend on nested settings
   - Rationale: Hooks and checkpoints both read from settings. Fix the foundation first.

2. **Hook Config Migration + New Handler Types** - Core hooks phase
   - Addresses: Nested config format, backward compat, HTTP/prompt/agent handlers, async hooks, deduplication
   - Avoids: Breaking existing configs (Pitfall 1), HTTP blocking semantics (Pitfall 2)
   - Rationale: Hook config normalization must happen before handler dispatch. HTTP is simplest new handler, then prompt, then agent.

3. **New Hook Events** - Event expansion phase
   - Addresses: 6 new event types (PostToolUseFailure, SubagentStart, InstructionsLoaded, ConfigChange, WorktreeCreate, WorktreeRemove)
   - Avoids: N/A -- straightforward additions
   - Rationale: New events use existing handler infrastructure. Quick wins.

4. **Checkpointing System** - New subsystem phase
   - Addresses: File snapshots, rewind UI, `/rewind` command, Esc+Esc shortcut
   - Avoids: Git-based checkpointing (Anti-Pattern 1), race conditions (Pitfall 4), new file handling (Pitfall 12)
   - Rationale: Independent subsystem, can be built after settings/hooks are stable.

5. **CLI Flags + Remaining Settings** - Completeness phase
   - Addresses: ~20 missing CLI flags, ~15 missing settings keys
   - Avoids: N/A -- mechanical additions
   - Rationale: Depends on settings hierarchy being complete. Mostly Commander flag additions.

**Phase ordering rationale:**
- Settings hierarchy (Phase 1) is foundational -- hooks load config from settings, checkpoints respect cleanup settings
- Hook config migration (Phase 2) must happen before new handler types to avoid double migration
- New hook events (Phase 3) depend on the handler dispatch being in place
- Checkpointing (Phase 4) is independent but benefits from stable settings/hooks
- CLI flags (Phase 5) are leaf-node work with no downstream dependencies

**Research flags for phases:**
- Phase 2 (Hook handlers): Prompt and agent hooks need careful testing around model selection and cost. May need phase-specific research on Anthropic SDK single-turn patterns.
- Phase 4 (Checkpointing): The "summarize from here" action needs research on conversation compaction integration.
- Phase 1, 3, 5: Standard patterns, unlikely to need additional research.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All verified against official docs. Zero new deps is ideal. |
| Features | HIGH | Feature list from official docs, cross-referenced with existing codebase gaps. |
| Architecture | HIGH | Patterns verified against Claude Code's documented behavior and existing Dario code. |
| Pitfalls | HIGH | Derived from official docs (HTTP semantics, checkpoint limitations) and codebase analysis (Object.assign). |
| Hook handler types | HIGH | Four types clearly documented with config schemas. |
| Checkpoint internals | MEDIUM | Claude Code docs describe behavior but not internal storage format. Inferred from behavior description. |
| Managed settings delivery | MEDIUM | File paths documented, but plist/registry behavior may have edge cases not covered in docs. |

## Gaps to Address

- **Checkpoint storage format:** Claude Code docs describe behavior (what's tracked, how rewind works) but not the internal storage mechanism. The content-addressable approach is inferred, not confirmed. May need experimentation during implementation.
- **Prompt hook model selection:** Docs say "defaults to a fast model" but don't specify which. Likely Haiku-class. Needs verification during implementation.
- **Agent hook tool whitelist:** Docs say "can use tools like Read, Grep, and Glob" but the exact whitelist isn't specified. May include more tools.
- **"Summarize from here" conversation compaction:** This rewind action compresses conversation history. Needs integration with existing compaction system. Defer to phase-specific research.
- **Hook `once` field behavior:** Only for skills/agents, not general hooks. Need to understand skill lifecycle to implement correctly.
