import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";
import openaiIcon from "./assets/ai-openai.svg";
import claudeIcon from "./assets/ai-claude.svg";
import opencodeIcon from "./assets/ai-opencode.svg";
import appLogo from "./assets/wraith-logo.png";
import { AgentPaneView } from "./agent/AgentPaneView";
import {
  psSingleQuote,
  buildAgentCommand as buildAgentCommandShared,
  createAgentRunToken as createAgentRunTokenShared,
  splitAgentCompletionMarkers as splitAgentCompletionMarkersShared,
} from "./agent/commandMarker";
import type { OrchestratorApi, PaneAgentName } from "./agent/orchestratorTypes";
import { waitForAgentToken, waitForPaneOutput } from "./agent/orchestratorWait";
import type { PaneInfo } from "./agent/tools";
import {
  AppSettingsModal,
  applyTerminalAppearance,
  clampFontSize,
  COLLAPSED_SIDEBAR_WIDTH,
  DEFAULT_FONT_SIZE,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  ensureFontStackReady,
  resolveTerminalTheme,
  SIDEBAR_COLLAPSE_THRESHOLD,
  useAppSettings,
  type AiSettings,
} from "./settings";
import {
  errorMessage,
  formatElapsed,
  loadDictationSettings,
  MAX_DICTATION_MS,
  selectRecorderMimeType,
  transcribeDictationBlob,
  validateDictationSettings,
  type DictationStatus,
} from "./agent/dictation";
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
  kind?: "terminal" | "agent";
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

