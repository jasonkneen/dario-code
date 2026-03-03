# Windows Notes

## Recent updates (March 3, 2026)

These fixes were added after initial Windows bring-up:

- Reduced TUI flicker on Windows while `Thinking...` is shown:
  - Default behavior in PowerShell hosts now uses a static indicator instead of an animated spinner.
  - This avoids rapid full-screen redraw/flicker in terminals that repaint aggressively.
  - Optional overrides:
    - `DARIO_FORCE_SPINNER_ANIMATION=1` to force animation.
    - `DARIO_DISABLE_SPINNER_ANIMATION=1` to disable animation on any platform.
- Added startup PowerShell host detection and gated render behavior:
  - Detection uses PowerShell environment markers (for example `PSModulePath`).
  - This keeps special rendering logic targeted to PowerShell instead of all Windows shells.
- Throttled assistant streaming UI updates in PowerShell:
  - Streaming responses are batched before rendering in the TUI.
  - This prevents per-token full-frame redraw storms in PowerShell/ConHost terminals.
  - Optional overrides:
    - `DARIO_STREAM_RENDER_THROTTLE_MS=<number>` to set throttle delay.
    - `DARIO_DISABLE_STREAM_THROTTLE=1` to disable throttling.
- Added coarse streaming mode for PowerShell:
  - During a streaming response, the UI keeps the latest assistant snapshot and renders on flush points instead of per chunk.
  - Set `DARIO_POWERSHELL_COARSE_STREAMING=0` if you want classic per-chunk streaming in PowerShell.
- Prevented noisy startup output outside Git repositories:
  - Git stats are only queried after confirming the current folder is a Git work tree.
  - This avoids the `git diff --no-index` usage block appearing in non-repo folders.

This document explains how this repository behaves on Windows, what was changed for Windows compatibility, and what still differs from Linux/macOS.

## Current status

The project now runs on Windows for normal CLI use and the test suite.

Validated on Windows:

- `npm run start -- --help`
- `npm run dev -- --help`
- `npm run tui:list`
- `npm run test:readable`
- `npm run test:debug`
- `npm run test:unit`
- `npm run test:all`

## What was changed for Windows

### 1. Cross-platform shell execution

Shell command execution no longer assumes `sh` exists.

- On Windows:
  - Use Git Bash (`bash.exe`) if found.
  - If Git Bash is not found, fall back to `cmd.exe`.
- On Linux/macOS:
  - Use `$SHELL` if set, otherwise `sh`.

This affects the Bash tool runtime and sandbox fallback execution.

### 2. Session path encoding for Windows paths

Session project folder encoding now supports Windows paths correctly.

- Example:
  - Input: `C:\Users\name\my_project`
  - Encoded folder: `C-Users-name-my-project`

This fixes session index/file path failures seen on Windows.

### 3. npm scripts are now platform-neutral

Scripts were updated to avoid Unix-only syntax (`./cli.mjs`, inline env assignment, `ls | grep` pipelines).

Helper scripts were added:

- `scripts/run-cli.mjs`
- `scripts/run-integration.mjs`
- `scripts/list-tuis.mjs`

### 4. Terminal setup command supports PowerShell

`/terminal-setup` now handles Windows by:

- Detecting PowerShell.
- Suggesting `Set-Alias claude dario` in the user profile.
- Checking `dario` availability with `Get-Command`.

### 5. Windows-specific install hints for voice

Voice mode depends on a SoX-compatible recorder command (`sox_ng`, `sox`, or `rec`).
Recommended on Windows: `sox_ng` (actively maintained SoX fork).

In this project, the recorder command is used to capture microphone audio before it is sent to the speech-to-text provider.
If no compatible recorder command is found, voice mode cannot start.

`winget` and `choco` are package managers:

- `winget`: Windows Package Manager (often preinstalled on modern Windows).
- `choco`: Chocolatey (third-party package manager; may not be installed).

Check what you have:

```powershell
winget --version
choco --version
```

Install SoX on Windows (choose one option):

1. If `winget` is available:
   - `winget install --id sox_ng.sox_ng --exact`
2. If `choco` is available:
   - `choco install sox`
3. If neither is available, install manually:
   - Download a current SoX-compatible Windows build (recommended: SoX_ng release).
   - Install or extract it to a stable folder (example: `C:\Tools\sox`).
   - Add the SoX folder (or its `bin` folder) to your `PATH`.
4. Close and reopen your terminal.
5. Verify:
   - `sox_ng --version`
   - If you installed classic SoX instead: `sox --version`

If `sox` is still not found, it is almost always a `PATH` issue.

### 6. Git Bash installation on Windows

The Bash tool works best when Git Bash is installed.
Without Git Bash, this project falls back to `cmd.exe`, and some Bash commands will fail.

`winget` and `choco` can also install Git:

