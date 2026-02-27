# Open Claude Code — Gap Analysis

**Local Version**: 1.0.0  
**Reference**: Claude Code 2.1.50+  
**Updated**: February 27, 2026  
**Overall Parity**: ~88% (revised down from 95% — newer CC releases added significant features)

> Previous parity estimate was against CC 2.1.44. CC has shipped 2.1.45–2.1.50+ with substantial new features since then.

---

## Current Status Summary

OCC 1.0.0 has solid coverage of the CC 2.1.x baseline feature set. However, a cluster of features introduced in CC 2.1.14–2.1.50 are missing or incomplete. The biggest gaps are:

1. **`/teleport` command** — browser handoff to claude.ai/code
2. **Auto Memories** — automatic extraction + recall of cross-session facts
3. **`isolation:worktree`** — agents running in isolated git worktrees
4. **`claude agents` CLI subcommand** — list configured agents from the terminal
5. **Skill hot-reload** — skills reload without restart
6. **Plan-mode context clear** — accepting a plan auto-clears the context window
7. **Bash history Tab autocomplete** — type partial, Tab to complete from bash history
8. **Heredoc security hardening** — delimiter smuggling prevention (partially done)
9. **Plugin pinning to git SHAs** — reproducible plugin versions
10. **Remote session browsing** — OAuth users browse/resume remote sessions

---

## Feature-by-Feature Gap Table (CC 2.1.x through 2.1.50)

### New Features in CC 2.1.14–2.1.50 (Mostly Missing in OCC)

| Feature | CC | OCC | Priority | Notes |
|---------|-----|-----|----------|-------|
| `/teleport` command | ✅ v2.1 | ❌ | Medium | Moves session to claude.ai/code in browser; needs Web transport layer |
| Auto Memories (`.claude/memory/`) | ✅ v2.1.32 | ❌ | **High** | Automatic cross-session fact extraction and recall |
| "Summarize from here" (message selector) | ✅ v2.1.32 | ❌ | Medium | Partial compaction from a chosen message onwards |
| `isolation:worktree` agent option | ✅ v2.1.50 | ❌ | **High** | Agents run in isolated git worktrees; auto-clean if no changes |
| `claude agents` CLI subcommand | ✅ v2.1.50 | ❌ | Medium | `claude agents` lists all configured `.claude/agents/*.md` files |
| Skill hot-reload | ✅ v2.1.0 | ❌ | Medium | Skills reload on file change without restart; needs fs.watch on `.claude/skills/` |
| Plan-mode: accept clears context | ✅ v2.1.x | ❌ | Medium | Accepting a plan wipes the conversation for a fresh context window |
| Bash history Tab autocomplete | ✅ v2.1.14 | ❌ | Medium | Type partial command + Tab to complete from bash shell history |
| Plugin pinning to git SHA | ✅ v2.1.14 | ❌ | Low | Reproducible installs by pinning plugins to specific commit SHAs |
| Remote session browsing (OAuth) | ✅ v2.1.16 | ❌ | Low | OAuth users can browse + resume sessions from other machines |
| Heredoc delimiter hardening | ✅ v2.1.38 | ⚠️ Partial | **High** | CC prevents command smuggling via heredoc delimiters; OCC only cleans display |
| Sandbox skills protection | ✅ v2.1.38 | ❌ | Medium | Block writes to `.claude/skills/` when running in sandbox mode |
| Ctrl+B unified backgrounding | ✅ v2.1 | ❌ | Low | Backgrounds bash commands AND agents simultaneously |
| Web→CLI teleport direction | ✅ v2.1.41 | ❌ | Low | Reverse teleport: move web session to CLI |
| OOM fixes for subagent-heavy sessions | ✅ v2.1.47–50 | ⚠️ Unknown | Medium | Memory leak fixes in long-running multi-agent sessions |

### Previously Documented Gaps (from v1.0.0 analysis — still missing)

| Feature | Impact | Notes |
|---------|--------|-------|
| Automatic memory extraction | **High** | `.claude/memory/` auto-population — same as "Auto Memories" above |
| Advanced vim motions | Low | `f`/`t`/`w`/`b`, text objects, registers, yank system |
| Permission prompt diff preview | Medium | `src/utils/diff.mjs` exists, needs wiring into the approval UI |
| Multi-provider support | Low | Bedrock / Vertex / OpenAI not supported |