interface PaneDictationState {
  paneId: string;
  status: DictationStatus;
  seconds: number;
  error: string | null;
  levels: number[];
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

interface SidebarFolder {
  id: string;
  name: string;
  collapsed: boolean;
  sessionIds: string[];
}

interface SidebarSessionItem {
  type: "session";
  id: string;
}

interface SidebarFolderItem {
  type: "folder";
  id: string;
}

type SidebarItem = SidebarSessionItem | SidebarFolderItem;

interface SidebarState {
  folders: SidebarFolder[];
  items: SidebarItem[];
}

interface SidebarDragState {
  kind: "session" | "folder";
  id: string;
  target: SidebarDropTarget | null;
}

interface SidebarPointerDragSession extends SidebarDragState {
  startX: number;
  startY: number;
  active: boolean;
}

type SidebarDropTarget =
  | { type: "top-level"; index: number }
  | { type: "folder"; folderId: string }
  | { type: "folder-content"; folderId: string; index: number };

interface PersistedState {
  version: 2;
  activeSessionId: string | null;
  sessions: PersistedSession[];
  folders: SidebarFolder[];
  sidebarItems: SidebarItem[];
}

const sessionName = (i: number) => `Session ${i + 1}`;
const dragStartDistance = 5;
const saveDebounceMs = 500;
const WINDOW_GEOMETRY_DEBOUNCE_MS = 400;
const AGENT_TOAST_MS = 5000;
const AGENT_BLINK_MS = 3000;
const CONFETTI_PIECES = 28;
const DICTATION_BAR_COUNT = 18;
const DICTATION_IDLE_LEVEL = 0.18;

function dictationLevels(level = DICTATION_IDLE_LEVEL) {
  return Array.from({ length: DICTATION_BAR_COUNT }, () => level);
}

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
let sidebarFolderSerial = 0;

function createSplitId() {
  splitSerial += 1;
  return `split-${Date.now()}-${splitSerial}`;
}

function createPaneId() {
  paneSerial += 1;
  return `pane-${Date.now()}-${paneSerial}`;
}

function createSidebarFolderId() {
  sidebarFolderSerial += 1;
  return `folder-${Date.now()}-${sidebarFolderSerial}`;
}

const createAgentRunToken = () => createAgentRunTokenShared(() => {
  agentRunSerial += 1;
  return agentRunSerial;
});
const buildAgentCommand = buildAgentCommandShared;
const splitAgentCompletionMarkers = splitAgentCompletionMarkersShared;

function buildAgentLaunchCommand(agent: PaneAgentName, task: string): string {
  const shortcut = AI_SHORTCUTS.find((s) => s.label === agent);
  const base = shortcut?.command ?? agent;
  const trimmed = task.trim();
  if (!trimmed) return base;
  return `${base} ${psSingleQuote(trimmed)}`;
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

function stripAgentLeaves(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === "leaf") {
    return node.kind === "agent" ? null : node;
  }
  const first = stripAgentLeaves(node.first);
  const second = stripAgentLeaves(node.second);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function firstTerminalLeafId(node: LayoutNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") {
    return node.kind === "agent" ? null : node.winId;
  }
  return firstTerminalLeafId(node.first) ?? firstTerminalLeafId(node.second);
}

function createFlatSidebarState(sessionIds: string[]): SidebarState {
  return {
    folders: [],
    items: sessionIds.map((id) => ({ type: "session", id })),
  };
}

function normalizeSidebarState(
  sidebar: SidebarState,
  sessionIds: string[]
): SidebarState {
  const knownSessionIds = new Set(sessionIds);
  const assignedSessions = new Set<string>();
  const folderIds = new Set<string>();
  const folders: SidebarFolder[] = [];

  for (const folder of sidebar.folders) {
    if (!folder.id || folderIds.has(folder.id)) continue;
    folderIds.add(folder.id);
    const folderSessionIds: string[] = [];
    for (const sessionId of folder.sessionIds) {
      if (!knownSessionIds.has(sessionId) || assignedSessions.has(sessionId)) continue;
      assignedSessions.add(sessionId);
      folderSessionIds.push(sessionId);
    }
    folders.push({
      id: folder.id,
      name: folder.name,
      collapsed: folder.collapsed,
      sessionIds: folderSessionIds,
    });
  }

  const displayedFolders = new Set<string>();
  const items: SidebarItem[] = [];
  for (const item of sidebar.items) {
    if (item.type === "folder") {
      if (!folderIds.has(item.id) || displayedFolders.has(item.id)) continue;
      displayedFolders.add(item.id);
      items.push(item);
      continue;
    }
    if (!knownSessionIds.has(item.id) || assignedSessions.has(item.id)) continue;
    assignedSessions.add(item.id);
    items.push(item);
  }

  for (const folder of folders) {
    if (!displayedFolders.has(folder.id)) {
      items.push({ type: "folder", id: folder.id });
    }
  }
  for (const sessionId of sessionIds) {
    if (!assignedSessions.has(sessionId)) {
      items.push({ type: "session", id: sessionId });
    }
  }

  return { folders, items };
}

function sidebarDropTargetsEqual(
  first: SidebarDropTarget | null,
  second: SidebarDropTarget | null
) {
  if (first === second) return true;
  if (!first || !second || first.type !== second.type) return false;
  if (first.type === "top-level" && second.type === "top-level") {
    return first.index === second.index;
  }
  if (first.type === "folder" && second.type === "folder") {
    return first.folderId === second.folderId;
  }
  return (
    first.type === "folder-content" &&
    second.type === "folder-content" &&
    first.folderId === second.folderId &&
    first.index === second.index
  );
}

function toPersistedState(
  sessions: Session[],
  activeSessionId: string | null,
  sidebar: SidebarState
): PersistedState {
  const normalizedSidebar = normalizeSidebarState(
    sidebar,
    sessions.map((session) => session.id)
  );
  return {
    version: 2,
    activeSessionId,
    sessions: sessions.map((s) => {
      const layout = stripAgentLeaves(s.layout);
      let activePaneId = s.activeWinId;
      if (activePaneId) {
        const leaf = findLeafById(s.layout, activePaneId);
        if (leaf?.kind === "agent") {
          activePaneId = firstTerminalLeafId(layout);
        }
      }
      if (!activePaneId) activePaneId = firstTerminalLeafId(layout);
      return {
        id: s.id,
        name: s.name,
        folder: s.folder,
        activePaneId,
        layout,
      };
    }),
    folders: normalizedSidebar.folders,
    sidebarItems: normalizedSidebar.items,
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
  if (raw.version !== 1 && raw.version !== 2) return null;
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

  if (raw.version === 1) {
    const sidebar = createFlatSidebarState(sessions.map((session) => session.id));
    return {
      version: 2,
      activeSessionId,
      sessions,
      folders: sidebar.folders,
      sidebarItems: sidebar.items,
    };
  }

  if (!Array.isArray(raw.folders) || !Array.isArray(raw.sidebarItems)) {
    return null;
  }

  const folders: SidebarFolder[] = [];
  for (const item of raw.folders) {
    if (!item || typeof item !== "object") return null;
    const folder = item as Record<string, unknown>;
    if (
      typeof folder.id !== "string" ||
      typeof folder.name !== "string" ||
      typeof folder.collapsed !== "boolean" ||
      !Array.isArray(folder.sessionIds) ||
      !folder.sessionIds.every((id) => typeof id === "string")
    ) {
      return null;
    }
    folders.push({
      id: folder.id,
      name: folder.name,
      collapsed: folder.collapsed,
      sessionIds: folder.sessionIds as string[],
    });
  }

  const sidebarItems: SidebarItem[] = [];
  for (const item of raw.sidebarItems) {
    if (!item || typeof item !== "object") return null;
    const sidebarItem = item as Record<string, unknown>;
    if (
      typeof sidebarItem.id !== "string" ||
      (sidebarItem.type !== "session" && sidebarItem.type !== "folder")
    ) {
      return null;
    }
    sidebarItems.push({
      type: sidebarItem.type,
      id: sidebarItem.id,
    });
  }

  const sidebar = normalizeSidebarState(
    { folders, items: sidebarItems },
    sessions.map((session) => session.id)
  );
  return {
    version: 2,
    activeSessionId,
    sessions,
    folders: sidebar.folders,
    sidebarItems: sidebar.items,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function firstLeafId(node: LayoutNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") return node.winId;
  return firstLeafId(node.first) ?? firstLeafId(node.second);
}

function findLeafById(
  node: LayoutNode | null,
  id: string
): LayoutLeaf | null {
  if (!node) return null;
  if (node.type === "leaf") return node.winId === id ? node : null;
  return findLeafById(node.first, id) ?? findLeafById(node.second, id);
}

function containsLeafId(node: LayoutNode | null, id: string): boolean {
  return findLeafById(node, id) !== null;
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
      first: node,
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
  const firstLeaf = findLeafById(node, firstWinId);
  const secondLeaf = findLeafById(node, secondWinId);
  if (!firstLeaf || !secondLeaf) return node;

  const swapLeaf = (current: LayoutNode): LayoutNode => {
    if (current.type === "leaf") {
      if (current.winId === firstWinId) return { ...secondLeaf };
      if (current.winId === secondWinId) return { ...firstLeaf };
      return current;
    }

    return {
      ...current,
      first: swapLeaf(current.first),
      second: swapLeaf(current.second),
    };
  };

  return swapLeaf(node);
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

function DictationBubble({ state, onCancel }: {
  state: PaneDictationState;
  onCancel: () => void;
}) {
  const active = state.status === "recording";
  const label =
    state.status === "recording"
      ? formatElapsed(state.seconds)
      : state.status === "transcribing"
        ? "transcribing"
        : state.status === "polishing"
          ? "polishing"
          : state.error ?? "dictation";

  return (
    <div className={`dictation-bubble ${state.status}`}>
      <button
        type="button"
        className="dictation-bubble-pill"
        onClick={active ? onCancel : undefined}
        title={active ? "Cancel dictation" : label}
        aria-label={active ? "Cancel dictation" : label}
      >
        <span className="dictation-wave" aria-hidden="true">
          {state.levels.map((level, index) => (
            <span
              key={index}
              className="dictation-wave-bar"
              style={{
                ["--bar-index" as string]: index,
                ["--bar-level" as string]: level,
              }}
            />
          ))}
        </span>
      </button>
      <div className="dictation-bubble-label">{label}</div>
    </div>
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
  dictation,
  onToggleDictation,
  onCancelDictation,
  panesProvider,
  orchestrator,
  aiSettings,
  onOpenAiSettings,
}: {
  node: LayoutNode;
  session: Session;
  activeWinId: string | null;
  dragState: PaneDragState | null;
  blinkingPanes: Set<string>;
  onClose: (paneId: string) => void;
  onFocus: (winId: string) => void;
  onHeaderPointerDown: (
    winId: string,
    e: React.PointerEvent<HTMLDivElement>
  ) => void;
  onResizeSplit: (splitId: string, deltaRatio: number) => void;
  onLaunchAi: (paneId: string, shortcut: AiShortcut) => void;
  dictation: PaneDictationState | null;
  aiSettings: AiSettings;
  onOpenAiSettings: () => void;
  onToggleDictation: (paneId: string) => void;
  onCancelDictation: () => void;
  panesProvider: () => PaneInfo[];
  orchestrator: OrchestratorApi;
}) {
  if (node.type === "leaf") {
    if (node.kind === "agent") {
      return (
        <div
          data-pane-id={node.winId}
          className={`pane-cell pane-cell-agent ${
            activeWinId === node.winId ? "active" : ""
          } ${dragState?.winId === node.winId ? "dragging" : ""} ${
            dragState?.targetWinId === node.winId ? "drag-target" : ""
          }`}
          onPointerDownCapture={() => onFocus(node.winId)}
        >
          <div
            className="pane-header pane-header-agent"
            onPointerDown={(e) => onHeaderPointerDown(node.winId, e)}
          >
            <span className="pane-dot agent" />
            <span className="pane-label">AI</span>
            <span className="pane-agent-spacer" />
            <button
              className="pane-close"
              title="Close agent pane"
              onClick={(e) => {
                e.stopPropagation();
                onClose(node.winId);
              }}
            >
              ×
            </button>
          </div>
          <div className="pane-agent-body">
            <AgentPaneView
              sessionName={session.name}
              folder={session.folder}
              panes={panesProvider}
              orchestrator={orchestrator}
              aiSettings={aiSettings}
              onOpenAiSettings={onOpenAiSettings}
            />
          </div>
        </div>
      );
    }

    const win = session.windows.find((w) => w.paneId === node.winId);
    if (!win) return null;
    const paneDictation = dictation?.paneId === win.paneId ? dictation : null;
    const dictationProcessing =
      paneDictation?.status === "transcribing" || paneDictation?.status === "polishing";
    const dictationActiveElsewhere = !!dictation && dictation.paneId !== win.paneId;

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
            <button
              className={`pane-ai-btn pane-dictation-btn ${paneDictation?.status ?? ""}`}
              title={paneDictation?.status === "recording" ? "Stop dictation" : "Dictate into pane"}
              disabled={dictationProcessing || dictationActiveElsewhere}
              onClick={(e) => {
                e.stopPropagation();
                onToggleDictation(win.paneId);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="pane-dictation-glyph" aria-hidden="true">
                {paneDictation?.status === "recording" ? "■" : "🎙"}
              </span>
            </button>
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
        {paneDictation && (
          <DictationBubble state={paneDictation} onCancel={onCancelDictation} />
        )}
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
          dictation={dictation}
          onToggleDictation={onToggleDictation}
          onCancelDictation={onCancelDictation}
          panesProvider={panesProvider}
          orchestrator={orchestrator}
          aiSettings={aiSettings}
          onOpenAiSettings={onOpenAiSettings}
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
          dictation={dictation}
          onToggleDictation={onToggleDictation}
          onCancelDictation={onCancelDictation}
          panesProvider={panesProvider}
          orchestrator={orchestrator}
          aiSettings={aiSettings}
          onOpenAiSettings={onOpenAiSettings}
        />
      </div>
    </div>
  );
}

function App() {
  const appSettings = useAppSettings();
  const {
    settings,
    settingsRef,
    ready: settingsReady,
    settingsOpen,
    openSettings,
    setFontSize: setSettingsFontSize,
    setSidebarCollapsed,
    setSidebarLayout,
    setWindowGeometry,
    flushPersist: flushSettingsPersist,
  } = appSettings;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [sidebar, setSidebar] = useState<SidebarState>({
    folders: [],
    items: [],
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDragState | null>(null);
  const [sidebarDrag, setSidebarDrag] = useState<SidebarDragState | null>(null);
  const [ptyListenersReady, setPtyListenersReady] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null
  );
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [agentToasts, setAgentToasts] = useState<AgentToast[]>([]);
  const [blinkingPanes, setBlinkingPanes] = useState<Set<string>>(new Set());
  const [paneDictation, setPaneDictation] = useState<PaneDictationState | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  /** Live width while dragging (null = use settings). */
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
    wasCollapsed: boolean;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);

  const sessionsRef = useRef<Session[]>([]);
  const sidebarRef = useRef<SidebarState>(sidebar);
  const activeSessionRef = useRef<string | null>(null);
  const initRef = useRef(false);
  const windowGeometryRestoredRef = useRef(false);
  const windowGeometryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const restoringRef = useRef(false);
  const closingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paneDragRef = useRef<PaneDragSession | null>(null);
  const sidebarDragRef = useRef<SidebarDragState | null>(null);
  const sidebarPointerDragRef = useRef<SidebarPointerDragSession | null>(null);
  const sidebarSuppressClickRef = useRef(false);
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
  const paneDictationRecorderRef = useRef<MediaRecorder | null>(null);
  const paneDictationStreamRef = useRef<MediaStream | null>(null);
  const paneDictationChunksRef = useRef<Blob[]>([]);
  const paneDictationCanceledRef = useRef(false);
  const paneDictationTimerRef = useRef<number | null>(null);
  const paneDictationMaxTimerRef = useRef<number | null>(null);
  const paneDictationPaneIdRef = useRef<string | null>(null);
  const paneDictationAudioContextRef = useRef<AudioContext | null>(null);
  const paneDictationAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const paneDictationAnalyserRef = useRef<AnalyserNode | null>(null);
  const paneDictationLevelFrameRef = useRef<number | null>(null);
  const paneDictationLevelDataRef = useRef<Uint8Array | null>(null);
  const handlePtyExitRef = useRef<(ptyId: string) => void>(() => {});

  sessionsRef.current = sessions;
  sidebarRef.current = sidebar;
  activeSessionRef.current = activeSessionId;

  const fontSize = settings.terminal.fontSize;
  const sidebarCollapsed =
    sidebarDragWidth !== null
      ? sidebarDragWidth <= SIDEBAR_COLLAPSE_THRESHOLD
      : settings.general.sidebarCollapsed;
  const sidebarWidthPx = (() => {
    if (sidebarDragWidth !== null) {
      return sidebarCollapsed
        ? COLLAPSED_SIDEBAR_WIDTH
        : clamp(sidebarDragWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    }
    return sidebarCollapsed
      ? COLLAPSED_SIDEBAR_WIDTH
      : clamp(settings.general.sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
  })();

  const beginSidebarResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startWidth = settingsRef.current.general.sidebarCollapsed
        ? COLLAPSED_SIDEBAR_WIDTH
        : settingsRef.current.general.sidebarWidth;
      sidebarResizeRef.current = {
        startX: event.clientX,
        startWidth,
        wasCollapsed: settingsRef.current.general.sidebarCollapsed,
      };
      setSidebarResizing(true);
      setSidebarDragWidth(startWidth);
      setHeaderMenuOpen(false);

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      const onMove = (e: PointerEvent) => {
        const drag = sidebarResizeRef.current;
        if (!drag) return;
        const next = drag.startWidth + (e.clientX - drag.startX);
        setSidebarDragWidth(next);
      };

      const onUp = (e: PointerEvent) => {
        const drag = sidebarResizeRef.current;
        sidebarResizeRef.current = null;
        setSidebarResizing(false);
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        if (!drag) {
          setSidebarDragWidth(null);
          return;
        }
        const raw = drag.startWidth + (e.clientX - drag.startX);
        if (raw < SIDEBAR_COLLAPSE_THRESHOLD) {
          // Keep last expanded width so reopening restores size.
          setSidebarLayout({ collapsed: true });
        } else {
          const width = clamp(Math.round(raw), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
          setSidebarLayout({ collapsed: false, width });
        }
        setSidebarDragWidth(null);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [setSidebarLayout, settingsRef]
  );

  const requestConfirm = useCallback((title: string, message: string) => {
    return new Promise<boolean>((resolve) => {
      // Resolve any previous pending confirm as cancelled.
      confirmResolverRef.current?.(false);
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message });
    });
  }, []);

  const resolveConfirm = useCallback((ok: boolean) => {
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    resolve?.(ok);
  }, []);

  // Escape cancels the in-app confirm dialog.
  useEffect(() => {
    if (!confirmDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        resolveConfirm(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirmDialog, resolveConfirm]);

  useEffect(() => {
    if (!headerMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = headerMenuRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        setHeaderMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeaderMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [headerMenuOpen]);

  const collectAliveWindows = useCallback((): Win[] => {
    const wins: Win[] = [];
    for (const s of sessionsRef.current) {
      for (const w of s.windows) {
        if (w.alive) wins.push(w);
      }
    }
    return wins;
  }, []);

  const applyAppearanceToAll = useCallback(() => {
    const s = settingsRef.current;
    const opts = {
      themeId: s.appearance.theme,
      fontFamily: s.terminal.fontFamily,
      fontSize: s.terminal.fontSize,
      colorMode: s.terminal.colorMode,
      colors: s.terminal.colors,
    };
    for (const w of collectAliveWindows()) {
      applyTerminalAppearance(w, opts, (win) => fitAndRefresh(win as Win));
    }
  }, [collectAliveWindows, settingsRef]);

  // Live-update terminals when theme / font / colors change.
  useEffect(() => {
    if (!settingsReady) return;
    applyAppearanceToAll();
  }, [
    settingsReady,
    settings.appearance.theme,
    settings.terminal.fontFamily,
    settings.terminal.fontSize,
    settings.terminal.colorMode,
    settings.terminal.colors.foreground,
    settings.terminal.colors.background,
    settings.terminal.colors.cursor,
    settings.terminal.colors.selectionBackground,
    applyAppearanceToAll,
  ]);

  const findWinByPaneId = useCallback((paneId: string): Win | null => {
    for (const session of sessionsRef.current) {
      const win = session.windows.find((candidate) => candidate.paneId === paneId);
      if (win) return win;
    }
    return null;
  }, []);

  const clearPaneDictationTimers = useCallback(() => {
    if (paneDictationTimerRef.current !== null) {
      window.clearInterval(paneDictationTimerRef.current);
      paneDictationTimerRef.current = null;
    }
    if (paneDictationMaxTimerRef.current !== null) {
      window.clearTimeout(paneDictationMaxTimerRef.current);
      paneDictationMaxTimerRef.current = null;
    }
  }, []);

  const stopPaneDictationTracks = useCallback(() => {
    paneDictationStreamRef.current?.getTracks().forEach((track) => track.stop());
    paneDictationStreamRef.current = null;
  }, []);

  const stopPaneDictationLevelMeter = useCallback(() => {
    if (paneDictationLevelFrameRef.current !== null) {
      window.cancelAnimationFrame(paneDictationLevelFrameRef.current);
      paneDictationLevelFrameRef.current = null;
    }
    paneDictationLevelDataRef.current = null;
    paneDictationAudioSourceRef.current?.disconnect();
    paneDictationAudioSourceRef.current = null;
    paneDictationAnalyserRef.current?.disconnect();
    paneDictationAnalyserRef.current = null;
    const ctx = paneDictationAudioContextRef.current;
    paneDictationAudioContextRef.current = null;
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => undefined);
    }
  }, []);

  const startPaneDictationLevelMeter = useCallback(
    (stream: MediaStream, paneId: string) => {
      stopPaneDictationLevelMeter();
      const audioWindow = window as Window &
        typeof globalThis & { webkitAudioContext?: typeof AudioContext };
      const AudioContextCtor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
      if (!AudioContextCtor) return;

      try {
        const ctx = new AudioContextCtor();
        const analyser = ctx.createAnalyser();
        const source = ctx.createMediaStreamSource(stream);
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.68;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        paneDictationAudioContextRef.current = ctx;
        paneDictationAudioSourceRef.current = source;
        paneDictationAnalyserRef.current = analyser;
        paneDictationLevelDataRef.current = data;

        const sample = () => {
          const currentAnalyser = paneDictationAnalyserRef.current;
          const currentData = paneDictationLevelDataRef.current;
          if (!currentAnalyser || !currentData) return;
          currentAnalyser.getByteFrequencyData(currentData);

          const levels = Array.from({ length: DICTATION_BAR_COUNT }, (_, index) => {
            const start = Math.floor((index / DICTATION_BAR_COUNT) * currentData.length);
            const end = Math.max(
              start + 1,
              Math.floor(((index + 1) / DICTATION_BAR_COUNT) * currentData.length)
            );
            let sum = 0;
            for (let i = start; i < end; i += 1) sum += currentData[i] ?? 0;
            const average = sum / Math.max(1, end - start);
            return Math.max(0.08, Math.min(1, average / 145));
          });

          setPaneDictation((current) =>
            current?.paneId === paneId && current.status === "recording"
              ? { ...current, levels }
              : current
          );
          paneDictationLevelFrameRef.current = window.requestAnimationFrame(sample);
        };

        void ctx.resume().catch(() => undefined);
        paneDictationLevelFrameRef.current = window.requestAnimationFrame(sample);
      } catch {
        stopPaneDictationLevelMeter();
      }
    },
    [stopPaneDictationLevelMeter]
  );

  const finishPaneDictationRecording = useCallback(() => {
    clearPaneDictationTimers();
    stopPaneDictationLevelMeter();
    stopPaneDictationTracks();
    paneDictationRecorderRef.current = null;
  }, [clearPaneDictationTimers, stopPaneDictationLevelMeter, stopPaneDictationTracks]);

  const clearPaneDictationLater = useCallback((paneId: string) => {
    window.setTimeout(() => {
      setPaneDictation((current) => (current?.paneId === paneId ? null : current));
    }, 3800);
  }, []);

  const writeDictationToPane = useCallback(async (paneId: string, text: string) => {
    const win = findWinByPaneId(paneId);
    const cleaned = text.trim();
    if (!win || !win.alive || !cleaned) return;

    win.term.focus();
    await invoke("write_powershell", { id: win.id, input: cleaned });
  }, [findWinByPaneId]);

  const handlePaneDictationAudio = useCallback(
    async (paneId: string, blob: Blob) => {
      try {
        setPaneDictation({ paneId, status: "transcribing", seconds: 0, error: null, levels: dictationLevels(0.36) });
        const settings = await loadDictationSettings();
        const validationError = validateDictationSettings(settings);
        if (validationError) throw new Error(validationError);
        if (settings.dictationStyle !== "verbatim") {
          setPaneDictation({ paneId, status: "polishing", seconds: 0, error: null, levels: dictationLevels(0.44) });
        }

        const result = await transcribeDictationBlob(settings, blob, "terminal");
        await writeDictationToPane(paneId, result.text);

        if (result.cleanupError) {
          setPaneDictation({
            paneId,
            status: "error",
            seconds: 0,
            error: "Inserted raw transcript",
            levels: dictationLevels(0.14),
          });
          clearPaneDictationLater(paneId);
        } else {
          setPaneDictation((current) => (current?.paneId === paneId ? null : current));
        }
      } catch (err) {
        setPaneDictation({
          paneId,
          status: "error",
          seconds: 0,
          error: errorMessage(err),
          levels: dictationLevels(0.14),
        });
        clearPaneDictationLater(paneId);
      }
    },
    [clearPaneDictationLater, writeDictationToPane]
  );

  const stopPaneDictation = useCallback(() => {
    const recorder = paneDictationRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const paneId = paneDictationPaneIdRef.current;
    if (paneId) {
      setPaneDictation((current) =>
        current?.paneId === paneId ? { ...current, status: "transcribing" } : current
      );
    }
    clearPaneDictationTimers();
    recorder.requestData();
    recorder.stop();
  }, [clearPaneDictationTimers]);

  const cancelPaneDictation = useCallback(() => {
    const recorder = paneDictationRecorderRef.current;
    paneDictationCanceledRef.current = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    finishPaneDictationRecording();
    paneDictationChunksRef.current = [];
    paneDictationPaneIdRef.current = null;
    setPaneDictation(null);
  }, [finishPaneDictationRecording]);

  const startPaneDictation = useCallback(
    async (paneId: string) => {
      const win = findWinByPaneId(paneId);
      if (!win || !win.alive) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setPaneDictation({
          paneId,
          status: "error",
          seconds: 0,
          error: "Microphone recording is not available in this WebView.",
          levels: dictationLevels(0.14),
        });
        clearPaneDictationLater(paneId);
        return;
      }

      try {
        const settings = await loadDictationSettings();
        const validationError = validateDictationSettings(settings);
        if (validationError) throw new Error(validationError);

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const mimeType = selectRecorderMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

        paneDictationStreamRef.current = stream;
        paneDictationRecorderRef.current = recorder;
        paneDictationChunksRef.current = [];
        paneDictationCanceledRef.current = false;
        paneDictationPaneIdRef.current = paneId;

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) paneDictationChunksRef.current.push(event.data);
        };
        recorder.onerror = () => {
          finishPaneDictationRecording();
          setPaneDictation({ paneId, status: "error", seconds: 0, error: "Microphone recording failed.", levels: dictationLevels(0.14) });
          clearPaneDictationLater(paneId);
        };
        recorder.onstop = () => {
          const canceled = paneDictationCanceledRef.current;
          const chunks = paneDictationChunksRef.current;
          const type = recorder.mimeType || mimeType || "audio/webm";
          paneDictationChunksRef.current = [];
          paneDictationPaneIdRef.current = null;
          finishPaneDictationRecording();
          if (canceled) return;
          void handlePaneDictationAudio(paneId, new Blob(chunks, { type }));
        };

        setActiveWin(paneId);
        win.term.focus();
        recorder.start();
        setPaneDictation({ paneId, status: "recording", seconds: 0, error: null, levels: dictationLevels() });
        startPaneDictationLevelMeter(stream, paneId);
        paneDictationTimerRef.current = window.setInterval(() => {
          setPaneDictation((current) =>
            current?.paneId === paneId && current.status === "recording"
              ? { ...current, seconds: current.seconds + 1 }
              : current
          );
        }, 1000);
        paneDictationMaxTimerRef.current = window.setTimeout(stopPaneDictation, MAX_DICTATION_MS);
      } catch (err) {
        finishPaneDictationRecording();
        setPaneDictation({ paneId, status: "error", seconds: 0, error: errorMessage(err), levels: dictationLevels(0.14) });
        clearPaneDictationLater(paneId);
      }
    },
    [
      clearPaneDictationLater,
      findWinByPaneId,
      finishPaneDictationRecording,
      handlePaneDictationAudio,
      startPaneDictationLevelMeter,
      stopPaneDictation,
    ]
  );

  const togglePaneDictation = useCallback(
    (paneId: string) => {
      if (paneDictation?.paneId === paneId && paneDictation.status === "recording") {
        stopPaneDictation();
        return;
      }
      if (paneDictation?.status === "transcribing" || paneDictation?.status === "polishing") return;
      void startPaneDictation(paneId);
    },
    [paneDictation, startPaneDictation, stopPaneDictation]
  );

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
      const s = settingsRef.current;
      const fontFamily = await ensureFontStackReady(s.terminal.fontFamily).catch(
        () => s.terminal.fontFamily
      );
      const term = new Terminal({
        fontFamily,
        fontSize: s.terminal.fontSize,
        cursorBlink: true,
        scrollback: 10000,
        windowsPty: { backend: "conpty" },
        theme: resolveTerminalTheme(
          s.appearance.theme,
          s.terminal.colorMode,
          s.terminal.colors
        ),
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
    [handleTerminalInput, settingsRef]
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
    setSidebar((prev) =>
      normalizeSidebarState(
        {
          ...prev,
          items: [...prev.items, { type: "session", id: session.id }],
        },
        [...sessionsRef.current.map((candidate) => candidate.id), session.id]
      )
    );
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
        setSidebar(
          normalizeSidebarState(
            {
              folders: persisted.folders,
              items: persisted.sidebarItems,
            },
            restored.map((session) => session.id)
          )
        );
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
      activeSessionRef.current,
      sidebarRef.current
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

  const orchestrator = useMemo<OrchestratorApi>(
    () => ({
      listAgentRuns: () => {
        const runs = [];
        for (const [ptyId, run] of agentRunsRef.current) {
          runs.push({
            paneId: run.paneId,
            ptyId,
            label: run.label,
            busy: run.armed && !run.notified,
          });
        }
        return runs;
      },
      launchAgent: async (paneId, agent, task) => {
        const session = sessionsRef.current.find((s) =>
          s.windows.some((w) => w.paneId === paneId)
        );
        if (!session) {
          return { output: "error: pane not found in active sessions", exitCode: 1 };
        }
        const win = session.windows.find((w) => w.paneId === paneId);
        if (!win || !win.alive) {
          return { output: "error: pane is not alive", exitCode: 1 };
        }
        if (agentRunsRef.current.has(win.id)) {
          return {
            output: "error: an agent is already running in this pane; use prompt_pane instead",
            exitCode: 1,
          };
        }

        const hookUrl =
          agentHookUrlRef.current ??
          (await invoke<string>("agent_hook_url").catch(() => null));
        if (!hookUrl) {
          return { output: "error: agent hook server not ready", exitCode: 1 };
        }
        agentHookUrlRef.current = hookUrl;

        const token = createAgentRunToken();
        const command = buildAgentLaunchCommand(agent, task);
        const input = buildAgentCommand(command, token, hookUrl, agent);
        agentRunsRef.current.set(win.id, {
          token,
          label: agent,
          sessionName: session.name,
          paneId,
          command,
          echoText: input.replace(/\r$/, ""),
          echoMatched: 0,
          echoDisplayed: false,
          armed: true,
          notified: false,
        });

        const waitPromise = waitForAgentToken(token);
        try {
          await invoke("write_powershell", { id: win.id, input });
        } catch {
          clearAgentTracking(win.id);
          return { output: "error: failed to write to pane", exitCode: 1 };
        }

        const result = await waitPromise;
        clearAgentTracking(win.id);
        return result;
      },
      promptPane: async (paneId, prompt) => {
        const session = sessionsRef.current.find((s) =>
          s.windows.some((w) => w.paneId === paneId)
        );
        if (!session) {
          return { output: "error: pane not found in active sessions", exitCode: 1 };
        }
        const win = session.windows.find((w) => w.paneId === paneId);
        if (!win || !win.alive) {
          return { output: "error: pane is not alive", exitCode: 1 };
        }

        const trimmed = prompt.trim();
        if (!trimmed) {
          return { output: "error: prompt is empty", exitCode: 1 };
        }

        const input = `${trimmed}\r`;
        const run = agentRunsRef.current.get(win.id);
        const waitPromise = run
          ? waitForAgentToken(run.token)
          : waitForPaneOutput(win.id);

        if (run) {
          run.armed = true;
          run.notified = false;
        }

        try {
          await invoke("write_powershell", { id: win.id, input });
        } catch {
          return { output: "error: failed to write to pane", exitCode: 1 };
        }

        return waitPromise;
      },
    }),
    [clearAgentTracking]
  );

  const applyFontSizeAll = useCallback(
    (size: number) => {
      const next = clampFontSize(size);
      setSettingsFontSize(next);
    },
    [setSettingsFontSize]
  );

  const zoomFontIn = useCallback(() => {
    applyFontSizeAll(settingsRef.current.terminal.fontSize + 1);
  }, [applyFontSizeAll, settingsRef]);

  const zoomFontOut = useCallback(() => {
    applyFontSizeAll(settingsRef.current.terminal.fontSize - 1);
  }, [applyFontSizeAll, settingsRef]);

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

  const addAgentToActive = useCallback(() => {
    const sid = activeSessionRef.current;
    if (!sid) return;
    const session = sessionsRef.current.find((s) => s.id === sid);
    if (!session) return;

    const paneId = createPaneId();
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s;
        const targetWinId = s.activeWinId ?? firstLeafId(s.layout) ?? paneId;
        const activeRect =
          s.layout && targetWinId !== paneId
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
        const agentLeaf: LayoutLeaf = {
          type: "leaf",
          kind: "agent",
          winId: paneId,
        };
        const layout: LayoutNode = s.layout
          ? insertWindow(s.layout, targetWinId, paneId, dir)
          : agentLeaf;

        // Mark the inserted leaf as an agent leaf.
        const markAgent = (n: LayoutNode): LayoutNode => {
          if (n.type === "leaf") {
            return n.winId === paneId ? { ...n, kind: "agent" } : n;
          }
          return { ...n, first: markAgent(n.first), second: markAgent(n.second) };
        };
        const finalLayout = markAgent(layout);

        return {
          ...s,
          layout: finalLayout,
          activeWinId: paneId,
        };
      })
    );
  }, []);

  const closeWindow = useCallback(
    async (paneId: string) => {
      if (settingsRef.current.general.confirmClosePane) {
        const ok = await requestConfirm(
          "Close pane",
          "Close this pane? Any running process will be stopped."
        );
        if (!ok) return;
      }

      stopBlinkingPane(paneId);

      // Agent panes have no Win/PTY; just remove them from the layout.
      let isAgentPane = false;
      for (const s of sessionsRef.current) {
        const leaf = findLeafById(s.layout, paneId);
        if (leaf?.kind === "agent") {
          isAgentPane = true;
          break;
        }
      }
      if (isAgentPane) {
        setSessions((prev) =>
          prev.map((session) => {
            if (!containsLeafId(session.layout, paneId)) return session;
            const layout = removeWindow(session.layout, paneId);
            const activeWinId =
              session.activeWinId === paneId
                ? firstLeafId(layout)
                : session.activeWinId;
            return { ...session, layout, activeWinId };
          })
        );
        return;
      }

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
    },
    [clearPtyTransientState, requestConfirm, settingsRef, stopBlinkingPane]
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      const sess = sessionsRef.current.find((s) => s.id === sessionId);
      if (!sess) return;

      if (settingsRef.current.general.confirmCloseSession) {
        const ok = await requestConfirm(
          "Close session",
          `Close session “${sess.name}”? All panes in this session will be stopped.`
        );
        if (!ok) return;
      }

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
      setSidebar((prev) =>
        normalizeSidebarState(
          {
            folders: prev.folders.map((folder) => ({
              ...folder,
              sessionIds: folder.sessionIds.filter((id) => id !== sessionId),
            })),
            items: prev.items.filter(
              (item) => item.type !== "session" || item.id !== sessionId
            ),
          },
          remaining.map((session) => session.id)
        )
      );
      if (activeSessionRef.current === sessionId) {
        setActiveSessionId(remaining[remaining.length - 1]?.id ?? null);
      }
    },
    [clearPtyTransientState, requestConfirm, settingsRef, stopBlinkingPane]
  );

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
      setRenamingFolderId(null);
      setRenameDraft("");
    },
    [renameDraft]
  );

  const cancelRename = useCallback(() => {
    setRenamingSessionId(null);
    setRenamingFolderId(null);
    setRenameDraft("");
  }, []);

  const beginRename = useCallback((sessionId: string, currentName: string) => {
    setRenamingFolderId(null);
    setRenamingSessionId(sessionId);
    setRenameDraft(currentName);
  }, []);

  const commitFolderRename = useCallback(
    (folderId: string) => {
      const trimmed = renameDraft.trim();
      if (trimmed) {
        setSidebar((prev) => ({
          ...prev,
          folders: prev.folders.map((folder) =>
            folder.id === folderId ? { ...folder, name: trimmed } : folder
          ),
        }));
      }
      setRenamingSessionId(null);
      setRenamingFolderId(null);
      setRenameDraft("");
    },
    [renameDraft]
  );

  const beginFolderRename = useCallback((folderId: string, currentName: string) => {
    setRenamingSessionId(null);
    setRenamingFolderId(folderId);
    setRenameDraft(currentName);
  }, []);

  const createSidebarFolder = useCallback(() => {
    const id = createSidebarFolderId();
    const folder: SidebarFolder = {
      id,
      name: "New folder",
      collapsed: false,
      sessionIds: [],
    };
    setSidebar((prev) =>
      normalizeSidebarState(
        {
          folders: [...prev.folders, folder],
          items: [...prev.items, { type: "folder", id }],
        },
        sessionsRef.current.map((session) => session.id)
      )
    );
    setRenamingSessionId(null);
    setRenamingFolderId(id);
    setRenameDraft(folder.name);
  }, []);

  const toggleSidebarFolder = useCallback((folderId: string) => {
    setSidebar((prev) => ({
      ...prev,
      folders: prev.folders.map((folder) =>
        folder.id === folderId
          ? { ...folder, collapsed: !folder.collapsed }
          : folder
      ),
    }));
  }, []);

  const deleteSidebarFolder = useCallback((folderId: string) => {
    setSidebar((prev) => {
      const folder = prev.folders.find((candidate) => candidate.id === folderId);
      if (!folder) return prev;
      const index = prev.items.findIndex(
        (item) => item.type === "folder" && item.id === folderId
      );
      const items = prev.items.filter(
        (item) => item.type !== "folder" || item.id !== folderId
      );
      items.splice(
        index < 0 ? items.length : index,
        0,
        ...folder.sessionIds.map((id) => ({ type: "session" as const, id }))
      );
      return normalizeSidebarState(
        {
          folders: prev.folders.filter((candidate) => candidate.id !== folderId),
          items,
        },
        sessionsRef.current.map((session) => session.id)
      );
    });
    if (renamingFolderId === folderId) {
      setRenamingFolderId(null);
      setRenameDraft("");
    }
  }, [renamingFolderId]);

  const moveSidebarSession = useCallback(
    (sessionId: string, target: SidebarDropTarget) => {
      setSidebar((prev) => {
        const sourceTopLevelIndex = prev.items.findIndex(
          (item) => item.type === "session" && item.id === sessionId
        );
        const sourceFolder = prev.folders.find((folder) =>
          folder.sessionIds.includes(sessionId)
        );
        const folders = prev.folders.map((folder) => ({
          ...folder,
          sessionIds: folder.sessionIds.filter((id) => id !== sessionId),
        }));
        const items = prev.items.filter(
          (item) => item.type !== "session" || item.id !== sessionId
        );

        if (target.type === "top-level") {
          let index = target.index;
          if (sourceTopLevelIndex >= 0 && sourceTopLevelIndex < index) index -= 1;
          items.splice(clamp(index, 0, items.length), 0, {
            type: "session",
            id: sessionId,
          });
        } else if (target.type === "folder") {
          const folder = folders.find((candidate) => candidate.id === target.folderId);
          if (!folder) return prev;
          folder.sessionIds.push(sessionId);
        } else {
          const folder = folders.find((candidate) => candidate.id === target.folderId);
          if (!folder) return prev;
          let index = target.index;
          const sourceIndex =
            sourceFolder?.id === folder.id
              ? sourceFolder.sessionIds.indexOf(sessionId)
              : -1;
          if (sourceIndex >= 0 && sourceIndex < index) index -= 1;
          folder.sessionIds.splice(clamp(index, 0, folder.sessionIds.length), 0, sessionId);
        }

        return normalizeSidebarState(
          { folders, items },
          sessionsRef.current.map((session) => session.id)
        );
      });
    },
    []
  );

  const moveSidebarFolder = useCallback((folderId: string, targetIndex: number) => {
    setSidebar((prev) => {
      const sourceIndex = prev.items.findIndex(
        (item) => item.type === "folder" && item.id === folderId
      );
      if (sourceIndex < 0) return prev;
      const items = prev.items.filter(
        (item) => item.type !== "folder" || item.id !== folderId
      );
      const index = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      items.splice(clamp(index, 0, items.length), 0, {
        type: "folder",
        id: folderId,
      });
      return { ...prev, items };
    });
  }, []);

  const setCurrentSidebarDrag = useCallback((drag: SidebarDragState | null) => {
    sidebarDragRef.current = drag;
    setSidebarDrag(drag);
  }, []);

  const applySidebarDrop = useCallback(
    (drag: SidebarDragState, target: SidebarDropTarget) => {
      if (drag.kind === "session") {
        moveSidebarSession(drag.id, target);
      } else if (target.type === "top-level") {
        moveSidebarFolder(drag.id, target.index);
      }
    },
    [moveSidebarFolder, moveSidebarSession]
  );

  const getSidebarDropTargetFromPoint = useCallback(
    (
      clientX: number,
      clientY: number,
      drag: SidebarPointerDragSession
    ): SidebarDropTarget | null => {
      const element = document.elementFromPoint(clientX, clientY);
      const dropElement = element?.closest("[data-sidebar-drop]") as HTMLElement | null;
      if (dropElement) {
        const topLevelIndex = Number.parseInt(
          dropElement.dataset.sidebarTopIndex ?? "",
          10
        );
        if (!Number.isFinite(topLevelIndex)) return null;
        const folderId = dropElement.dataset.sidebarFolderId;
        const rect = dropElement.getBoundingClientRect();
        const after = clientY >= rect.top + rect.height / 2;

        if (dropElement.dataset.sidebarDrop === "session") {
          const folderIndex = Number.parseInt(
            dropElement.dataset.sidebarFolderIndex ?? "",
            10
          );
          if (drag.kind === "folder" || !folderId || !Number.isFinite(folderIndex)) {
            return { type: "top-level", index: topLevelIndex + (after ? 1 : 0) };
          }
          return {
            type: "folder-content",
            folderId,
            index: folderIndex + (after ? 1 : 0),
          };
        }

        if (dropElement.dataset.sidebarDrop === "folder") {
          if (!folderId) return null;
          const offset = clientY - rect.top;
          const edge = Math.min(10, rect.height * 0.3);
          if (drag.kind === "folder" || offset <= edge) {
            return { type: "top-level", index: topLevelIndex };
          }
          if (offset >= rect.height - edge) {
            return { type: "top-level", index: topLevelIndex + 1 };
          }
          return { type: "folder", folderId };
        }

        if (dropElement.dataset.sidebarDrop === "folder-content") {
          if (drag.kind === "folder") {
            return { type: "top-level", index: topLevelIndex + 1 };
          }
          const folderIndex = Number.parseInt(
            dropElement.dataset.sidebarFolderIndex ?? "",
            10
          );
          if (!folderId || !Number.isFinite(folderIndex)) return null;
          return { type: "folder-content", folderId, index: folderIndex };
        }
      }

      const list = element?.closest("[data-sidebar-list]") as HTMLElement | null;
      if (!list) return null;
      const itemCount = Number.parseInt(list.dataset.sidebarItemCount ?? "", 10);
      return Number.isFinite(itemCount)
        ? { type: "top-level", index: itemCount }
        : null;
    },
    []
  );

  const beginSidebarPointerDrag = useCallback(
    (
      kind: SidebarDragState["kind"],
      id: string,
      event: React.PointerEvent<HTMLElement>
    ) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, input")) {
        return;
      }

      const drag: SidebarPointerDragSession = {
        kind,
        id,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        target: null,
      };
      sidebarPointerDragRef.current = drag;

      const clearPointerStyles = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        clearPointerStyles();
      };

      const onMove = (moveEvent: PointerEvent) => {
        const current = sidebarPointerDragRef.current;
        if (!current) return;

        if (!current.active) {
          const distance = Math.hypot(
            moveEvent.clientX - current.startX,
            moveEvent.clientY - current.startY
          );
          if (distance < dragStartDistance) return;
          current.active = true;
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }

        const target = getSidebarDropTargetFromPoint(
          moveEvent.clientX,
          moveEvent.clientY,
          current
        );
        current.target = target;
        const currentState = sidebarDragRef.current;
        if (
          !currentState ||
          currentState.kind !== current.kind ||
          currentState.id !== current.id ||
          !sidebarDropTargetsEqual(currentState.target, target)
        ) {
          setCurrentSidebarDrag({
            kind: current.kind,
            id: current.id,
            target,
          });
        }
      };

      const onUp = () => {
        const current = sidebarPointerDragRef.current;
        if (current?.active) {
          if (current.target) {
            applySidebarDrop(current, current.target);
          }
          sidebarSuppressClickRef.current = true;
          window.setTimeout(() => {
            sidebarSuppressClickRef.current = false;
          }, 0);
        }
        sidebarPointerDragRef.current = null;
        setCurrentSidebarDrag(null);
        cleanup();
      };

      const onCancel = () => {
        sidebarPointerDragRef.current = null;
        setCurrentSidebarDrag(null);
        cleanup();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [applySidebarDrop, getSidebarDropTargetFromPoint, setCurrentSidebarDrag]
  );

  useEffect(() => {
    if (!renamingSessionId && !renamingFolderId) return;
    const frame = window.requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renamingFolderId, renamingSessionId]);

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
    if (initRef.current || !ptyListenersReady || !settingsReady) return;
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
  }, [createSession, ptyListenersReady, restoreSessions, settingsReady]);

