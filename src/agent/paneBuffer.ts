import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { splitAgentCompletionMarkers } from "./commandMarker";

export interface PaneOutputSubscription {
  unlisten: UnlistenFn;
}

const MAX_LINE_BYTES = 256 * 1024;

export class PaneBufferStore {
  private buffers = new Map<string, string>();
  private unlistenFn: UnlistenFn | null = null;

  attach(): Promise<PaneOutputSubscription> {
    if (this.unlistenFn) {
      return Promise.resolve({ unlisten: this.unlistenFn });
    }
    return listen<{ id: string; data: string }>("pty-output", (e) => {
      this.append(e.payload.id, e.payload.data);
    }).then((unlisten) => {
      this.unlistenFn = unlisten;
      return { unlisten };
    });
  }

  detach() {
    this.unlistenFn?.();
    this.unlistenFn = null;
    this.buffers.clear();
  }

  private append(id: string, data: string) {
    const prev = this.buffers.get(id) ?? "";
    const { visible } = splitAgentCompletionMarkers(prev + data);
    const trimmed = visible.slice(-MAX_LINE_BYTES);
    this.buffers.set(id, trimmed);
  }

  read(id: string, lines?: number): string {
    const raw = this.buffers.get(id) ?? "";
    if (!raw) return "";
    const normalized = raw.replace(/\r\n?/g, "\n");
    const allLines = normalized.split("\n");
    if (lines === undefined || lines >= allLines.length) return normalized;
    return allLines.slice(-lines).join("\n");
  }

  has(id: string): boolean {
    return this.buffers.has(id);
  }

  forget(id: string) {
    this.buffers.delete(id);
  }
}