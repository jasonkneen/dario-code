# PRD: Insight Blocks

## Overview

Insight blocks are inline educational annotations that the model produces while working. They surface the *reasoning* behind implementation choices — trade-offs, patterns, codebase-specific details — so the user learns as the agent works.

## Format

```
★ Insight ─────────────────────────────────────
[2-3 concise educational points]
─────────────────────────────────────────────────
```

- Opening line: `★ Insight` followed by box-drawing dashes (`─`, U+2500)
- Closing line: 10+ box-drawing dashes
- Both lines may optionally be wrapped in backticks for markdown compatibility
- Content is plain text, trimmed of leading/trailing whitespace

## When the model generates them

Insights are produced **before and after writing code**, specifically when:

1. There's a meaningful implementation choice with trade-offs
2. The code touches a non-obvious pattern specific to the codebase
3. The approach has an interesting "why" that isn't self-evident

Insights are **not** produced for:

- Trivial changes (typo fixes, simple renames)
- General programming knowledge ("what is a for loop")
- Boilerplate or configuration
- Every single code change — they should feel natural, not spammy

## How to trigger generation

The model generates Insight blocks when instructed via system prompt. The instruction is injected based on the active **output style**. When the output style is `learning` (or any style that includes educational content), append this to the system prompt:

```
Before and after writing code, provide brief educational explanations
about implementation choices using:

"★ Insight ─────────────────────────────────────"
[2-3 key educational points]
"─────────────────────────────────────────────────"

These insights should be included in the conversation, not in the codebase.
Focus on interesting insights specific to the codebase or the code you just
wrote, rather than general programming concepts.
```

## Rendering

### TUI (interactive terminal)

1. **Detection**: Regex-match opening (`/^`?★\s*Insight\s*─+`?$/`) and closing (`/^`?─{10,}`?$/`) lines in text content blocks
2. **Parsing**: Split text into alternating `{ type: 'text' | 'insight', content }` segments
3. **Display**:
   - Header: orange/amber (`#F59E0B`), bold, with star and dashes
   - Body: yellow (`#FCD34D`), indented 2 spaces from header
   - Closing: orange/amber dashes matching header width
   - Vertical margin: 1 line above and below

### Print mode (`-p`)

In `--output-format text`: raw text passes through as-is (user sees the Unicode markers in terminal).

In `--output-format stream-json`: text blocks contain the raw Insight markup. Consumers can parse it client-side using the same regex.

### Web/HTML rendering

If rendering in a web UI, detect the same pattern and render as a styled callout:
- Background: `rgba(245, 158, 11, 0.1)` (amber tint)
- Left border: `3px solid #F59E0B`
- Icon: ★ or lightbulb
- Typography: slightly smaller than body text

## Implementation checklist

### Already done (in this codebase)

- [x] TUI detection regex (`INSIGHT_OPEN_RE`, `INSIGHT_CLOSE_RE`)
- [x] `parseInsightBlocks()` text splitter
- [x] `InsightBlock` React/Ink component with styled rendering
- [x] Integration into `AssistantContentRenderer` text case
- [x] Unit tests for parsing (14 tests)
- [x] Integration tests for stream-json pipeline (3 tests)

### Not yet implemented

- [ ] **Output style system**: Core config setting (`outputStyle: 'learning' | 'concise' | 'normal'`) that controls which system prompt additions are injected
- [ ] **`/style` command**: Slash command to switch output style mid-session
- [ ] **System prompt injection**: When `outputStyle === 'learning'`, append the Insight generation instruction to the system prompt
- [ ] **Config persistence**: Save output style preference in `~/.dario/config.json`
- [ ] **Print mode rendering**: Optionally strip or preserve Insight markers in `-p` text output

## Porting to other tools

To add Insight block support to another CLI tool:

1. **System prompt**: Add the generation instruction (above) to your system prompt when the learning/educational mode is active
2. **Detection**: Use the two regexes to find Insight blocks in model output text
3. **Rendering**: Style them distinctly from regular output — the visual separation is what makes them useful without being distracting
4. **Gating**: Only inject the system prompt instruction when the user has opted into educational/learning mode. Never generate Insights by default — they add noise for experienced users who just want the work done

## Design principles

- **Serendipitous, not mechanical**: Insights should feel like a knowledgeable colleague sharing something interesting, not a textbook sidebar on every change
- **Codebase-specific**: "This uses the factory pattern because X dependency requires it" is good. "The factory pattern creates objects without specifying their class" is bad.
- **Brief**: 2-3 lines. If it needs more, it's not an insight — it's documentation.
- **Non-blocking**: Insights are rendered inline with the work output. They don't interrupt the flow or require interaction.
