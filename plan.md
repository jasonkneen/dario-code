# Plan: Add Feature Tips to Startup WelcomeBanner

## Goal
Add rotating feature tips in the startup design ("insights" style) that highlight unique features of Dario Code vs standard Claude Code, like context management, tool management, skills, voice input, etc.

## Approach

### Where to add
In `src/tui/claude/main.mjs`, modify or extend `WelcomeBanner` to include a feature tip row below the existing content. This appears inside the rounded border box alongside MCP servers info.

Alternatively, modify `WorkspaceTips` to show a rotating tip every session (based on `numStartups` cycling through a list), rather than only showing on first run.

**Decision**: Replace the existing `WorkspaceTips` component behavior with a new `FeatureTip` component that:
1. Always shows (not just until onboarding is complete)
2. Cycles through tips based on `numStartups % tips.length`
3. Uses the insight-style visual (★ star, amber color, styled box)
4. Shows one tip at a time to keep startup clean

### Tips content (unique Dario Code features)
1. `/context manage` — toggle skills, memory, tools on/off to save tokens
2. `/context add <file|url|query>` — inject custom context into the window
3. `/tools` — set per-tool modes: always/ask/auto/off
4. `/approved-tools` — manage which tools can run without confirmation
5. Voice input — hold `Space` to speak your prompt (STT)
6. `/skills` — discover and use slash command skills
7. Plan mode — enter structured planning before coding with `EnterPlanMode`
8. `/compact` — summarize history to free context window space
9. Session picker — `/sessions` to resume previous conversations
10. MCP servers — `/mcp` to add Model Context Protocol integrations

### Visual design
Fits inside the existing `WelcomeBanner` box, below MCP section (or as its own section).

Use a subtle inline style:
```
  💡 Tip: /context manage to toggle skills, memory & tools — saving tokens
```

With dim secondary text style (not full InsightBlock — that's for AI responses, not UI chrome).

### Implementation

Modify `WelcomeBanner` in `src/tui/claude/main.mjs`:
1. Add `FEATURE_TIPS` array constant near `WelcomeBanner`
2. Inside `WelcomeBanner`, call `loadConfig()` to get `numStartups`
3. Pick `tip = FEATURE_TIPS[numStartups % FEATURE_TIPS.length]`
4. Render it as a new section inside the banner box, after MCP block

Also update `WorkspaceTips` to return null always (or remove its usage) since the tip section covers this.

Actually — keep `WorkspaceTips` as-is (it shows first-run tips separately), and add the feature tip *inside* the banner box. This keeps both.

## Files to change
- `src/tui/claude/main.mjs`: Add `FEATURE_TIPS` array + render a tip row in `WelcomeBanner`
