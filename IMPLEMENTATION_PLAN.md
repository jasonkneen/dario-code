# Implementation Plan — CC 2.1.50+ Parity

All remaining gaps from GAP_ANALYSIS.md. Implement every item below. Do NOT skip anything.
After each major section, verify syntax with `node --check <file>`.

---

## ALREADY DONE (skip these)
- Heredoc security validation in bash.mjs ✅
- Hardcoded summarize model fix ✅
- Skill hot-reload (startSkillsHotReload) ✅
- isolation:worktree agent frontmatter key + worktree-isolation.mjs ✅
- onPlanApproved callback in plan.mjs ✅
- `claude agents` CLI subcommand ✅

---

## 1. Auto Memories — `.claude/memory/` cross-session fact extraction

**Files to create:**
- `src/memory/auto-memory.mjs` — core fact extraction + persistence
- `src/memory/memory-watcher.mjs` — background loop that triggers extraction

**What to implement:**

`src/memory/auto-memory.mjs`:
```
- MEMORY_DIR: path.join(cwd, '.claude', 'memory') (project) + path.join(homedir(), '.claude', 'memory') (global)
- extractMemories(messages, existingMemories) → calls Claude with a prompt asking it to extract new durable facts from recent messages. Returns array of { key, value, source, timestamp }.
- saveMemory(fact, scope='project') → writes to .claude/memory/<key>.md as frontmatter+body
- loadMemories(cwd) → reads all .md files from memory dirs, returns Map<key, fact>
- buildMemoryContext(cwd) → formats loaded memories as a system prompt section
- shouldExtract(messages, lastExtractedAt) → returns true if >5 new assistant turns since last extraction OR >10min elapsed
```

`src/memory/memory-watcher.mjs`:
```
- startMemoryWatcher(getMessages, cwd) → sets up setInterval (every 5 min) + turn counter
  - On trigger: calls extractMemories(getMessages(), loadMemories(cwd)) 
  - Saves any new facts via saveMemory
  - Returns stop() function
- Exported: startMemoryWatcher, stopMemoryWatcher
```

Wire up in `src/core/config.mjs` or wherever system prompt is assembled:
- Call `buildMemoryContext(cwd)` and include in system prompt under "# Memories" section

Add `/memory` command improvements in `src/cli/commands.mjs`:
- `/memory list` → show all extracted memories
- `/memory edit <key>` → open specific memory in editor
- `/memory delete <key>` → remove a memory fact
- `/memory clear` → remove all auto-extracted memories (with confirmation)

---

## 2. "Summarize from here" — partial compaction from a message

**Files to modify:**
- `src/utils/summarize.mjs` — add `compactFromMessage(messages, fromIndex, keepLastN)`
- `src/cli/commands.mjs` — update `/compact` command to accept optional message index/selector

**What to implement:**

In `summarize.mjs` add:
```js
export async function compactFromMessage(messages, fromIndex, keepLastN = 4) {
  // Summarize messages[fromIndex...-keepLastN], keep the rest intact
  // Returns new message array with a summary marker inserted at fromIndex
}
```

In commands.mjs update compactCommand:
- `/compact` → existing behaviour (compact all)
- `/compact <N>` → compact from message N onwards (keep last N messages)
- `/compact last <N>` → keep only last N messages, summarize everything before

---

## 3. Bash history Tab autocomplete

**Files to modify:**
- `src/keyboard/index.mjs` — add Tab handler for partial-history completion
- `src/keyboard/history-search.mjs` — add `getTabCompletion(partial)` method

**What to implement:**

In `history-search.mjs` add:
```js
getTabCompletion(partial) {
  if (!partial.trim()) return null
  // Find the most recent history entry that starts with `partial`
  for (let i = this.history.length - 1; i >= 0; i--) {
    if (this.history[i].startsWith(partial)) return this.history[i]
  }
  return null
}
```

In `keyboard/index.mjs`:
- When Tab is pressed AND current input is non-empty AND NOT in thinking-toggle mode:
  - Call `historySearch.getTabCompletion(currentInput)`
  - If a match found, emit 'tab-complete' event with the completed text
  - If no match, fall through to existing Tab behaviour (thinking toggle)

---

## 4. Linux sandbox support

**Files to modify:**
- `src/sandbox/sandbox.mjs` — add Linux sandbox backends

**What to implement:**

Update `isSandboxSupported()` to return true on Linux too.

Add `detectLinuxSandboxBin()`:
```js
// Returns 'bwrap' if bubblewrap is installed, 'firejail' if firejail is installed, null otherwise
```

