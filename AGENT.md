# Wraith

Wraith is a Windows desktop terminal emulator built with Tauri v2. It spawns PowerShell instances in pseudo-terminals (PTY) and renders them with xterm.js inside a tiling pane layout (sessions, splits, drag-to-swap).

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19, TypeScript, Vite 7, xterm.js |
| Backend | Rust, Tauri 2, `portable-pty` |
| Package manager | pnpm |
| Platform | Windows (spawns `powershell.exe`) |

## Project layout

```
src/
  App.tsx       # Main UI: sessions, tiling layout, xterm integration
  App.css       # VS Code–inspired dark theme (CSS variables)
  main.tsx      # React entry
src-tauri/
  src/lib.rs    # PTY commands and event emission
  tauri.conf.json
  Cargo.toml
```

Most application logic lives in `src/App.tsx` (~1000 lines). The Rust backend is a thin PTY wrapper in `src-tauri/src/lib.rs`.

## Dev environment

**Prerequisites:** Node.js, pnpm, Rust toolchain, and the Tauri system dependencies for Windows.

```bash
pnpm install
pnpm tauri dev          # full app (Vite on :1420 + Tauri window)
pnpm dev                # frontend only (no PTY; useful for UI work)
```

**Build:**

```bash
pnpm build              # tsc + vite → dist/
pnpm tauri build        # production desktop bundle
```

**Rust-only check** (from `src-tauri/`):

```bash
cargo build
cargo check
```

There is no test suite or linter configured yet. After frontend changes, run `pnpm build` to catch TypeScript errors.

## Architecture

### Frontend ↔ backend bridge

The frontend uses Tauri `invoke` for commands and `listen` for events.

| Command | Purpose |
|---------|---------|
| `spawn_powershell` | Create PTY, return `id` |
| `write_powershell` | Send keystrokes to PTY |
| `resize_powershell` | Resize PTY (`cols`, `rows`) |
| `kill_powershell` | Terminate PTY process |
| `list_powershell` | List active PTY ids |

| Event | Payload | Purpose |
|-------|---------|---------|
| `pty-output` | `{ id, data }` | Terminal output stream |
| `pty-exit` | `id` | Process exited |

PTY listeners must be ready before spawning (`ptyListenersReady` gate in `App.tsx`). Output that arrives before a window is registered is buffered in `pendingOutputRef`.

### Tiling layout

Pane layout is a binary tree (`LayoutNode`):

- **leaf** — one terminal window (`winId`)
- **split** — horizontal (`row`) or vertical (`column`) with a `ratio` (0.15–0.85)

Helper functions in `App.tsx` handle insert, remove, swap, and resize. New panes split relative to the active pane; direction follows aspect ratio.

### Session model

- **Session** — named tab with multiple `Win` objects and one layout tree
- **Win** — xterm `Terminal` + `FitAddon`, tied to a PTY `id`
- Sessions are kept mounted but hidden (`session-view` / `aria-hidden`) so xterm state survives tab switches

## Code conventions

### Frontend

- Match the existing VS Code dark palette in `App.css` (`--bg`, `--accent`, etc.).
- Use CSS variables; avoid hardcoded colors in new styles.
- Terminal font stack: `Cascadia Code, Consolas, Courier New, monospace`.
- Prefer `useCallback` / refs (`sessionsRef`, `activeSessionRef`) for handlers that read latest state without stale closures.
- xterm instances are created once per `Win` and re-parented via `TermContainer`; do not recreate terminals on layout changes.
- Call `fitAndRefresh` after resize or layout changes so xterm dimensions stay correct.

### Rust

- PTY state lives in `AppState` (`Mutex<HashMap<String, PtyInstance>>`).
- Each PTY runs a reader thread that emits `pty-output`; on EOF it emits `pty-exit`.
- `kill_flag` stops the reader loop; `kill_all` runs on window close.
- Return `Result<_, String>` from commands; format errors with `format!("...: {e}")`.
- `spawn_powershell` accepts optional `cwd`; defaults to PowerShell with `-NoLogo`.

### Scope discipline

- Keep changes focused. Do not refactor `App.tsx` into modules unless asked.
- Do not add dependencies without a clear need.
- Do not create markdown files the user did not request.
- Windows-only behavior (`powershell.exe`) is intentional; do not add cross-shell abstractions unless requested.

## Common tasks

| Task | Where to change |
|------|-----------------|
| UI / layout / theming | `src/App.tsx`, `src/App.css` |
| New Tauri command or PTY behavior | `src-tauri/src/lib.rs`, register in `invoke_handler` |
| Window size / app metadata | `src-tauri/tauri.conf.json` |
| Dev server port | `vite.config.ts` (1420) and `tauri.conf.json` `devUrl` |

## Pitfalls

- **Strict port:** Vite uses port 1420 with `strictPort: true`; another process on that port will fail dev startup.
- **React StrictMode:** Double-mount in dev is handled via refs and cleanup; avoid assuming single mount.
- **PTY lifecycle:** Always call `kill_powershell` and dispose xterm listeners (`onResizeDispose`, `onDataDispose`) when closing panes or sessions.
- **Layout + xterm:** Changing layout does not recreate terminals; only DOM reparenting and `fit()` run. Bugs here usually mean missing `fitAndRefresh` or incorrect `ResizeObserver` setup.
- **Large App.tsx:** Read surrounding code before editing. Match existing patterns for pointer-drag, split dividers, and session state updates.

## Verification checklist

Before finishing a change:

1. `pnpm build` — TypeScript and Vite build pass
2. `cargo check` in `src-tauri/` — Rust compiles (for backend changes)
3. `pnpm tauri dev` — manual smoke test: spawn session, split pane, resize divider, drag-swap panes, close pane/session