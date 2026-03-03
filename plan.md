# Plan: Auto-publish to npm on git tag

## Goal
Create a GitHub Actions workflow that automatically publishes to npm whenever a version tag (e.g. `v1.0.1`) is pushed.

## Files to create
- `.github/workflows/publish.yml` — the workflow

## Workflow logic
1. **Trigger**: `push` to tags matching `v*` (e.g. `v1.0.1`, `v2.0.0`)
2. **Steps**:
   - Checkout repo
   - Setup Node.js 18 with npm registry auth
   - `npm install` (install deps)
   - `npm run test:all` (run tests before publishing)
   - Extract version from tag (`v1.0.1` → `1.0.1`)
   - `npm version` to sync package.json to the tag version (without creating a new git tag)
   - `npm publish` using an `NPM_TOKEN` secret

## Required setup
- User must add `NPM_TOKEN` as a GitHub Actions secret (Settings → Secrets → Actions)
- Token needs `Automation` type from npmjs.com (bypasses 2FA)

## Usage
```bash
git tag v1.0.1
git push origin v1.0.1
```
That's it — workflow fires, tests run, package publishes.