---

## Quality & Refactoring Issues

These are internal code quality issues discovered during this audit — not feature gaps but improvements that would make OCC more robust.

### 🔴 Critical

**1. Heredoc security gap** (`src/tools/bash.mjs`)
- OCC currently only _cleans heredoc display_ (cosmetic). It does NOT validate that heredoc delimiters can't be used for command smuggling.
- CC 2.1.38 added delimiter validation that rejects heredocs where the EOF delimiter can be injected to escape the heredoc early.
- **Fix**: Add a validation step before execution that scans heredoc content for embedded delimiter strings that could terminate the heredoc prematurely.

**2. Summarize model hardcoded** (`src/utils/summarize.mjs:38`)
```js
{ model: 'claude-haiku-4-5-20251001' }
```
- The summarization model is hardcoded. This will break when the model is deprecated. Should read from config or use a model-resolution utility.

**3. Token estimation is char/4** (`src/utils/tokens.mjs:9`)
- Simple `Math.ceil(text.length / 4)` — reasonable but inaccurate for code (shorter tokens) and non-Latin text (longer tokens). Should use a proper tokenizer or at least apply content-type multipliers.

### 🟡 Medium Priority

**4. No fs.watch on skills directory** 
- Skills are loaded once at startup. CC 2.1.0 added hot-reload via file watching. Long-running sessions that modify `.claude/skills/` see no updates.
- **Fix**: Add `fs.watch('.claude/skills/')` in `src/tools/skills-discovery.mjs` and invalidate the skills cache on change.

**5. Bash sandbox only covers macOS** (`src/sandbox/sandbox.mjs:18`)
- `isSandboxSupported()` returns `platform() === 'darwin'` — Linux is excluded. CC 2.1.41 shipped sandbox for both Linux AND Mac.
- **Fix**: Add Linux support using `bubblewrap` (`bwrap`) or `firejail` as the sandbox backend.

**6. Plan mode doesn't clear context on accept** (`src/tools/planmode.mjs`)
- CC clears the conversation after a plan is accepted to give the execution phase a full context window. OCC carries the full planning conversation into execution, burning tokens.
- **Fix**: After plan acceptance, compact/summarize planning messages down to a single "plan accepted" context marker.

**7. Auto-compact threshold not configurable** (`src/cli/app.mjs`)
- The compaction trigger threshold is likely hardcoded. Should be a user config value (`compactThreshold: 0.85`).

**8. Missing `claude agents` subcommand** (`src/cli/commander-setup.mjs`)
- No way to list configured agents from the CLI. Discovered agents are only visible inside the TUI.
- **Fix**: Add `claude agents` command that outputs all agents found in `~/.claude/agents/` and `.claude/agents/` with their model/tools summary.

**9. `isolation:worktree` not supported in agents** (`src/agents/`)
- Agents always run in the current working directory. No support for the `isolation: worktree` frontmatter key that spins up an isolated git worktree.
- This is significant for automated CI/CD usage — agents modifying files shouldn't do so in the working tree until approved.

