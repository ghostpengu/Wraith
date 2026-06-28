import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { splitAgentCompletionMarkers } from "./commandMarker";
import type { OrchestratorResult } from "./orchestratorTypes";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function waitForAgentToken(
  token: string,
  timeoutMs = 300_000
): Promise<OrchestratorResult> {
  let accumulated = "";
  let resolved = false;
  let unlistenOutput: UnlistenFn | null = null;
  let unlistenFinished: UnlistenFn | null = null;

  const finish = (result: OrchestratorResult) => {
    if (resolved) return;
    resolved = true;
    unlistenOutput?.();
    unlistenFinished?.();
    resolveOuter(result);
  };

  let resolveOuter!: (result: OrchestratorResult) => void;

  const promise = new Promise<OrchestratorResult>((resolve) => {
    resolveOuter = resolve;

    const timer = setTimeout(() => {
      const cleaned = stripAnsi(splitAgentCompletionMarkers(accumulated).visible);
      finish({
        output: cleaned || "(timed out waiting for agent)",
        exitCode: 124,
      });
    }, timeoutMs);

    void Promise.all([
      listen<{ id: string; data: string }>("pty-output", (e) => {
        accumulated += e.payload.data;
        const parsed = splitAgentCompletionMarkers(accumulated);
        for (const marker of parsed.markers) {
          if (marker.token === token) {
            clearTimeout(timer);
            const cleaned = stripAnsi(parsed.visible);
            finish({ output: cleaned, exitCode: marker.exitCode });
            return;
          }
        }
      }),
      listen<{ runId: string }>("agent-finished", (e) => {
        if (e.payload.runId !== token) return;
        clearTimeout(timer);
        const cleaned = stripAnsi(splitAgentCompletionMarkers(accumulated).visible);
        finish({ output: cleaned, exitCode: 0 });
      }),
    ]).then(([output, finished]) => {
      if (resolved) {
        output();
        finished();
        return;
      }
      unlistenOutput = output;
      unlistenFinished = finished;
    });
  });

  return promise;
}

export function waitForPaneOutput(
  ptyId: string,
  idleMs = 4000,
  maxMs = 180_000
): Promise<OrchestratorResult> {
  let accumulated = "";
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolved = false;
  let unlisten: UnlistenFn | null = null;

  const finish = (result: OrchestratorResult) => {
    if (resolved) return;
    resolved = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    unlisten?.();
    resolveOuter(result);
  };

  let resolveOuter!: (result: OrchestratorResult) => void;
  const maxTimer = setTimeout(() => {
    const cleaned = stripAnsi(splitAgentCompletionMarkers(accumulated).visible);
    finish({
      output: cleaned || "(no output received)",
      exitCode: 0,
    });
  }, maxMs);

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const cleaned = stripAnsi(splitAgentCompletionMarkers(accumulated).visible);
      finish({ output: cleaned, exitCode: 0 });
    }, idleMs);
  };

  return new Promise<OrchestratorResult>((resolve) => {
    resolveOuter = resolve;
    void listen<{ id: string; data: string }>("pty-output", (e) => {
      if (e.payload.id !== ptyId) return;
      accumulated += e.payload.data;
      resetIdle();
    }).then((u) => {
      if (resolved) u();
      else {
        unlisten = u;
        resetIdle();
      }
    });
  });
}