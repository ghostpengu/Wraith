import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";
import openaiIcon from "./assets/ai-openai.svg";
import claudeIcon from "./assets/ai-claude.svg";
import opencodeIcon from "./assets/ai-opencode.svg";
import appLogo from "./assets/wraith-logo.png";
import "./App.css";

interface AiShortcut {
  label: string;
  command: string;
  icon?: string;
  badge?: string;
}

const AI_SHORTCUTS: AiShortcut[] = [
  { label: "codex", command: "codex", icon: openaiIcon },
  { label: "opencode", command: "opencode", icon: opencodeIcon },
  { label: "claude", command: "claude", icon: claudeIcon },
  { label: "grok", command: "grok", badge: "G" },
];

interface PtyOutputPayload {
  id: string;
  data: string;
}

interface AgentHookFinishedPayload {
  runId: string;
  agent?: string;
}

interface AgentRun {
  token: string;
  label: string;
  sessionName: string;
  paneId: string;
  command: string;
  echoText: string;
  echoMatched: number;
  echoDisplayed: boolean;
  armed: boolean;
  notified: boolean;
}

interface AgentCompletionMarker {
  token: string;
  exitCode: number;
}

interface AgentToast {
  id: string;
  label: string;
  sessionName: string;
  exitCode: number;
  status: "success" | "warning";
}

type SplitDir = "row" | "column";

interface LayoutLeaf {
  type: "leaf";
  winId: string;
}

interface LayoutSplit {
  type: "split";
  id: string;
  dir: SplitDir;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

type LayoutNode = LayoutLeaf | LayoutSplit;

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PaneDragState {
  winId: string;
  targetWinId: string | null;
}

interface PaneDragSession {
  winId: string;
  startX: number;
  startY: number;
  active: boolean;
  targetWinId: string | null;
}

interface Win {
  paneId: string;
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  onResizeDispose: () => void;
  onDataDispose: () => void;
  alive: boolean;
}

interface Session {
  id: string;
  name: string;
  windows: Win[];
  layout: LayoutNode | null;
  activeWinId: string | null;
  folder: string | null;
}

interface PersistedSession {
  id: string;
  name: string;
  folder: string | null;
  activePaneId: string | null;
  layout: LayoutNode | null;
}

interface PersistedState {
  version: 1;
  activeSessionId: string | null;
  sessions: PersistedSession[];
}

const sessionName = (i: number) => `Session ${i + 1}`;
const dragStartDistance = 5;
const saveDebounceMs = 500;
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const FONT_SIZE_STORAGE_KEY = "wraith:font-size";
const AGENT_DONE_MARKER = "__WRAITH_AGENT_DONE__";
const AGENT_TOAST_MS = 5000;
const AGENT_BLINK_MS = 3000;
const CONFETTI_PIECES = 28;
const CONFETTI_COLORS = [
  "#ffeb00",
  "#ff4d4d",
  "#4ec9b0",
  "#0e639c",
  "#c7a64a",
  "#b06ddb",
  "#56d364",
  "#ff8c42",
];
let splitSerial = 0;
let paneSerial = 0;
let agentRunSerial = 0;

function createSplitId() {
  splitSerial += 1;
  return `split-${Date.now()}-${splitSerial}`;
}

function createPaneId() {
  paneSerial += 1;
  return `pane-${Date.now()}-${paneSerial}`;
}

function createAgentRunToken() {
  agentRunSerial += 1;
  return `run-${Date.now()}-${agentRunSerial}`;
}

function psSingleQuote(value: string) {
  return value.replace(/'/g, "''");
}

function commandWithAgentFlags(command: string, label: string) {
  const trimmed = command.trim();
  if (
    label === "codex" &&
    /^codex(?:\.exe)?(?:\s|$)/i.test(trimmed) &&
    !/\s--dangerously-bypass-hook-trust(?:\s|$)/.test(trimmed)
  ) {
    return trimmed.replace(
      /^codex(?:\.exe)?/i,
      (match) => `${match} --dangerously-bypass-hook-trust`
    );
  }

  return trimmed;
}

function buildAgentCommand(
  command: string,
  token: string,
  hookUrl: string,
  label: string
) {
  const trimmed = commandWithAgentFlags(command, label);
  const hookEnv =
    `$env:WRAITH_AGENT_HOOK_URL='${psSingleQuote(hookUrl)}'; ` +
    `$env:WRAITH_AGENT_RUN_ID='${psSingleQuote(token)}'; ` +
    `$env:WRAITH_AGENT_LABEL='${psSingleQuote(label)}'; `;
  const markerExpression =
    "[string]::Concat('__WRAITH','_AGENT_DONE__',':','" +
    token +
    "',':',$wraithExitCode)";
  const line =
    "& { " +
    hookEnv +
    "$global:LASTEXITCODE = 0; " +
    trimmed +
    "; $wraithExitCode = if ($LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; Write-Host (" +
    markerExpression +
    ") }";

  return `${line}\r`;
}

function findIncompleteAgentMarkerStart(value: string) {
  const markerStart = value.lastIndexOf(AGENT_DONE_MARKER);
  if (markerStart !== -1 && !/[\r\n]/.test(value.slice(markerStart))) {
    return markerStart;
  }

  const maxPrefix = Math.min(value.length, AGENT_DONE_MARKER.length - 1);
  for (let len = maxPrefix; len > 0; len -= 1) {
    if (value.endsWith(AGENT_DONE_MARKER.slice(0, len))) {
      return value.length - len;
    }
  }

  return -1;
}

function splitAgentCompletionMarkers(input: string): {
  visible: string;
  markers: AgentCompletionMarker[];
  tail: string;
} {
  const markerPattern = /__WRAITH_AGENT_DONE__:([A-Za-z0-9_-]+):(-?\d+)\r?\n?/g;
  const markers: AgentCompletionMarker[] = [];
  let visible = "";
  let cursor = 0;
  let match: RegExpExecArray | null = null;

  while ((match = markerPattern.exec(input)) !== null) {
    visible += input.slice(cursor, match.index);
    markers.push({
      token: match[1],
      exitCode: Number.parseInt(match[2], 10),
    });
    cursor = match.index + match[0].length;
  }

  const remainder = input.slice(cursor);
  const incompleteStart = findIncompleteAgentMarkerStart(remainder);
  if (incompleteStart === -1) {
    return { visible: visible + remainder, markers, tail: "" };
  }

  return {
    visible: visible + remainder.slice(0, incompleteStart),
    markers,
    tail: remainder.slice(incompleteStart),
  };
}

function processAgentRunOutput(run: AgentRun, data: string) {
  if (run.echoDisplayed || run.echoMatched >= run.echoText.length) {
    return data;
  }

  let index = 0;
  while (index < data.length && run.echoMatched < run.echoText.length) {
    if (data[index] !== run.echoText[run.echoMatched]) {
      const suppressed = run.echoText.slice(0, run.echoMatched);
      run.echoDisplayed = true;
      run.echoMatched = run.echoText.length;
      const rest = data.slice(index);
      return suppressed + rest;
    }
    run.echoMatched += 1;
    index += 1;
  }

  if (run.echoMatched < run.echoText.length) {
    return "";
  }

  run.echoDisplayed = true;
  const rest = data.slice(index);
  return run.command + rest;
}

let completionAudioContext: AudioContext | null = null;

function playAgentCompletionSound(warning: boolean) {
  const audioWindow = window as Window &
    typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    completionAudioContext ??= new AudioContextCtor();
    const ctx = completionAudioContext;
    void ctx.resume().then(() => {
      const notes = warning ? [523.25, 392.0] : [659.25, 987.77];
      notes.forEach((freq, i) => {
        const now = ctx.currentTime + i * 0.13;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.32, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.32);
      });
    });
  } catch {
    // Audio is best-effort; completion still shows a toast and requests attention.
  }
}

function collectPaneIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.winId];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

function toPersistedState(
  sessions: Session[],
  activeSessionId: string | null
): PersistedState {
  return {
    version: 1,
    activeSessionId,
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      folder: s.folder,
      activePaneId: s.activeWinId,
      layout: s.layout,
    })),
  };
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.type === "leaf") return typeof node.winId === "string";
  if (node.type === "split") {
    return (
      typeof node.id === "string" &&
      (node.dir === "row" || node.dir === "column") &&
      typeof node.ratio === "number" &&
      isLayoutNode(node.first) &&
      isLayoutNode(node.second)
    );
  }
  return false;
}

function validatePersistedState(data: unknown): PersistedState | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) return null;

  const sessions: PersistedSession[] = [];
  for (const item of raw.sessions) {
    if (!item || typeof item !== "object") return null;
    const session = item as Record<string, unknown>;
    if (typeof session.id !== "string" || typeof session.name !== "string") {
      return null;
    }
    if (session.folder !== null && typeof session.folder !== "string") {
      return null;
    }
    if (
      session.activePaneId !== null &&
      typeof session.activePaneId !== "string"
    ) {
      return null;
    }
    if (session.layout !== null && !isLayoutNode(session.layout)) return null;

    const paneIds = collectPaneIds(session.layout as LayoutNode | null);
    if (paneIds.length === 0) return null;
    const unique = new Set(paneIds);
    if (unique.size !== paneIds.length) return null;
    if (
      session.activePaneId &&
      !unique.has(session.activePaneId as string)
    ) {
      return null;
    }

    sessions.push({
      id: session.id,
      name: session.name,
      folder: session.folder as string | null,
      activePaneId: session.activePaneId as string | null,
      layout: session.layout as LayoutNode | null,
    });
  }

  let activeSessionId: string | null = null;
  if (raw.activeSessionId !== null && typeof raw.activeSessionId !== "string") {
    return null;
  }
  if (typeof raw.activeSessionId === "string") {
    activeSessionId = raw.activeSessionId;
  }
  if (
    activeSessionId &&
    !sessions.some((session) => session.id === activeSessionId)
  ) {
    activeSessionId = sessions[sessions.length - 1]?.id ?? null;
  }

  return { version: 1, activeSessionId, sessions };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampFontSize(size: number) {
  return clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE);
}

function loadStoredFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_FONT_SIZE;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_FONT_SIZE;
    return clampFontSize(parsed);
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

function storeFontSize(size: number) {
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(size));
  } catch {
    // ignore
  }
}

function applyTerminalFontSize(win: Win, size: number) {
  try {
    win.term.options.fontSize = size;
    win.term.clearTextureAtlas();
    fitAndRefresh(win);
  } catch {
    // ignore
  }
}

function firstLeafId(node: LayoutNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") return node.winId;
  return firstLeafId(node.first) ?? firstLeafId(node.second);
}

function insertWindow(
  node: LayoutNode,
  targetWinId: string,
  newWinId: string,
  dir: SplitDir
): LayoutNode {
  if (node.type === "leaf") {
    if (node.winId !== targetWinId) return node;

    return {
      type: "split",
      id: createSplitId(),
      dir,
      ratio: 0.5,
      first: { type: "leaf", winId: targetWinId },
      second: { type: "leaf", winId: newWinId },
    };
  }

  return {
    ...node,
    first: insertWindow(node.first, targetWinId, newWinId, dir),
    second: insertWindow(node.second, targetWinId, newWinId, dir),
  };
}

function removeWindow(node: LayoutNode | null, winId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === "leaf") return node.winId === winId ? null : node;

  const first = removeWindow(node.first, winId);
  const second = removeWindow(node.second, winId);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;

  return { ...node, first, second };
}

function swapWindowIds(
  node: LayoutNode,
  firstWinId: string,
  secondWinId: string
): LayoutNode {
  if (node.type === "leaf") {
    if (node.winId === firstWinId) return { ...node, winId: secondWinId };
    if (node.winId === secondWinId) return { ...node, winId: firstWinId };
    return node;
  }

  return {
    ...node,
    first: swapWindowIds(node.first, firstWinId, secondWinId),
    second: swapWindowIds(node.second, firstWinId, secondWinId),
  };
}

function adjustSplitRatio(
  node: LayoutNode,
  splitId: string,
  deltaRatio: number
): LayoutNode {
  if (node.type === "leaf") return node;

  if (node.id === splitId) {
    return { ...node, ratio: clamp(node.ratio + deltaRatio, 0.15, 0.85) };
  }

  return {
    ...node,
    first: adjustSplitRatio(node.first, splitId, deltaRatio),
    second: adjustSplitRatio(node.second, splitId, deltaRatio),
  };
}

