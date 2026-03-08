---
phase: 1
slug: settings-hierarchy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.mjs (or package.json scripts) |
| **Quick run command** | `npx vitest run tests/settings-hierarchy.test.mjs` |
| **Full suite command** | `npm run test:unit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/settings-hierarchy.test.mjs`
- **After every plan wave:** Run `npm run test:unit`
- **Before `/gsdn:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | SET-01 | unit | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | SET-02 | unit | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | SET-03 | unit | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |
| 01-01-04 | 01 | 1 | SET-04 | unit | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |
| 01-01-05 | 01 | 1 | SET-05 | unit | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 2 | SET-06 | integration | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 2 | SET-07 | integration | `npx vitest run tests/settings-hierarchy.test.mjs` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/settings-hierarchy.test.mjs` — stubs for SET-01 through SET-07
- [ ] Test fixtures with mock settings files at each level (managed, CLI, local, project, user)
- [ ] Helper to create temp directories with settings hierarchy

*Existing vitest infrastructure covers test running.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Managed settings path resolution on macOS vs Linux | SET-05 | Platform-specific paths | Verify `/Library/Application Support/ClaudeCode/` (macOS) and `/etc/claude-code/` (Linux) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