- `winget`: Windows Package Manager
- `choco`: Chocolatey

Check what you have:

```powershell
winget --version
choco --version
```

Install Git Bash (choose one option):

1. If `winget` is available:
   - `winget install Git.Git`
2. If `choco` is available:
   - `choco install git`
3. If neither is available, install manually:
   - Download Git for Windows from the official Git for Windows site.
   - Run installer with default options unless your environment needs custom settings.
   - Ensure Git Bash is included and Git is added to `PATH`.
4. Close and reopen your terminal.
5. Verify Git Bash:
   - `bash --version`
   - `where bash`

Typical installed paths:

- `C:\Program Files\Git\bin\bash.exe`
- `C:\Program Files\Git\usr\bin\bash.exe`

### 7. Repeatable setup with a local `winget-win-tools.json`

If you work on this project on multiple Windows machines, a local `winget-win-tools.json` is the most practical way to keep tool setup consistent.

Why use this approach:

- Repeatable setup: same tool IDs can be installed again after a machine reset.
- Clear audit trail: the exact package identifiers are visible in one file.
- Local only: the file stays on your machine unless you decide to share it.
- No custom packaging: you are not creating or publishing any `winget` package.

Tool IDs to include for this repository:

- `Git.Git` (Git + Git Bash used by shell execution and Git features)
- `BurntSushi.ripgrep.MSVC` (`rg` used by Grep tool and related tests)
- `GitHub.cli` (`gh` used by `/pr-comments`)
- `sox_ng.sox_ng` (`sox_ng` command used by voice recording; `sox`/`rec` remain fallbacks)

Canonical file in this repository:

- `docs/windows/winget-win-tools.json`

Install these directly:

```powershell
winget install --id Git.Git --exact
winget install --id BurntSushi.ripgrep.MSVC --exact
winget install --id GitHub.cli --exact
winget install --id sox_ng.sox_ng --exact
```

Then export your local install set:

```powershell
winget export -o winget-win-tools.json
```

Note: `winget export` captures your installed package set. If you want a minimal file for this repo, keep only the four IDs listed above in that JSON.

Restore later on another Windows machine:

```powershell
winget import -i docs/windows/winget-win-tools.json
```

Why `winget` is generally a safe source:

- `winget` client is maintained by Microsoft.
- Package manifests are public in the open-source `winget-pkgs` repository.
- Manifests are reviewed, and package installers are hash-validated during install.

Why this is only "mostly" safe:

- Trust still depends on the original software publisher and download endpoint.
- A compromised upstream installer is still a risk in any package manager.

Recommended safety checks:

- Use `--exact` and explicit IDs to avoid accidental package mismatches.
- Check package details before install: `winget show --id <ID> --exact`.
- Keep Windows Defender and SmartScreen enabled.

## Behavior differences on Windows

### Bash tool behavior depends on available shell

If Git Bash is installed, Bash-like commands work as expected.

If Git Bash is not installed, commands run via `cmd.exe`, so Bash syntax may fail.

Examples that can fail in `cmd.exe` fallback:

- `echo "x" >&2`
- `sleep 1`
- Bash-specific operators and shell features

Recommendation: install Git for Windows so `bash.exe` is available.

### Sandboxing

Sandbox mode is not supported on Windows.

- macOS: supported via `sandbox-exec`
- Linux: supported via `bwrap`/`firejail` if available
- Windows: commands run without sandboxing

If strict sandboxing is required, use Linux/macOS.

## Not supported on Windows (current)

### Clipboard access caveats in headless or restricted environments

Clipboard text/image support is implemented on Windows using `@napi-rs/clipboard`.
Image conversion to PNG for mentions also relies on PowerShell (`System.Windows.Forms`) to read image dimensions.

This can still fail in restricted contexts, for example:

- service accounts without desktop session access
- locked-down CI runners without clipboard access
- hardened environments where PowerShell or clipboard APIs are blocked

## Configuration notes for Windows

### Recommended prerequisites

- Node.js 18+ (22+ works)
- Git for Windows (for Git Bash support)
- Optional for voice: SoX-compatible recorder (`sox_ng` recommended)

### PowerShell alias

For Claude-compatible command alias in PowerShell profile:

```powershell
Set-Alias claude dario
```

## Troubleshooting

### `Bash` tool commands fail with shell syntax errors

Likely running in `cmd.exe` fallback.

1. Install Git Bash (see section "Git Bash installation on Windows").
2. Restart terminal.
3. Verify `bash --version` works.
4. Re-run your command.

### Voice mode says recorder is missing

Install SoX-compatible tooling using the steps in section "Windows-specific install hints for voice", then restart terminal and verify with `sox_ng --version` (or `sox --version` for classic SoX).

### Session errors with malformed project path

This should be fixed by current encoding logic. If you still see this, delete old broken session directories under:

- `%USERPROFILE%\.dario\projects\`