function findLeafRect(
  node: LayoutNode,
  winId: string,
  rect: LayoutRect
): LayoutRect | null {
  if (node.type === "leaf") return node.winId === winId ? rect : null;

  if (node.dir === "row") {
    const firstWidth = rect.width * node.ratio;
    return (
      findLeafRect(node.first, winId, {
        ...rect,
        width: firstWidth,
      }) ??
      findLeafRect(node.second, winId, {
        x: rect.x + firstWidth,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height,
      })
    );
  }

  const firstHeight = rect.height * node.ratio;
  return (
    findLeafRect(node.first, winId, {
      ...rect,
      height: firstHeight,
    }) ??
    findLeafRect(node.second, winId, {
      x: rect.x,
      y: rect.y + firstHeight,
      width: rect.width,
      height: rect.height - firstHeight,
    })
  );
}

function layoutSignature(node: LayoutNode | null): string {
  if (!node) return "";
  if (node.type === "leaf") return node.winId;
  return `${node.id}:${node.dir}:${node.ratio.toFixed(3)}(${layoutSignature(
    node.first
  )}|${layoutSignature(node.second)})`;
}

const scheduledFitFrames = new Map<string, number>();
const syncedPtySize = new Map<string, { cols: number; rows: number }>();

function clearSyncedPtySize(ptyId: string) {
  syncedPtySize.delete(ptyId);
}

function syncPtySizeForId(ptyId: string, cols: number, rows: number) {
  if (cols <= 0 || rows <= 0) return;
  const prev = syncedPtySize.get(ptyId);
  if (prev?.cols === cols && prev?.rows === rows) return;
  syncedPtySize.set(ptyId, { cols, rows });
  void invoke("resize_powershell", { id: ptyId, cols, rows });
}

function syncPtySize(win: Win) {
  syncPtySizeForId(win.id, win.term.cols, win.term.rows);
}

function fitAndRefresh(win: Win) {
  try {
    win.fitAddon.fit();
    syncPtySize(win);
    const rows = win.term.rows;
    if (rows <= 0) return;
    // FitAddon skips redraw when cols/rows are unchanged; force it anyway.
    win.term.refresh(0, rows - 1);
  } catch {
    // ignore
  }
}

function scheduleFitAndRefresh(win: Win) {
  const prev = scheduledFitFrames.get(win.paneId);
  if (prev !== undefined) window.cancelAnimationFrame(prev);
  const frame = window.requestAnimationFrame(() => {
    scheduledFitFrames.delete(win.paneId);
    fitAndRefresh(win);
  });
  scheduledFitFrames.set(win.paneId, frame);
}

function cancelScheduledFit(paneId: string) {
  const frame = scheduledFitFrames.get(paneId);
  if (frame !== undefined) {
    window.cancelAnimationFrame(frame);
    scheduledFitFrames.delete(paneId);
  }
}

function attachPtyListeners(
  ptyId: string,
  term: Terminal,
  onInput?: (ptyId: string, input: string) => void
) {
  const onResize = term.onResize(({ cols, rows }) => {
    syncPtySizeForId(ptyId, cols, rows);
  });
  const onData = term.onData((d) => {
    // ConPTY expects CR; LF alone triggers PowerShell's >> continuation prompt.
    const input = d.replace(/\n/g, "\r");
    onInput?.(ptyId, input);
    void invoke("write_powershell", { id: ptyId, input });
  });
  return {
    onResizeDispose: onResize.dispose,
    onDataDispose: onData.dispose,
  };
}

function Confetti() {
  const pieces = useMemo(() => {
    const out: {
      left: number;
      delay: number;
      duration: number;
      drift: number;
      rotate: number;
      color: string;
      size: number;
      shape: "square" | "circle" | "strip";
    }[] = [];
    for (let i = 0; i < CONFETTI_PIECES; i += 1) {
      const size = 6 + Math.floor(Math.random() * 6);
      const shapeRand = Math.random();
      const shape: "square" | "circle" | "strip" =
        shapeRand < 0.5 ? "square" : shapeRand < 0.8 ? "circle" : "strip";
      out.push({
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        duration: 1.6 + Math.random() * 1.4,
        drift: (Math.random() - 0.5) * 120,
        rotate: Math.random() * 360,
        color:
          CONFETTI_COLORS[
            Math.floor(Math.random() * CONFETTI_COLORS.length)
          ],
        size,
        shape,
      });
    }
    return out;
  }, []);

  return (
    <div className="confetti-layer" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`confetti-piece confetti-${p.shape}`}
          style={{
            left: `${p.left}%`,
            width: p.shape === "strip" ? 4 : p.size,
            height: p.shape === "strip" ? p.size * 1.8 : p.size,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            ["--confetti-drift" as string]: `${p.drift}px`,
            ["--confetti-rotate" as string]: `${p.rotate}deg`,
          }}
        />
      ))}
    </div>
  );
}

function TermContainer({ win }: { win: Win }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (win.term.element) {
      if (win.term.element.parentElement !== container) {
        container.appendChild(win.term.element);
      }
    } else {
      win.term.open(container);
    }

    let frameId = 0;
    let passes = 0;
    const settleFit = () => {
      const ready =
        container.clientWidth > 0 && container.clientHeight > 0;
      if (ready) {
        fitAndRefresh(win);
        passes += 1;
      }
      if (!ready || passes < 4) {
        frameId = window.requestAnimationFrame(settleFit);
      }
    };
    frameId = window.requestAnimationFrame(settleFit);

    return () => window.cancelAnimationFrame(frameId);
  }, [win]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => scheduleFitAndRefresh(win));
    ro.observe(container);
    return () => ro.disconnect();
  }, [win]);

  return <div className="term-container" ref={containerRef} />;
}

function TilingDivider({
  dir,
  onResize,
}: {
  dir: SplitDir;
  onResize: (deltaRatio: number) => void;
}) {
  const startRef = useRef<number | null>(null);
  const sizeRef = useRef(1);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const parent = e.currentTarget.parentElement;
    const rect = parent?.getBoundingClientRect();
    startRef.current = dir === "row" ? e.clientX : e.clientY;
    sizeRef.current = Math.max(
      1,
      dir === "row" ? rect?.width ?? 1 : rect?.height ?? 1
    );

    const onMove = (ev: PointerEvent) => {
      if (startRef.current === null) return;
      const current = dir === "row" ? ev.clientX : ev.clientY;
      const delta = current - startRef.current;
      startRef.current = current;
      onResize(delta / sizeRef.current);
    };

    const onUp = () => {
      startRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.cursor = dir === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`tiling-divider tiling-divider-${dir}`}
      onPointerDown={onPointerDown}
    />
  );
}

