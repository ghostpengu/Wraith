<div align="center">

<img src="public/wraith-logo.png" alt="Wraith" width="120" height="120" />

# Wraith

A tiling terminal emulator with a built-in AI agent pane. Built for Windows with Tauri, Rust, React, and xterm.js.

[![Built with Tauri](https://img.shields.io/badge/Tauri-v2-orange?logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-backend-dea584?logo=rust)](https://www.rust-lang.org/)
[![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-~5.8-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/version-0.1.0-blue)](#)

</div>

---

Wraith is a Windows desktop terminal that runs PowerShell inside real pseudo-terminals (PTY) and renders them in a VS Code–style dark tiling layout — sessions, splits, drag-to-swap panes. Each leaf in the pane tree can be either a terminal **or** an AI agent chat that can see your panes, read their output, and run commands with your approval.

## Features

### Terminal
- Real PTY-backed PowerShell sessions (Rust + `portable-pty`)
- Tiling pane tree — horizontal/vertical splits, aspect-ratio-aware direction, drag-to-swap
- Session tabs kept mounted and hidden so terminal state survives tab switches
- VS Code-inspired dark theme via CSS variables
- Font zoom, `Cascadia Code` terminal stack, `FitAddon`-driven resizing

### AI agent pane
- A pane can be `kind: "agent"` instead of a terminal — launched from the `+ Agent` button
- LLM streaming via OpenAI-compatible `/chat/completions` (OpenRouter, Ollama Cloud, etc.)
- Tools the agent can call:
  - `list_panes` — inspect the current pane tree
  - `read_pane` — read scrollback from any pane via a ring buffer
  - `run_command` — execute a command in a pane (with **Approve / Decline** gate)
- Approval cards pause the stream until you accept; read-only tools run automatically
- Settings persist to `~/.wraith/agent.json`
- Markdown rendering for assistant messages

### Niceties
- Linked sessions, pane restart, persistence
- AI shortcuts for `codex`, `opencode`, `claude`, `grok` directly in the toolbar
- Agent completion notifications — blinking pane, confetti, chime
- Dictation support (voice → text) in the agent pane

## Screenshots

> Add screenshots here (`public/wraith-logo.png` is available as a placeholder).

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19, TypeScript, Vite 7, xterm.js 6 |
| Backend | Rust, Tauri 2, `portable-pty` |
| Package manager | pnpm |
| Platform | Windows (spawns `powershell.exe`) |

## Getting started

### Prerequisites
- Node.js
- pnpm
- Rust toolchain
- Tauri system dependencies for Windows

### Install & run

```bash
pnpm install
pnpm tauri dev        # full app — Vite on :1420 + Tauri window
# or
pnpm dev              # frontend only (no PTY; useful for UI work)
```

### Build a production bundle

```bash
pnpm build            # tsc + vite → dist/
pnpm tauri build      # desktop installer
```

### Rust-only check (from `src-tauri/`)

```bash
cargo check
cargo build
```

> No test suite or linter is configured yet. After frontend changes, run `pnpm build` to catch TypeScript errors.

## Project layout

```
src/
  App.tsx                  # Main UI: sessions, tiling, xterm integration
  App.css                  # VS Code–inspired dark theme
  agent/
    AgentPaneView.tsx       # Chat UI + approval cards
    AgentSettingsModal.tsx  # Provider/model/key form
    useAgent.ts             # LLM streaming + tool loop with approval
    tools.ts                # Tool schemas + executors
    paneBuffer.ts           # Per-PTY scrollback ring buffer
    commandMarker.ts        # __WRAITH_AGENT_DONE__ marker logic
    orchestratorTypes.ts    # Pane-agent orchestration types
    orchestratorWait.ts     # Token / pane-output waiters
    AgentMarkdown.tsx       # Markdown rendering for messages
    dictation.ts            # Voice dictation helpers
src-tauri/
  src/lib.rs               # PTY commands + event emission
  tauri.conf.json
  Cargo.toml
```

## Architecture

### Frontend ↔ backend bridge

The frontend uses Tauri `invoke` for commands and `listen` for events.

| Command | Purpose |
|---------|---------|
| `spawn_powershell` | Create a PTY, return its `id` |
| `write_powershell` | Send keystrokes to a PTY |
| `resize_powershell` | Resize a PTY (`cols`, `rows`) |
| `kill_powershell` | Terminate a PTY process |
| `list_powershell` | List active PTY ids |
| `load_agent_settings` | Load `~/.wraith/agent.json` (merged with defaults) |
| `save_agent_settings` | Persist provider/model/baseUrl/apiKey |

| Event | Payload | Purpose |
|-------|---------|---------|
| `pty-output` | `{ id, data }` | Terminal output stream |
| `pty-exit` | `id` | Process exited |

PTY listeners are registered before spawning (`ptyListenersReady` gate in `App.tsx`); output arriving before a window is registered is buffered in `pendingOutputRef`.

### Tiling layout

Pane layout is a binary tree of `LayoutNode`s:

- **leaf** — one terminal or agent window (`winId`)
- **split** — `row` or `column` with a `ratio` clamped to `0.15`–`0.85`

New panes split relative to the active pane; direction follows aspect ratio. Helper functions in `App.tsx` handle insert, remove, swap, and resize.

### Session model

- **Session** — named tab containing multiple `Win` objects and one layout tree
- **Win** — xterm `Terminal` + `FitAddon`, tied to a PTY `id`
- Sessions stay mounted but hidden (`session-view` / `aria-hidden`) so xterm state survives tab switches

### Agent tool loop

1. `PaneBufferStore` subscribes to `pty-output` and keeps a per-`ptyId` scrollback ring buffer.
2. The model emits a tool call:
   - `list_panes` / `read_pane` → run immediately, return result.
   - `run_command` → assistant message enters `awaiting-approval`; an Approve/Decline card renders.
3. On approval, the command is wrapped with a `__WRAITH_AGENT_DONE__` marker, written via `write_powershell`, and a one-shot `pty-output` listener captures output + exit code.
4. The result is fed back to the model and streaming continues.

Agent panes are stripped from the layout before `save_sessions` (`stripAgentLeaves`), so they start fresh per session (MVP behavior).

## Configuration

Agent settings are stored at `~/.wraith/agent.json`:

```jsonc
{
  "provider": "openrouter",   // or "ollama"
  "model": "...",
  "baseUrl": "https://...",
  "apiKey": "sk-..."
}
```

Use the **Settings** button in any agent pane to edit them; they persist across restarts.

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Verification checklist

Before finishing a change:

1. `pnpm build` — TypeScript + Vite build passes
2. `cargo check` in `src-tauri/` — Rust compiles (for backend changes)
3. `pnpm tauri dev` — manual smoke test: spawn session, split pane, resize divider, drag-swap panes, run an agent command, close pane/session

## Pitfalls

- **Strict port:** Vite uses port `1420` with `strictPort: true`; another process on that port fails dev startup.
- **React StrictMode:** Double-mount in dev is handled via refs and cleanup — don't assume single mount.
- **PTY lifecycle:** Always `kill_powershell` and dispose xterm listeners when closing panes/sessions.
- **Layout + xterm:** Layout changes never recreate terminals — only DOM reparenting and `fit()` run. Bugs here usually mean a missing `fitAndRefresh` or a bad `ResizeObserver`.
- **Large `App.tsx`:** Read surrounding code before editing; match existing patterns for pointer-drag and split dividers.

## License

Not yet specified. Add a `LICENSE` file before public release.

<div align="center">

Built with Tauri · Rust · React · xterm.js

</div>