  // Restore window size/position once settings are ready.
  useEffect(() => {
    if (!settingsReady || windowGeometryRestoredRef.current) return;
    windowGeometryRestoredRef.current = true;
    const geom = settingsRef.current.general.window;
    void (async () => {
      try {
        const win = getCurrentWindow();
        await win.setSize(new LogicalSize(geom.width, geom.height));
        if (geom.x !== null && geom.y !== null) {
          await win.setPosition(new LogicalPosition(geom.x, geom.y));
        }
      } catch {
        // ignore restore failures
      }
    })();
  }, [settingsReady, settingsRef]);

  // Persist window geometry on move/resize.
  useEffect(() => {
    if (!settingsReady) return;
    let unlistenResize: UnlistenFn | null = null;
    let unlistenMove: UnlistenFn | null = null;
    let cancelled = false;

    const captureGeometry = async () => {
      try {
        const win = getCurrentWindow();
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const scale = await win.scaleFactor();
        const width = Math.round(size.width / scale);
        const height = Math.round(size.height / scale);
        const x = Math.round(pos.x / scale);
        const y = Math.round(pos.y / scale);
        if (windowGeometryTimerRef.current) {
          clearTimeout(windowGeometryTimerRef.current);
        }
        windowGeometryTimerRef.current = setTimeout(() => {
          setWindowGeometry({
            width: clamp(width, 400, 10000),
            height: clamp(height, 300, 10000),
            x,
            y,
          });
        }, WINDOW_GEOMETRY_DEBOUNCE_MS);
      } catch {
        // ignore
      }
    };

    void (async () => {
      try {
        const win = getCurrentWindow();
        const offResize = await win.onResized(() => {
          void captureGeometry();
        });
        const offMove = await win.onMoved(() => {
          void captureGeometry();
        });
        if (cancelled) {
          offResize();
          offMove();
        } else {
          unlistenResize = offResize;
          unlistenMove = offMove;
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
      unlistenResize?.();
      unlistenMove?.();
      if (windowGeometryTimerRef.current) {
        clearTimeout(windowGeometryTimerRef.current);
      }
    };
  }, [settingsReady, setWindowGeometry]);

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
  }, [sessions, sidebar, activeSessionId, flushSave, ptyListenersReady]);

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
          activeSessionRef.current,
          sidebarRef.current
        );
        try {
          // Capture latest window geometry before exit.
          try {
            const win = getCurrentWindow();
            const size = await win.innerSize();
            const pos = await win.outerPosition();
            const scale = await win.scaleFactor();
            setWindowGeometry({
              width: clamp(Math.round(size.width / scale), 400, 10000),
              height: clamp(Math.round(size.height / scale), 300, 10000),
              x: Math.round(pos.x / scale),
              y: Math.round(pos.y / scale),
            });
          } catch {
            // ignore geometry capture
          }
          await Promise.all([
            invoke("save_sessions", { state }),
            flushSettingsPersist(),
          ]);
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
  }, [flushSettingsPersist, setWindowGeometry]);

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
      paneDictationCanceledRef.current = true;
      const recorder = paneDictationRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      clearPaneDictationTimers();
      stopPaneDictationTracks();
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
  }, [clearPaneDictationTimers, clearPtyTransientState, flushSave, stopPaneDictationTracks]);

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
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.key !== " ") return;
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement?.closest(".agent-pane")) return;

      const session = sessionsRef.current.find(
        (candidate) => candidate.id === activeSessionRef.current
      );
      const paneId = session?.activeWinId;
      if (!session || !paneId) return;
      const leaf = findLeafById(session.layout, paneId);
      if (leaf?.kind === "agent") return;
      if (!session.windows.some((win) => win.paneId === paneId && win.alive)) return;

      e.preventDefault();
      togglePaneDictation(paneId);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePaneDictation]);

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

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
  );

  const renderSessionRow = (
    session: Session,
    topLevelIndex: number,
    folderId?: string,
    folderIndex?: number
  ) => {
    const isRenaming = renamingSessionId === session.id;
    const isDragging = sidebarDrag?.kind === "session" && sidebarDrag.id === session.id;
    const dropTarget = sidebarDrag?.target;
    const isFolderRow = folderId !== undefined && folderIndex !== undefined;
    const isDropBefore = isFolderRow
      ? dropTarget?.type === "folder-content" &&
        dropTarget.folderId === folderId &&
        dropTarget.index === folderIndex
      : dropTarget?.type === "top-level" && dropTarget.index === topLevelIndex;
    const isDropAfter = isFolderRow
      ? dropTarget?.type === "folder-content" &&
        dropTarget.folderId === folderId &&
        dropTarget.index === folderIndex + 1
      : dropTarget?.type === "top-level" && dropTarget.index === topLevelIndex + 1;
    const aliveCount = session.windows.filter((win) => win.alive).length;

    return (
      <li
        key={session.id}
        className={`session-item ${
          session.id === activeSessionId ? "active" : ""
        } ${isFolderRow ? "nested" : ""} ${isDragging ? "dragging" : ""} ${
          isDropBefore ? "drop-before" : ""
        } ${isDropAfter ? "drop-after" : ""}`}
        title={session.folder ?? ""}
        data-sidebar-drop="session"
        data-sidebar-top-index={topLevelIndex}
        data-sidebar-folder-id={folderId}
        data-sidebar-folder-index={folderIndex}
        onPointerDown={(event) =>
          beginSidebarPointerDrag("session", session.id, event)
        }
        onClick={(event) => {
          if (sidebarSuppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          setActiveSessionId(session.id);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          beginRename(session.id, session.name);
        }}
      >
        <span
          className={`session-dot ${session.folder ? "linked" : ""}`}
          title={session.folder ?? ""}
        />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="session-rename-input"
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={() => commitRename(session.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename(session.id);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="session-name">{session.name}</span>
        )}
        <span className="session-count">{aliveCount}</span>
        <button
          className="close-btn"
          title="Close session"
          onClick={(event) => {
            event.stopPropagation();
            void closeSession(session.id);
          }}
        >
          ×
        </button>
      </li>
    );
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside
        className={`sidebar ${sidebarCollapsed ? "collapsed" : ""} ${
          sidebarResizing ? "resizing" : ""
        }`}
        style={{
          flexBasis: sidebarWidthPx,
          width: sidebarWidthPx,
        }}
      >
        <header className="sidebar-header">
          <div className="brand-lockup">
            <button
              type="button"
              className="brand-toggle"
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <img src={appLogo} alt="" className="brand-logo" />
            </button>
            {!sidebarCollapsed && <span className="brand-title">Wraith</span>}
          </div>
          {!sidebarCollapsed && (
            <div className="sidebar-actions" ref={headerMenuRef}>
              <button
                type="button"
                className={`new-btn menu-trigger ${headerMenuOpen ? "open" : ""}`}
                title="Actions"
                aria-label="Actions menu"
                aria-haspopup="menu"
                aria-expanded={headerMenuOpen}
                onClick={() => setHeaderMenuOpen((open) => !open)}
              >
                ▾
              </button>
              {headerMenuOpen && (
                <div className="sidebar-menu" role="menu">
                  <button
                    type="button"
                    className="sidebar-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      openSettings("appearance");
                    }}
                  >
                    <span className="sidebar-menu-icon" aria-hidden="true">
                      ⚙
                    </span>
                    <span>Settings</span>
                  </button>
                  <div className="sidebar-menu-sep" role="separator" />
                  <button
                    type="button"
                    className="sidebar-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      void createSession();
                    }}
                  >
                    <span className="sidebar-menu-icon" aria-hidden="true">
                      +
                    </span>
                    <span>New session</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      void createLinkedSession();
                    }}
                  >
                    <span className="sidebar-menu-icon" aria-hidden="true">
                      📁
                    </span>
                    <span>New linked session</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      createSidebarFolder();
                    }}
                  >
                    <span className="sidebar-menu-icon folder" aria-hidden="true">
                      <span className="header-folder-icon" />
                    </span>
                    <span>New folder</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </header>
        {sidebarCollapsed ? (
          <div className="sidebar-collapsed-rail">
            <button
              type="button"
              className="sidebar-rail-btn"
              title="Expand sidebar"
              aria-label="Expand sidebar"
              onClick={() => setSidebarCollapsed(false)}
            >
              ›
            </button>
            <button
              type="button"
              className="sidebar-rail-btn"
              title="Settings"
              aria-label="Settings"
              onClick={() => openSettings("appearance")}
            >
              ⚙
            </button>
            <button
              type="button"
              className="sidebar-rail-btn accent"
              title="New session"
              aria-label="New session"
              onClick={() => void createSession()}
            >
              +
            </button>
          </div>
        ) : (
        <ul
          className="session-list"
          data-sidebar-list
          data-sidebar-item-count={sidebar.items.length}
        >
          {sidebar.items.map((item, topLevelIndex) => {
            if (item.type === "session") {
              const session = sessionsById.get(item.id);
              return session
                ? renderSessionRow(session, topLevelIndex)
                : null;
            }

            const folder = sidebar.folders.find(
              (candidate) => candidate.id === item.id
            );
            if (!folder) return null;
            const folderSessions = folder.sessionIds
              .map((sessionId) => sessionsById.get(sessionId))
              .filter((session): session is Session => Boolean(session));
            const paneCount = folderSessions.reduce(
              (total, session) =>
                total + session.windows.filter((win) => win.alive).length,
              0
            );
            const isRenaming = renamingFolderId === folder.id;
            const isDragging =
              sidebarDrag?.kind === "folder" && sidebarDrag.id === folder.id;
            const isDropInto =
              sidebarDrag?.target?.type === "folder" &&
              sidebarDrag.target.folderId === folder.id;
            const isDropBefore =
              sidebarDrag?.target?.type === "top-level" &&
              sidebarDrag.target.index === topLevelIndex;
            const isDropAfter =
              sidebarDrag?.target?.type === "top-level" &&
              sidebarDrag.target.index === topLevelIndex + 1;

            return (
              <li
                key={folder.id}
                className={`sidebar-folder ${isDragging ? "dragging" : ""} ${
                  isDropInto ? "drop-into" : ""
                } ${isDropBefore ? "drop-before" : ""} ${
                  isDropAfter ? "drop-after" : ""
                }`}
              >
                <div
                  className="folder-item"
                  data-sidebar-drop="folder"
                  data-sidebar-top-index={topLevelIndex}
                  data-sidebar-folder-id={folder.id}
                  onPointerDown={(event) =>
                    beginSidebarPointerDrag("folder", folder.id, event)
                  }
                  onClick={(event) => {
                    if (sidebarSuppressClickRef.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                    toggleSidebarFolder(folder.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    beginFolderRename(folder.id, folder.name);
                  }}
                >
                  <span className={`folder-chevron ${folder.collapsed ? "collapsed" : ""}`}>
                    ▾
                  </span>
                  <span className="folder-icon" aria-hidden="true" />
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="session-rename-input"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => commitFolderRename(folder.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitFolderRename(folder.id);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                    />
                  ) : (
                    <span className="folder-name">{folder.name}</span>
                  )}
                  <span className="session-count">{paneCount}</span>
                  <button
                    className="folder-delete-btn"
                    title="Delete folder"
                    aria-label={`Delete folder ${folder.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteSidebarFolder(folder.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {!folder.collapsed && (
                  <ul
                    className="folder-session-list"
                    data-sidebar-drop="folder-content"
                    data-sidebar-top-index={topLevelIndex}
                    data-sidebar-folder-id={folder.id}
                    data-sidebar-folder-index={folderSessions.length}
                  >
                    {folderSessions.map((session, folderIndex) =>
                      renderSessionRow(
                        session,
                        topLevelIndex,
                        folder.id,
                        folderIndex
                      )
                    )}
                    {folderSessions.length === 0 && (
                      <li
                        className={`folder-empty-drop ${isDropInto ? "drop-into" : ""}`}
                      >
                        Drop sessions here
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        )}
        <div
          className="sidebar-resize-handle"
          title="Drag to resize sidebar"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={beginSidebarResize}
        />
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
              <button
                className="tool-btn agent-tool-btn"
                title="Add AI agent pane"
                onClick={() => addAgentToActive()}
              >
                + Agent
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
                          onClose={(paneId) => {
                            void closeWindow(paneId);
                          }}
                          onFocus={setActiveWin}
                          onHeaderPointerDown={beginPaneDrag}
                          onResizeSplit={resizeSplit}
                          onLaunchAi={launchAi}
                          dictation={paneDictation}
                          onToggleDictation={togglePaneDictation}
                          onCancelDictation={cancelPaneDictation}
                          orchestrator={orchestrator}
                          aiSettings={settings.ai}
                          onOpenAiSettings={() => openSettings("ai")}
                          panesProvider={() =>
                            session.windows
                              .filter((w) => w.alive)
                              .map((w) => ({
                                paneId: w.paneId,
                                ptyId: w.id,
                                sessionName: session.name,
                                folder: session.folder,
                                alive: w.alive,
                              }))
                          }
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

      {settingsOpen && <AppSettingsModal api={appSettings} />}

      {confirmDialog &&
        createPortal(
          <div
            className="confirm-modal-backdrop"
            onMouseDown={(e) => {
              // Only dismiss when pressing the backdrop itself (not the card).
              if (e.target === e.currentTarget) resolveConfirm(false);
            }}
          >
            <div
              className="confirm-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-dialog-title"
              aria-describedby="confirm-dialog-message"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <header className="confirm-modal-header">
                <span className="confirm-modal-title" id="confirm-dialog-title">
                  {confirmDialog.title}
                </span>
                <button
                  type="button"
                  className="confirm-modal-x"
                  aria-label="Cancel"
                  onClick={() => resolveConfirm(false)}
                >
                  ×
                </button>
              </header>
              <div className="confirm-modal-body">
                <span className="confirm-modal-icon" aria-hidden="true">
                  ⚠
                </span>
                <p className="confirm-modal-message" id="confirm-dialog-message">
                  {confirmDialog.message}
                </p>
              </div>
              <footer className="confirm-modal-footer">
                <button
                  type="button"
                  className="confirm-modal-btn"
                  onClick={() => resolveConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="confirm-modal-btn confirm-modal-btn-danger"
                  autoFocus
                  onClick={() => resolveConfirm(true)}
                >
                  Close
                </button>
              </footer>
            </div>
          </div>,
          document.body
        )}

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