function TiledNode({
  node,
  session,
  activeWinId,
  dragState,
  blinkingPanes,
  onClose,
  onFocus,
  onHeaderPointerDown,
  onResizeSplit,
  onLaunchAi,
}: {
  node: LayoutNode;
  session: Session;
  activeWinId: string | null;
  dragState: PaneDragState | null;
  blinkingPanes: Set<string>;
  onClose: (winId: string) => void;
  onFocus: (winId: string) => void;
  onHeaderPointerDown: (
    winId: string,
    e: React.PointerEvent<HTMLDivElement>
  ) => void;
  onResizeSplit: (splitId: string, deltaRatio: number) => void;
  onLaunchAi: (paneId: string, shortcut: AiShortcut) => void;
}) {
  if (node.type === "leaf") {
    const win = session.windows.find((w) => w.paneId === node.winId);
    if (!win) return null;

    return (
      <div
        data-pane-id={win.paneId}
        className={`pane-cell ${activeWinId === win.paneId ? "active" : ""} ${
          dragState?.winId === win.paneId ? "dragging" : ""
        } ${dragState?.targetWinId === win.paneId ? "drag-target" : ""} ${
          blinkingPanes.has(win.paneId) ? "blinking" : ""
        }`}
        onPointerDownCapture={() => onFocus(win.paneId)}
      >
        <div
          className="pane-header"
          onPointerDown={(e) => onHeaderPointerDown(win.paneId, e)}
        >
          <span className="pane-dot" />
          <span className="pane-label">PS</span>
          <div className="pane-ai-shortcuts">
            {AI_SHORTCUTS.map((sc) => (
              <button
                key={sc.label}
                className="pane-ai-btn"
                title={sc.label}
                onClick={(e) => {
                  e.stopPropagation();
                  onLaunchAi(win.paneId, sc);
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {sc.icon ? (
                  <img src={sc.icon} alt={sc.label} className="pane-ai-icon" />
                ) : (
                  <span className="pane-ai-badge">{sc.badge}</span>
                )}
              </button>
            ))}
          </div>
          <button
            className="pane-close"
            title="Close pane"
            onClick={(e) => {
              e.stopPropagation();
              onClose(win.paneId);
            }}
          >
            ×
          </button>
        </div>
        <div className="pane-term">
          <TermContainer win={win} />
        </div>
        {blinkingPanes.has(win.paneId) && <Confetti />}
      </div>
    );
  }

  return (
    <div className={`tile-split tile-split-${node.dir}`}>
      <div className="tile-child" style={{ flexGrow: node.ratio }}>
        <TiledNode
          node={node.first}
          session={session}
          activeWinId={activeWinId}
          dragState={dragState}
          blinkingPanes={blinkingPanes}
          onClose={onClose}
          onFocus={onFocus}
          onHeaderPointerDown={onHeaderPointerDown}
          onResizeSplit={onResizeSplit}
          onLaunchAi={onLaunchAi}
        />
      </div>
      <TilingDivider
        dir={node.dir}
        onResize={(deltaRatio) => onResizeSplit(node.id, deltaRatio)}
      />
      <div className="tile-child" style={{ flexGrow: 1 - node.ratio }}>
        <TiledNode
          node={node.second}
          session={session}
          activeWinId={activeWinId}
          dragState={dragState}
          blinkingPanes={blinkingPanes}
          onClose={onClose}
          onFocus={onFocus}
          onHeaderPointerDown={onHeaderPointerDown}
          onResizeSplit={onResizeSplit}
          onLaunchAi={onLaunchAi}
        />
      </div>
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDragState | null>(null);
  const [ptyListenersReady, setPtyListenersReady] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null
  );
  const [renameDraft, setRenameDraft] = useState("");
  const [fontSize, setFontSize] = useState<number>(loadStoredFontSize);
  const [agentToasts, setAgentToasts] = useState<AgentToast[]>([]);
  const [blinkingPanes, setBlinkingPanes] = useState<Set<string>>(new Set());

  const sessionsRef = useRef<Session[]>([]);
  const activeSessionRef = useRef<string | null>(null);
  const initRef = useRef(false);
  const restoringRef = useRef(false);
  const closingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paneDragRef = useRef<PaneDragSession | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const pendingExitRef = useRef<Set<string>>(new Set());
  const intentionalKillRef = useRef<Set<string>>(new Set());
  const restartingPanesRef = useRef<Set<string>>(new Set());
  const agentRunsRef = useRef<Map<string, AgentRun>>(new Map());
  const markerTailRef = useRef<Map<string, string>>(new Map());
  const agentHookUrlRef = useRef<string | null>(null);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const blinkTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const handlePtyExitRef = useRef<(ptyId: string) => void>(() => {});
  const fontSizeRef = useRef<number>(fontSize);

  sessionsRef.current = sessions;
  activeSessionRef.current = activeSessionId;
  fontSizeRef.current = fontSize;

  useEffect(() => {
    let cancelled = false;

    void invoke<string>("agent_hook_url")
      .then((url) => {
        if (!cancelled) agentHookUrlRef.current = url;
      })
      .catch((error) => {
        console.warn("Agent hook server is unavailable", error);
      });

    void invoke("ensure_agent_hooks").catch((error) => {
      console.warn("Agent hook installation failed", error);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const dismissAgentToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimersRef.current.delete(id);
    setAgentToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showAgentToast = useCallback((toast: AgentToast) => {
    setAgentToasts((prev) => [...prev, toast].slice(-4));

    const existing = toastTimersRef.current.get(toast.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      toastTimersRef.current.delete(toast.id);
      setAgentToasts((prev) => prev.filter((item) => item.id !== toast.id));
    }, AGENT_TOAST_MS);
    toastTimersRef.current.set(toast.id, timer);
  }, []);

  const stopBlinkingPane = useCallback((paneId: string) => {
    const timer = blinkTimersRef.current.get(paneId);
    if (timer) {
      clearTimeout(timer);
      blinkTimersRef.current.delete(paneId);
    }
    setBlinkingPanes((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
  }, []);

  const startBlinkingPane = useCallback((paneId: string) => {
    setBlinkingPanes((prev) =>
      prev.has(paneId) ? prev : new Set(prev).add(paneId)
    );

    const existing = blinkTimersRef.current.get(paneId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      blinkTimersRef.current.delete(paneId);
      setBlinkingPanes((prev) => {
        if (!prev.has(paneId)) return prev;
        const next = new Set(prev);
        next.delete(paneId);
        return next;
      });
    }, AGENT_BLINK_MS);
    blinkTimersRef.current.set(paneId, timer);
  }, []);

  const notifyAgentFinished = useCallback(
    (run: AgentRun, exitCode: number) => {
      const warning = exitCode !== 0;
      showAgentToast({
        id: `${run.token}-${Date.now()}`,
        label: run.label,
        sessionName: run.sessionName,
        exitCode,
        status: warning ? "warning" : "success",
      });
      playAgentCompletionSound(warning);
      startBlinkingPane(run.paneId);
      void getCurrentWindow()
        .requestUserAttention(UserAttentionType.Informational)
        .catch(() => undefined);
    },
    [showAgentToast, startBlinkingPane]
  );

  const clearAgentTracking = useCallback((ptyId: string) => {
    agentRunsRef.current.delete(ptyId);
    markerTailRef.current.delete(ptyId);
  }, []);

  const completeAgentRun = useCallback(
    (ptyId: string, exitCode: number, removeRun = false) => {
      const run = agentRunsRef.current.get(ptyId);
      if (!run) return;

      if (!run.notified) {
        run.notified = true;
        run.armed = false;
        notifyAgentFinished(run, exitCode);
      }

      if (removeRun) {
        clearAgentTracking(ptyId);
      }
    },
    [clearAgentTracking, notifyAgentFinished]
  );

  const completeAgentRunByToken = useCallback(
    (token: string, exitCode = 0) => {
      for (const [ptyId, run] of agentRunsRef.current) {
        if (run.token !== token) continue;
        if (!run.armed || run.notified) return;
        completeAgentRun(ptyId, exitCode);
        return;
      }
    },
    [completeAgentRun]
  );

  const clearPtyTransientState = useCallback(
    (ptyId: string) => {
      pendingOutputRef.current.delete(ptyId);
      pendingExitRef.current.delete(ptyId);
      clearAgentTracking(ptyId);
    },
    [clearAgentTracking]
  );

  const handleTerminalInput = useCallback(
    (ptyId: string, input: string) => {
      if (!input.includes("\r")) return;

      const run = agentRunsRef.current.get(ptyId);
      if (!run) return;

      run.armed = true;
      run.notified = false;
    },
    []
  );

  const processPtyData = useCallback(
    (ptyId: string, data: string) => {
      const buffered = (markerTailRef.current.get(ptyId) ?? "") + data;
      const parsed = splitAgentCompletionMarkers(buffered);
      if (parsed.tail) markerTailRef.current.set(ptyId, parsed.tail);
      else markerTailRef.current.delete(ptyId);

      let visible = parsed.visible;
      const run = agentRunsRef.current.get(ptyId);
      if (run) {
        visible = processAgentRunOutput(run, visible);
      }

      for (const marker of parsed.markers) {
        const directRun = agentRunsRef.current.get(ptyId);
        if (directRun?.token === marker.token) {
          completeAgentRun(ptyId, marker.exitCode, true);
          continue;
        }

        for (const [runPtyId, pendingRun] of agentRunsRef.current) {
          if (pendingRun.token !== marker.token) continue;
          completeAgentRun(runPtyId, marker.exitCode, true);
          break;
        }
      }

      return visible;
    },
    [completeAgentRun]
  );

  useEffect(() => {
    let disposed = false;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenAgentFinished: UnlistenFn | null = null;

    const findWindow = (id: string) => {
      for (const s of sessionsRef.current) {
        const win = s.windows.find((w) => w.id === id);
        if (win) return win;
      }
      return null;
    };

    void Promise.all([
      listen<PtyOutputPayload>("pty-output", (e) => {
        const data = processPtyData(e.payload.id, e.payload.data);
        if (!data) return;

        const win = findWindow(e.payload.id);
        if (win && win.alive) {
          win.term.write(data);
          return;
        }

        const pending = pendingOutputRef.current.get(e.payload.id) ?? "";
        pendingOutputRef.current.set(e.payload.id, pending + data);
      }),
      listen<string>("pty-exit", (e) => {
        handlePtyExitRef.current(e.payload);
      }),
      listen<AgentHookFinishedPayload>("agent-finished", (e) => {
        completeAgentRunByToken(e.payload.runId);
      }),
    ]).then(([output, exit, agentFinished]) => {
      if (disposed) {
        output();
        exit();
        agentFinished();
        return;
      }

      unlistenOutput = output;
      unlistenExit = exit;
      unlistenAgentFinished = agentFinished;
      setPtyListenersReady(true);
    });

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
      unlistenAgentFinished?.();
    };
  }, [completeAgentRunByToken, processPtyData]);

  const createWin = useCallback(
    async (cwd?: string | null, paneId?: string): Promise<Win> => {
      const id = await invoke<string>("spawn_powershell", { cwd: cwd ?? null });
      const term = new Terminal({
        fontFamily: "Cascadia Code, Consolas, Courier New, monospace",
        fontSize: fontSizeRef.current,
        cursorBlink: true,
        scrollback: 10000,
        windowsPty: { backend: "conpty" },
        theme: {
          background: "#1e1e1e",
          foreground: "#cccccc",
          cursor: "#ffffff",
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      const listeners = attachPtyListeners(id, term, handleTerminalInput);

      return {
        paneId: paneId ?? createPaneId(),
        id,
        term,
        fitAddon,
        onResizeDispose: listeners.onResizeDispose,
        onDataDispose: listeners.onDataDispose,
        alive: true,
      };
    },
    [handleTerminalInput]
  );

  const restartWin = useCallback(async (paneId: string) => {
    if (closingRef.current || restartingPanesRef.current.has(paneId)) {
      return;
    }

    let sessionId: string | null = null;
    let winIndex = -1;
    let oldWin: Win | null = null;
    let cwd: string | null = null;

    for (const s of sessionsRef.current) {
      const index = s.windows.findIndex((w) => w.paneId === paneId);
      if (index === -1) continue;
      sessionId = s.id;
      winIndex = index;
      oldWin = s.windows[index];
      cwd = s.folder;
      break;
    }

    if (!sessionId || !oldWin || winIndex === -1) return;

    restartingPanesRef.current.add(paneId);
    try {
      void invoke("kill_powershell", { id: oldWin.id });
      clearSyncedPtySize(oldWin.id);
      clearPtyTransientState(oldWin.id);
      oldWin.onResizeDispose();
      oldWin.onDataDispose();

      const newId = await invoke<string>("spawn_powershell", { cwd });
      const listeners = attachPtyListeners(
        newId,
        oldWin.term,
        handleTerminalInput
      );
      const updatedWin: Win = {
        ...oldWin,
        id: newId,
        onResizeDispose: listeners.onResizeDispose,
        onDataDispose: listeners.onDataDispose,
        alive: true,
      };

      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== sessionId) return session;
          const windows = [...session.windows];
          windows[winIndex] = updatedWin;
          return { ...session, windows };
        })
      );

      scheduleFitAndRefresh(updatedWin);
      updatedWin.term.focus();
    } finally {
      restartingPanesRef.current.delete(paneId);
    }
  }, [clearPtyTransientState, handleTerminalInput]);

  const handlePtyExit = useCallback(
    (ptyId: string) => {
      if (closingRef.current) return;
      clearAgentTracking(ptyId);
      if (intentionalKillRef.current.has(ptyId)) {
        intentionalKillRef.current.delete(ptyId);
        return;
      }

      let paneId: string | null = null;
      for (const s of sessionsRef.current) {
        const win = s.windows.find((w) => w.id === ptyId);
        if (!win) continue;
        paneId = win.paneId;
        if (win.alive) {
          win.term.write("\r\n\x1b[31m[process exited]\x1b[0m\r\n");
          scheduleFitAndRefresh(win);
        }
        break;
      }

      if (paneId) {
        void restartWin(paneId);
      } else {
        pendingExitRef.current.add(ptyId);
      }
    },
    [clearAgentTracking, restartWin]
  );

  handlePtyExitRef.current = handlePtyExit;

  const createSession = useCallback(async (folder?: string | null) => {
    const win = await createWin(folder ?? null);
    const session: Session = {
      id: `sess-${Date.now()}`,
      name: sessionName(sessionsRef.current.length),
      windows: [win],
      layout: { type: "leaf", winId: win.paneId },
      activeWinId: win.paneId,
      folder: folder ?? null,
    };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, [createWin]);

  const createLinkedSession = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    await createSession(selected);
  }, [createSession]);

  const restoreSessions = useCallback(
    async (persisted: PersistedState) => {
      restoringRef.current = true;
      try {
        const restored: Session[] = [];
        for (const persistedSession of persisted.sessions) {
          const paneIds = collectPaneIds(persistedSession.layout);
          const windows: Win[] = [];
          for (const paneId of paneIds) {
            windows.push(
              await createWin(persistedSession.folder, paneId)
            );
          }

          restored.push({
            id: persistedSession.id,
            name: persistedSession.name,
            folder: persistedSession.folder,
            windows,
            layout: persistedSession.layout,
            activeWinId: persistedSession.activePaneId,
          });
        }

        setSessions(restored);
        const activeId = persisted.sessions.some(
          (session) => session.id === persisted.activeSessionId
        )
          ? persisted.activeSessionId
          : restored[restored.length - 1]?.id ?? null;
        setActiveSessionId(activeId);
      } finally {
        restoringRef.current = false;
      }
    },
    [createWin]
  );

  const flushSave = useCallback(() => {
    if (restoringRef.current || sessionsRef.current.length === 0) return;
    const state = toPersistedState(
      sessionsRef.current,
      activeSessionRef.current
    );
    void invoke("save_sessions", { state });
  }, []);

  const setActiveWin = useCallback((winId: string) => {
    const sid = activeSessionRef.current;
    if (!sid) return;

    setSessions((prev) =>
      prev.map((s) => (s.id === sid ? { ...s, activeWinId: winId } : s))
    );
    stopBlinkingPane(winId);
  }, [stopBlinkingPane]);

  const launchAi = useCallback(async (paneId: string, shortcut: AiShortcut) => {
    const session = sessionsRef.current.find((s) =>
      s.windows.some((w) => w.paneId === paneId)
    );
    if (!session) return;
    const win = session.windows.find((w) => w.paneId === paneId);
    if (!win || !win.alive || agentRunsRef.current.has(win.id)) return;

    const hookUrl =
      agentHookUrlRef.current ??
      (await invoke<string>("agent_hook_url").catch(() => null));
    if (!hookUrl) return;
    agentHookUrlRef.current = hookUrl;

    const token = createAgentRunToken();
    const input = buildAgentCommand(
      shortcut.command,
      token,
      hookUrl,
      shortcut.label
    );
    agentRunsRef.current.set(win.id, {
      token,
      label: shortcut.label,
      sessionName: session.name,
      paneId,
      command: shortcut.command,
      echoText: input.replace(/\r$/, ""),
      echoMatched: 0,
      echoDisplayed: false,
      armed: false,
      notified: false,
    });
    stopBlinkingPane(paneId);

    fitAndRefresh(win);
    void invoke("write_powershell", { id: win.id, input }).catch(() => {
      clearAgentTracking(win.id);
    });
    win.term.focus();
  }, [clearAgentTracking, stopBlinkingPane]);

  const applyFontSizeAll = useCallback((size: number) => {
    const next = clampFontSize(size);
    setFontSize(next);
    storeFontSize(next);
    for (const s of sessionsRef.current) {
      for (const w of s.windows) {
        if (w.alive) applyTerminalFontSize(w, next);
      }
    }
  }, []);

  const zoomFontIn = useCallback(() => {
    applyFontSizeAll(fontSizeRef.current + 1);
  }, [applyFontSizeAll]);

  const zoomFontOut = useCallback(() => {
    applyFontSizeAll(fontSizeRef.current - 1);
  }, [applyFontSizeAll]);

  const resetFontSize = useCallback(() => {
    applyFontSizeAll(DEFAULT_FONT_SIZE);
  }, [applyFontSizeAll]);

  const addWindowToActive = useCallback(async () => {
    const sid = activeSessionRef.current;
    if (!sid) return;
    const session = sessionsRef.current.find((s) => s.id === sid);
    if (!session) return;

    const win = await createWin(session.folder);
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s;
        const targetWinId = s.activeWinId ?? firstLeafId(s.layout) ?? win.paneId;
        const activeRect =
          s.layout && targetWinId !== win.paneId
            ? findLeafRect(s.layout, targetWinId, {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
              })
            : null;
        const dir: SplitDir =
          !activeRect || activeRect.width >= activeRect.height
            ? "row"
            : "column";
        const layout = s.layout
          ? insertWindow(s.layout, targetWinId, win.paneId, dir)
          : { type: "leaf" as const, winId: win.paneId };

        return {
          ...s,
          windows: [...s.windows, win],
          layout,
          activeWinId: win.paneId,
        };
      })
    );
  }, [createWin]);

  const closeWindow = useCallback((paneId: string) => {
    stopBlinkingPane(paneId);
    for (const s of sessionsRef.current) {
      const w = s.windows.find((x) => x.paneId === paneId);
      if (!w) continue;
      clearPtyTransientState(w.id);
      cancelScheduledFit(w.paneId);
      intentionalKillRef.current.add(w.id);
      clearSyncedPtySize(w.id);
      void invoke("kill_powershell", { id: w.id });
      w.onResizeDispose();
      w.onDataDispose();
      w.term.dispose();
      setSessions((prev) =>
        prev.map((session) => {
          if (!session.windows.some((x) => x.paneId === paneId)) return session;
          const layout = removeWindow(session.layout, paneId);
          const activeWinId =
            session.activeWinId === paneId
              ? firstLeafId(layout)
              : session.activeWinId;

          return {
            ...session,
            windows: session.windows.filter((x) => x.paneId !== paneId),
            layout,
            activeWinId,
          };
        })
      );
      break;
    }
  }, [clearPtyTransientState, stopBlinkingPane]);

  const closeSession = useCallback((sessionId: string) => {
    const sess = sessionsRef.current.find((s) => s.id === sessionId);
    if (!sess) return;
    for (const w of sess.windows) {
      stopBlinkingPane(w.paneId);
      clearPtyTransientState(w.id);
      cancelScheduledFit(w.paneId);
      intentionalKillRef.current.add(w.id);
      clearSyncedPtySize(w.id);
      void invoke("kill_powershell", { id: w.id });
      w.onResizeDispose();
      w.onDataDispose();
      w.term.dispose();
    }
    const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    if (activeSessionRef.current === sessionId) {
      setActiveSessionId(remaining[remaining.length - 1]?.id ?? null);
    }
  }, [clearPtyTransientState, stopBlinkingPane]);

  const swapPanes = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    const sid = activeSessionRef.current;
    if (!sid) return;

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid || !s.layout) return s;
        return {
          ...s,
          layout: swapWindowIds(s.layout, fromId, toId),
          activeWinId: fromId,
        };
      })
    );
  }, []);

  const commitRename = useCallback(
    (sessionId: string) => {
      const trimmed = renameDraft.trim();
      if (trimmed) {
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, name: trimmed } : s))
        );
      }
      setRenamingSessionId(null);
      setRenameDraft("");
    },
    [renameDraft]
  );

  const cancelRename = useCallback(() => {
    setRenamingSessionId(null);
    setRenameDraft("");
  }, []);

  const beginRename = useCallback((sessionId: string, currentName: string) => {
    setRenamingSessionId(sessionId);
    setRenameDraft(currentName);
  }, []);

  useEffect(() => {
    if (!renamingSessionId) return;
    const frame = window.requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renamingSessionId]);

  const resizeSplit = useCallback((splitId: string, deltaRatio: number) => {
    const sid = activeSessionRef.current;
    if (!sid) return;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid && s.layout
          ? { ...s, layout: adjustSplitRatio(s.layout, splitId, deltaRatio) }
          : s
      )
    );
  }, []);

  const getPaneIdFromPoint = useCallback(
    (clientX: number, clientY: number, draggingId: string) => {
      const element = document.elementFromPoint(clientX, clientY);
      const pane = element?.closest("[data-pane-id]") as HTMLElement | null;
      const paneId = pane?.dataset.paneId ?? null;
      return paneId && paneId !== draggingId ? paneId : null;
    },
    []
  );

  const beginPaneDrag = useCallback(
    (winId: string, e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button")) return;

      e.preventDefault();
      setActiveWin(winId);
      paneDragRef.current = {
        winId,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        targetWinId: null,
      };

      const clearDragStyles = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      const onMove = (ev: PointerEvent) => {
        const current = paneDragRef.current;
        if (!current) return;

        if (!current.active) {
          const distance = Math.hypot(
            ev.clientX - current.startX,
            ev.clientY - current.startY
          );
          if (distance < dragStartDistance) return;
          current.active = true;
        }

        const targetWinId = getPaneIdFromPoint(
          ev.clientX,
          ev.clientY,
          current.winId
        );
        current.targetWinId = targetWinId;
        setPaneDrag({ winId: current.winId, targetWinId });
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        clearDragStyles();
      };

      const onUp = () => {
        const current = paneDragRef.current;
        if (current?.active && current.targetWinId) {
          swapPanes(current.winId, current.targetWinId);
        }
        paneDragRef.current = null;
        setPaneDrag(null);
        cleanup();
      };

      const onCancel = () => {
        paneDragRef.current = null;
        setPaneDrag(null);
        cleanup();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    },
    [getPaneIdFromPoint, setActiveWin, swapPanes]
  );

  useEffect(() => {
    if (initRef.current || !ptyListenersReady) return;
    initRef.current = true;
    void (async () => {
      try {
        const raw = await invoke<unknown | null>("load_sessions");
        const persisted = raw ? validatePersistedState(raw) : null;
        if (persisted) {
          await restoreSessions(persisted);
        } else {
          await createSession();
        }
      } catch {
        await createSession();
      }
    })();
  }, [createSession, ptyListenersReady, restoreSessions]);

  useEffect(() => {
    if (restoringRef.current || !ptyListenersReady || !initRef.current) {
      return;
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      flushSave();
    }, saveDebounceMs);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [sessions, activeSessionId, flushSave, ptyListenersReady]);

  useEffect(() => {
    let unlistenClose: UnlistenFn | null = null;
    let cancelled = false;

    void (async () => {
      const unlisten = await getCurrentWindow().onCloseRequested(async () => {
        if (closingRef.current) return;
        if (restoringRef.current || sessionsRef.current.length === 0) return;

        closingRef.current = true;
        const state = toPersistedState(
          sessionsRef.current,
          activeSessionRef.current
        );
        try {
          await invoke("save_sessions", { state });
        } catch {
          // Still allow the window to close if persistence fails.
        }
        // Do not call preventDefault — Tauri destroys the window when this handler returns.
      });
      if (cancelled) unlisten();
      else unlistenClose = unlisten;
    })();

    return () => {
      cancelled = true;
      unlistenClose?.();
    };
  }, []);

  useEffect(() => {
    for (const s of sessions) {
      for (const w of s.windows) {
        const pending = pendingOutputRef.current.get(w.id);
        if (pending) {
          w.term.write(pending);
          pendingOutputRef.current.delete(w.id);
          scheduleFitAndRefresh(w);
        }

        if (pendingExitRef.current.has(w.id)) {
          pendingExitRef.current.delete(w.id);
          handlePtyExitRef.current(w.id);
        }
      }
    }
  }, [sessions]);

  useEffect(() => {
    return () => {
      flushSave();
      for (const timer of toastTimersRef.current.values()) {
        clearTimeout(timer);
      }
      toastTimersRef.current.clear();
      for (const timer of blinkTimersRef.current.values()) {
        clearTimeout(timer);
      }
      blinkTimersRef.current.clear();
      for (const s of sessionsRef.current) {
        for (const w of s.windows) {
          clearPtyTransientState(w.id);
          cancelScheduledFit(w.paneId);
          intentionalKillRef.current.add(w.id);
          clearSyncedPtySize(w.id);
          w.onResizeDispose();
          w.onDataDispose();
          void invoke("kill_powershell", { id: w.id });
          w.term.dispose();
        }
      }
    };
  }, [clearPtyTransientState, flushSave]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeWindowIds =
    activeSession?.windows.map((w) => w.paneId).join("|") ?? "";
  const activeLayoutSignature = layoutSignature(activeSession?.layout ?? null);
  const hasSessions = activeSession !== undefined;

  useEffect(() => {
    let unlistenResize: (() => void) | null = null;
    void getCurrentWindow()
      .onResized(() => {
        const session = sessionsRef.current.find(
          (s) => s.id === activeSessionRef.current
        );
        if (!session) return;
        for (const w of session.windows) {
          if (w.alive) scheduleFitAndRefresh(w);
        }
      })
      .then((unlisten) => {
        unlistenResize = unlisten;
      });
    return () => {
      unlistenResize?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key;
      if (key === "=" || key === "+") {
        e.preventDefault();
        zoomFontIn();
      } else if (key === "-" || key === "_") {
        e.preventDefault();
        zoomFontOut();
      } else if (key === "0") {
        e.preventDefault();
        resetFontSize();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomFontIn, zoomFontOut, resetFontSize]);

  useEffect(() => {

    const frame = window.requestAnimationFrame(() => {
      const session = sessionsRef.current.find((s) => s.id === activeSessionId);
      if (!session) return;

      for (const w of session.windows) {
        fitAndRefresh(w);
      }
      window.requestAnimationFrame(() => {
        for (const w of session.windows) {
          fitAndRefresh(w);
        }
      });
      const activeWin =
        session.windows.find((w) => w.paneId === session.activeWinId) ??
        session.windows.find((w) => w.alive);
      activeWin?.term.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, activeWindowIds, activeLayoutSignature]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="brand-lockup">
            <img src={appLogo} alt="" className="brand-logo" />
            <span className="brand-title">Wraith</span>
          </div>
          <div className="sidebar-actions">
            <button
              className="new-btn linked"
              title="New linked session"
              onClick={() => void createLinkedSession()}
            >
              📁
            </button>
            <button
              className="new-btn"
              title="New session"
              onClick={() => void createSession()}
            >
              +
            </button>
          </div>
        </header>
        <ul className="session-list">
          {sessions.map((s) => {
            const aliveCount = s.windows.filter((w) => w.alive).length;
            const isRenaming = renamingSessionId === s.id;
            return (
              <li
                key={s.id}
                className={`session-item ${
                  s.id === activeSessionId ? "active" : ""
                }`}
                title={s.folder ?? ""}
                onClick={() => setActiveSessionId(s.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  beginRename(s.id, s.name);
                }}
              >
                <span
                  className={`session-dot ${s.folder ? "linked" : ""}`}
                  title={s.folder ?? ""}
                />
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="session-rename-input"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(s.id);
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="session-name">{s.name}</span>
                )}
                <span className="session-count">{aliveCount}</span>
                <button
                  className="close-btn"
                  title="Close session"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.id);
                  }}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="terminal-pane">
        {hasSessions && (
          <>
            <div className="toolbar">
              <button
                className="tool-btn"
                title="Add pane"
                onClick={() => void addWindowToActive()}
              >
                + Pane
              </button>
              <div className="toolbar-spacer" />
              <div className="font-size-group" title="Terminal text size (Ctrl + / - / 0)">
                <button
                  className="tool-btn font-btn"
                  title="Zoom out (Ctrl + -)"
                  onClick={zoomFontOut}
                >
                  −
                </button>
                <span className="font-size-label">{fontSize}</span>
                <button
                  className="tool-btn font-btn"
                  title="Zoom in (Ctrl + =)"
                  onClick={zoomFontIn}
                >
                  +
                </button>
                <button
                  className="tool-btn font-btn reset"
                  title="Reset size (Ctrl + 0)"
                  onClick={resetFontSize}
                >
                  Reset
                </button>
              </div>
            </div>
            <div className="session-stage">
              {sessions.map((session) => {
                const isActive = session.id === activeSessionId;

                return (
                  <div
                    key={session.id}
                    className={`session-view ${isActive ? "active" : ""}`}
                    aria-hidden={!isActive}
                  >
                    <div className="pane-area">
                      {session.layout ? (
                        <TiledNode
                          node={session.layout}
                          session={session}
                          activeWinId={session.activeWinId}
                          dragState={isActive ? paneDrag : null}
                          blinkingPanes={isActive ? blinkingPanes : new Set()}
                          onClose={closeWindow}
                          onFocus={setActiveWin}
                          onHeaderPointerDown={beginPaneDrag}
                          onResizeSplit={resizeSplit}
                          onLaunchAi={launchAi}
                        />
                      ) : (
                        <div className="empty-pane">
                          <button
                            className="empty-btn"
                            onClick={() => void addWindowToActive()}
                          >
                            Create pane
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {!hasSessions && (
          <div className="empty-pane">
            <button className="empty-btn" onClick={() => void createSession()}>
              Create session
            </button>
            <button
              className="empty-btn"
              onClick={() => void createLinkedSession()}
            >
              Create linked session
            </button>
          </div>
        )}
      </main>

      {agentToasts.length > 0 && (
        <div
          className="agent-toast-stack"
          aria-live="polite"
          aria-atomic="false"
        >
          {agentToasts.map((toast) => {
            const warning = toast.status === "warning";
            return (
              <div key={toast.id} className={`agent-toast ${toast.status}`}>
                <div className="agent-toast-main">
                  <span className="agent-toast-title">
                    {toast.label} finished
                  </span>
                  <span className="agent-toast-meta">
                    {toast.sessionName} - {warning
                      ? `exited with code ${toast.exitCode}`
                      : "ready for review"}
                  </span>
                </div>
                <button
                  className="agent-toast-close"
                  title="Close alert"
                  onClick={() => dismissAgentToast(toast.id)}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default App;
