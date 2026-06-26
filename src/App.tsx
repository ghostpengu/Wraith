import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

interface PtyOutputPayload {
  id: string;
  data: string;
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
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  onResizeDispose: () => void;
  onDataDispose: () => void;
  alive: boolean;
}

interface Session {
  id: string;
  windows: Win[];
  layout: LayoutNode | null;
  activeWinId: string | null;
}

const sessionName = (i: number) => `Session ${i + 1}`;
const dragStartDistance = 5;
let splitSerial = 0;

function createSplitId() {
  splitSerial += 1;
  return `split-${Date.now()}-${splitSerial}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

function fitAndRefresh(win: Win) {
  try {
    win.fitAddon.fit();
    if (win.term.rows > 0) {
      win.term.refresh(0, win.term.rows - 1);
    }
  } catch {
    // ignore
  }
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

    const frame = window.requestAnimationFrame(() => {
      fitAndRefresh(win);
      window.requestAnimationFrame(() => fitAndRefresh(win));
    });

    return () => window.cancelAnimationFrame(frame);
  }, [win]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => fitAndRefresh(win));
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
  onClose,
  onFocus,
  onHeaderPointerDown,
  onResizeSplit,
}: {
  node: LayoutNode;
  session: Session;
  activeWinId: string | null;
  dragState: PaneDragState | null;
  onClose: (winId: string) => void;
  onFocus: (winId: string) => void;
  onHeaderPointerDown: (
    winId: string,
    e: React.PointerEvent<HTMLDivElement>
  ) => void;
  onResizeSplit: (splitId: string, deltaRatio: number) => void;
}) {
  if (node.type === "leaf") {
    const win = session.windows.find((w) => w.id === node.winId);
    if (!win) return null;

    return (
      <div
        data-pane-id={win.id}
        className={`pane-cell ${activeWinId === win.id ? "active" : ""} ${
          dragState?.winId === win.id ? "dragging" : ""
        } ${dragState?.targetWinId === win.id ? "drag-target" : ""}`}
        onPointerDownCapture={() => onFocus(win.id)}
      >
        <div
          className="pane-header"
          onPointerDown={(e) => onHeaderPointerDown(win.id, e)}
        >
          <span className="pane-dot" />
          <span className="pane-label">PS</span>
          <button
            className="pane-close"
            title="Close pane"
            onClick={(e) => {
              e.stopPropagation();
              onClose(win.id);
            }}
          >
            ×
          </button>
        </div>
        <div className="pane-term">
          <TermContainer win={win} />
        </div>
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
          onClose={onClose}
          onFocus={onFocus}
          onHeaderPointerDown={onHeaderPointerDown}
          onResizeSplit={onResizeSplit}
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
          onClose={onClose}
          onFocus={onFocus}
          onHeaderPointerDown={onHeaderPointerDown}
          onResizeSplit={onResizeSplit}
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

  const sessionsRef = useRef<Session[]>([]);
  const activeSessionRef = useRef<string | null>(null);
  const initRef = useRef(false);
  const paneDragRef = useRef<PaneDragSession | null>(null);
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const pendingExitRef = useRef<Set<string>>(new Set());

  sessionsRef.current = sessions;
  activeSessionRef.current = activeSessionId;

  useEffect(() => {
    let disposed = false;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;

    const findWindow = (id: string) => {
      for (const s of sessionsRef.current) {
        const win = s.windows.find((w) => w.id === id);
        if (win) return win;
      }
      return null;
    };

    void Promise.all([
      listen<PtyOutputPayload>("pty-output", (e) => {
        const win = findWindow(e.payload.id);
        if (win && win.alive) {
          win.term.write(e.payload.data);
          return;
        }

        const pending = pendingOutputRef.current.get(e.payload.id) ?? "";
        pendingOutputRef.current.set(e.payload.id, pending + e.payload.data);
      }),
      listen<string>("pty-exit", (e) => {
        const win = findWindow(e.payload);
        if (win && win.alive) {
          win.term.write("\r\n\x1b[31m[process exited]\x1b[0m\r\n");
          setSessions((prev) =>
            prev.map((s) => ({
              ...s,
              windows: s.windows.map((x) =>
                x.id === e.payload ? { ...x, alive: false } : x
              ),
            }))
          );
          return;
        }

        pendingExitRef.current.add(e.payload);
      }),
    ]).then(([output, exit]) => {
      if (disposed) {
        output();
        exit();
        return;
      }

      unlistenOutput = output;
      unlistenExit = exit;
      setPtyListenersReady(true);
    });

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, []);

  const createWin = useCallback(async (): Promise<Win> => {
    const id = await invoke<string>("spawn_powershell");
    const term = new Terminal({
      fontFamily: "Cascadia Code, Consolas, Courier New, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 0,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const onResize = term.onResize(({ cols, rows }) => {
      void invoke("resize_powershell", { id, cols, rows });
    });
    const onData = term.onData((d) => {
      void invoke("write_powershell", { id, input: d });
    });

    return {
      id,
      term,
      fitAddon,
      onResizeDispose: onResize.dispose,
      onDataDispose: onData.dispose,
      alive: true,
    };
  }, []);

  const createSession = useCallback(async () => {
    const win = await createWin();
    const session: Session = {
      id: `sess-${Date.now()}`,
      windows: [win],
      layout: { type: "leaf", winId: win.id },
      activeWinId: win.id,
    };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, [createWin]);

  const setActiveWin = useCallback((winId: string) => {
    const sid = activeSessionRef.current;
    if (!sid) return;

    setSessions((prev) =>
      prev.map((s) => (s.id === sid ? { ...s, activeWinId: winId } : s))
    );
  }, []);

  const addWindowToActive = useCallback(async () => {
    const sid = activeSessionRef.current;
    if (!sid) return;
    const session = sessionsRef.current.find((s) => s.id === sid);
    if (!session) return;

    const win = await createWin();
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s;
        const targetWinId = s.activeWinId ?? firstLeafId(s.layout) ?? win.id;
        const activeRect =
          s.layout && targetWinId !== win.id
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
          ? insertWindow(s.layout, targetWinId, win.id, dir)
          : { type: "leaf" as const, winId: win.id };

        return {
          ...s,
          windows: [...s.windows, win],
          layout,
          activeWinId: win.id,
        };
      })
    );
  }, [createWin]);

  const closeWindow = useCallback((winId: string) => {
    for (const s of sessionsRef.current) {
      const w = s.windows.find((x) => x.id === winId);
      if (!w) continue;
      pendingOutputRef.current.delete(winId);
      pendingExitRef.current.delete(winId);
      void invoke("kill_powershell", { id: winId });
      w.onResizeDispose();
      w.onDataDispose();
      w.term.dispose();
      setSessions((prev) =>
        prev.map((session) => {
          if (!session.windows.some((x) => x.id === winId)) return session;
          const layout = removeWindow(session.layout, winId);
          const activeWinId =
            session.activeWinId === winId
              ? firstLeafId(layout)
              : session.activeWinId;

          return {
            ...session,
            windows: session.windows.filter((x) => x.id !== winId),
            layout,
            activeWinId,
          };
        })
      );
      break;
    }
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    const sess = sessionsRef.current.find((s) => s.id === sessionId);
    if (!sess) return;
    for (const w of sess.windows) {
      pendingOutputRef.current.delete(w.id);
      pendingExitRef.current.delete(w.id);
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
  }, []);

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
    void createSession();
  }, [createSession, ptyListenersReady]);

  useEffect(() => {
    const exitedIds: string[] = [];

    for (const s of sessions) {
      for (const w of s.windows) {
        const pending = pendingOutputRef.current.get(w.id);
        if (pending) {
          w.term.write(pending);
          pendingOutputRef.current.delete(w.id);
          fitAndRefresh(w);
        }

        if (pendingExitRef.current.has(w.id)) {
          pendingExitRef.current.delete(w.id);
          exitedIds.push(w.id);
          w.term.write("\r\n\x1b[31m[process exited]\x1b[0m\r\n");
        }
      }
    }

    if (exitedIds.length > 0) {
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          windows: s.windows.map((w) =>
            exitedIds.includes(w.id) ? { ...w, alive: false } : w
          ),
        }))
      );
    }
  }, [sessions]);

  useEffect(() => {
    return () => {
      for (const s of sessionsRef.current) {
        for (const w of s.windows) {
          pendingOutputRef.current.delete(w.id);
          pendingExitRef.current.delete(w.id);
          w.onResizeDispose();
          w.onDataDispose();
          void invoke("kill_powershell", { id: w.id });
          w.term.dispose();
        }
      }
    };
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeWindowIds =
    activeSession?.windows.map((w) => w.id).join("|") ?? "";
  const activeLayoutSignature = layoutSignature(activeSession?.layout ?? null);
  const hasSessions = activeSession !== undefined;

  useEffect(() => {
    if (!activeSessionId) return;

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
        session.windows.find((w) => w.id === session.activeWinId) ??
        session.windows.find((w) => w.alive);
      activeWin?.term.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, activeWindowIds, activeLayoutSignature]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="sidebar-title">Sessions</span>
          <button
            className="new-btn"
            title="New session"
            onClick={() => void createSession()}
          >
            +
          </button>
        </header>
        <ul className="session-list">
          {sessions.map((s, i) => {
            const aliveCount = s.windows.filter((w) => w.alive).length;
            return (
              <li
                key={s.id}
                className={`session-item ${
                  s.id === activeSessionId ? "active" : ""
                }`}
                onClick={() => setActiveSessionId(s.id)}
              >
                <span className="session-dot" />
                <span className="session-name">{sessionName(i)}</span>
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
                          onClose={closeWindow}
                          onFocus={setActiveWin}
                          onHeaderPointerDown={beginPaneDrag}
                          onResizeSplit={resizeSplit}
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
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
