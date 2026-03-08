---
phase: 3
slug: hook-events-handlers
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-08
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | Implicit (vitest via package.json) |
| **Quick run command** | `npx vitest run tests/hook-events.test.mjs tests/hook-handlers.test.mjs` |
| **Full suite command** | `npm run test:unit` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/hook-events.test.mjs tests/hook-handlers.test.mjs`
- **After every plan wave:** Run `npm run test:unit`
- **Before `/gsdn:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | HEVT-01 | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-01"` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | HEVT-02 | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-02"` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | HEVT-03 | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-03"` | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 1 | HEVT-04 | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-04"` | ❌ W0 | ⬜ pending |
| 03-01-05 | 01 | 1 | HEVT-05 | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-05"` | ❌ W0 | ⬜ pending |
| 03-01-06 | 01 | 1 | HEVT-06 | unit | `npx vitest run tests/hook-events.test.mjs -t "HEVT-06"` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | HTYP-01 | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-01"` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 1 | HTYP-02 | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-02"` | ❌ W0 | ⬜ pending |
| 03-02-03 | 02 | 1 | HTYP-03 | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-03"` | ❌ W0 | ⬜ pending |
| 03-02-04 | 02 | 1 | HTYP-04 | unit | `npx vitest run tests/hook-handlers.test.mjs -t "HTYP-04"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/hook-events.test.mjs` — stubs for HEVT-01 through HEVT-06
- [ ] `tests/hook-handlers.test.mjs` — stubs for HTYP-01 through HTYP-04
- [ ] Mocks needed: `fetch` for HTTP hooks, `@anthropic-ai/sdk` for prompt hooks, `spawnAgent` for agent hooks

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