**10. Session resumption doesn't load remote sessions** (`src/sessions/index.mjs`)
- `/resume` and `--resume` only scan local JSONL session files. OAuth users with remote sessions (from CC's cloud sync) can't browse those sessions.

### 🟢 Low Priority / Nice to Have

**11. Diff viewer not wired to permission prompts** (`src/utils/diff.mjs`)
- `src/utils/diff.mjs` exists but is not used in the tool-use approval overlay. Users approve Write/Edit operations without seeing a diff.

**12. Bash history partial-Tab completion**
- `src/keyboard/history-search.mjs` implements Ctrl+R reverse search. Tab-based history autocompletion (type partial + Tab) is not implemented.

**13. Plugin version pinning**
- `src/plugins/installer.mjs` and `src/plugins/manifest.mjs` don't support SHA pinning. All plugins install from HEAD of the specified ref.

**14. Multi-provider API client** (`src/api/client.mjs`)
- API client is Anthropic-only. Adding a provider abstraction layer (`providers/anthropic.mjs`, `providers/bedrock.mjs`, etc.) would unlock Bedrock/Vertex.

**15. No `/teleport` command**
- Not practical to implement in isolation without a cloud relay, but the groundwork (session serialization to a URL-addressable format) could be laid.

**16. Summarize from a specific message**
- `/compact` currently compacts the whole conversation. CC added the ability to select a message as the compaction start point, keeping more recent context intact.

---

## OCC-Unique Features (not in official CC — keep these)

| Feature | Description |
|---------|-------------|
| Plugin system | NPM-installable plugins; manifest validation; `/plugin` manager |
| Steering questions overlay | Multi-tab clarification UI before model starts work |
| Background task graph | Async tasks with dependency tracking and `/tasks` UI |
| Multiple TUI variants | `claude` / `minimal` / `custom` switchable at runtime |
| WebSearch + WebFetch built-in | No MCP config required |
| Dual config reading | Reads `~/.openclaude/` + `~/.claude/` with source badges |
| Readable tools dev mode | `OPENCLAUDE_USE_READABLE_TOOLS=1` for debugging |
| WASM/Yoga layout engine | Alternative rendering backend via WebAssembly |
| Eval system | Built-in evaluation runner for testing agent behaviour |

---

## Recommended Implementation Order

### Sprint 1 — Security & Correctness (immediate)
1. **Heredoc security hardening** — validate delimiter safety before bash execution
2. **Summarize model from config** — remove hardcoded model string
3. **Sandbox on Linux** — add bubblewrap/firejail backend

### Sprint 2 — High-Value Features (next)
4. **Auto Memories** — automatic fact extraction + `.claude/memory/` persistence
5. **`isolation:worktree` for agents** — git worktree sandbox for agent tasks
6. **Plan-mode context clear on accept** — free context window for execution

### Sprint 3 — UX Improvements
7. **Skill hot-reload** — fs.watch on `.claude/skills/`
8. **Diff preview in permission prompts** — wire `utils/diff.mjs` to approval overlay
9. **`claude agents` CLI subcommand** — list configured agents
10. **Bash history Tab completion** — partial-command Tab expansion

### Sprint 4 — Extended Features
11. **"Summarize from here"** — select start point for compaction
12. **Plugin SHA pinning** — reproducible installs
13. **Configurable compaction threshold**
14. **Provider abstraction layer** (foundation for Bedrock/Vertex)

---

## Architecture Assessment (Updated)

### Strengths
- Modular ES module design with clean dependency injection
- JSONL session storage with index caching for performance
- Dual config system enables drop-in compatibility with existing `.claude/` setups
- Plugin system provides extensibility without patching core
- Vitest integration for unit tests; integration test suite for CLI flows
- WASM layout engine is a unique differentiator for custom TUI rendering

### Weaknesses (Revised)
- Provider abstraction is absent — API client is Anthropic-only
- Memory extraction requires architectural work (needs background summarization loop)
- Sandbox is macOS-only despite Linux support being in CC since v2.1.41
- Heredoc validation is cosmetic only — security gap vs CC 2.1.38
- Skills don't hot-reload — session restart required after skill changes
- Agents lack worktree isolation — all file operations happen in working directory
- Plan mode wastes context window by not clearing after plan acceptance

---

## Historical Reference

Previous gap analyses are archived below for reference.

<details>
<summary>v1.0.0 analysis (Feb 17, 2026 — ~95% parity vs CC 2.1.44)</summary>

The February 17 analysis found ~95% parity with CC 2.1.44. The revised score of ~88% reflects additional features in CC 2.1.45–2.1.50 that were not yet released when that analysis was done.

**Remaining Gaps from v1.0.0 report:**
- Automatic memory extraction
- Advanced vim motions
- Permission prompt diff preview
- Streaming diff in permission prompt
- Multi-provider support

</details>

<details>
<summary>v0.3.0 analysis (Feb 2026 — ~75% parity vs CC 2.1.44)</summary>

The original gap analysis documented the state when OCC was at ~75% parity with CC 2.1.44. All items from that list were addressed in v0.4.0 and v1.0.0.

</details>