Add `wrapCommandLinux(command, projectDir)`:
```js
// Wraps command with bubblewrap (preferred) or firejail
// bwrap: --ro-bind / / --bind <projectDir> <projectDir> --proc /proc --dev /dev ...
// firejail: firejail --whitelist=<projectDir> -- <command>
```

Update `wrapCommand(command, projectDir)` (or `sandboxCommand`) to:
- On macOS: use existing sandbox-exec approach  
- On Linux: use wrapCommandLinux
- On other: return command unchanged with a warning

---

## 5. Diff preview in permission prompts

**Files to modify:**
- `src/ui/permission-prompt.mjs` (or wherever tool approval UI lives — find it)
- `src/utils/diff.mjs` — ensure it exports `generateDiff(before, after)` and `renderDiff(diff)` 

**What to implement:**

Find the component/function that renders the "Allow this tool?" approval prompt for Write/Edit tools.

Before showing the prompt:
- For `Write` tool: if file already exists, read existing content, generate diff between existing and proposed
- For `Edit` tool: generate diff between old_string and new_string
- Render a compact unified diff (max 50 lines) above the approve/reject buttons

In `src/utils/diff.mjs` ensure:
```js
export function generateUnifiedDiff(filename, before, after, context = 3) { ... }
export function renderDiffColored(diff) { ... } // green/red ANSI for terminal
```

---

## 6. Plugin SHA pinning

**Files to modify:**
- `src/plugins/installer.mjs`
- `src/plugins/manifest.mjs`

**What to implement:**

Plugin manifest should support:
```json
{
  "name": "my-plugin",
  "source": "github:user/repo",
  "pin": "abc1234"  // optional git SHA
}
```

In `installer.mjs`:
- When `pin` is set, pass it to the git clone/fetch as `--branch` or checkout by SHA after clone
- After install, record the resolved SHA in the installed plugin record
- On `plugin update`: if pinned, warn user that the plugin is pinned and skip auto-update unless `--force` or `--unpin` flag used

In `manifest.mjs`:
- Add `pin` field to schema validation
- Add `resolvedSha` to the installed plugin record

---

## 7. Configurable auto-compact threshold

**Files to modify:**
- `src/config/defaults.mjs` (or wherever default config lives — check src/config/)
- `src/cli/app.mjs` (or wherever auto-compact is triggered — search for the compact threshold)

**What to implement:**

Add `compactThreshold` to config schema with default `0.85` (85% context usage).
When the auto-compact check runs, read `config.compactThreshold` instead of the hardcoded value.
Document in `/config` command: `compactThreshold: 0.85  # Trigger compaction at 85% context usage`

---

## 8. Wire `onPlanApproved` to context compaction in the TUI

**Files to modify:**
- Find the TUI app entry file (likely `src/tui/app.mjs` or `src/cli/app.mjs`)

**What to implement:**

After plan system is initialised in the TUI, register:
```js
import { onPlanApproved } from '../plan/plan.mjs'
import { compactMessagesWithAi } from '../utils/summarize.mjs'

onPlanApproved(async (plan) => {
  // Compact the conversation, keeping the plan content as a summary message
  const planContent = fs.readFileSync(planPath, 'utf-8').trim()
  const summaryMsg = createMessage('user', 
    `[Plan approved and context cleared for execution]\n\n${planContent}`)
  // Replace messages with [summaryMsg] 
  setMessages([summaryMsg])
})
```

---

## 9. Wire skill hot-reload into the TUI

**Files to modify:**
- Same TUI app entry as above

**What to implement:**

After TUI initialises, call:
```js
import { startSkillsHotReload, onSkillsChanged } from '../tools/skills-discovery.mjs'

startSkillsHotReload(cwd)
onSkillsChanged(() => {
  // Invalidate skills cache — force re-discovery on next skill lookup
  invalidateSkillsCache()
})
```

---

## FINAL STEPS

1. Run `node --check` on every modified file
2. Run existing tests if any: `npm test` or `npx vitest run` 
3. Update `GAP_ANALYSIS.md`: mark all implemented items ✅, update parity to ~97%
4. Update `CHANGES_2026_02_27.md` with all new work
5. Do NOT commit — leave that to the user

---

## Notes

- ES modules throughout (`.mjs`) — no CommonJS
- No new npm dependencies unless absolutely necessary (prefer Node built-ins)  
- Keep existing code style: JSDoc comments, named exports, default export object at bottom
- For any UI work: follow the existing Ink/React pattern in `src/ui/`
- If a file doesn't exist where expected, search for it with glob/grep before creating it
