import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { buildAgentCommand, splitAgentCompletionMarkers, type AgentCompletionMarker } from "./commandMarker";
import type { OrchestratorApi, PaneAgentName } from "./orchestratorTypes";
import { PaneBufferStore } from "./paneBuffer";

export type ToolName =
  | "list_panes"
  | "read_pane"
  | "run_command"
  | "launch_agent"
  | "prompt_pane";

export interface ToolCallArgs {
  paneId?: string;
  command?: string;
  lines?: number;
  agent?: PaneAgentName;
  task?: string;
  prompt?: string;
}

export interface PaneInfo {
  paneId: string;
  ptyId: string;
  sessionName: string;
  folder: string | null;
  alive: boolean;
}

export interface RunCommandResult {
  output: string;
  exitCode: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_panes",
      description:
        "List all terminal panes in the active session with pane IDs, agent status (if any), session name, and working folder. Call this first to learn which paneIds you can target.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pane",
      description:
        "Read recent output from a terminal pane. Returns the last N lines of scrollback (default 200). Use this to observe what an agent produced or whether a pane is idle before prompting.",
      parameters: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "The paneId from list_panes." },
          lines: {
            type: "number",
            description: "Number of recent lines to return (default 200, max 1000).",
          },
        },
        required: ["paneId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "launch_agent",
      description:
        "Launch an AI agent CLI (codex, claude, grok, or opencode) in a terminal pane with an initial task prompt. Use when no agent is running in the pane or you need a fresh one-shot agent run.",
      parameters: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "The paneId from list_panes." },
          agent: {
            type: "string",
            enum: ["codex", "claude", "grok", "opencode"],
            description: "Which agent CLI to launch.",
          },
          task: {
            type: "string",
            description: "The task/prompt to give the agent.",
          },
        },
        required: ["paneId", "agent", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prompt_pane",
      description:
        "Send a follow-up prompt to an already-running agent or shell in a terminal pane. Prefer this when an agent is already active in the pane.",
      parameters: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "The paneId from list_panes." },
          prompt: {
            type: "string",
            description: "The prompt text to send to the pane.",
          },
        },
        required: ["paneId", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a raw PowerShell command in a terminal pane and wait for it to finish. Prefer launch_agent or prompt_pane for AI tasks; use this only for direct shell operations.",
      parameters: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "The paneId from list_panes." },
          command: {
            type: "string",
            description: "The command line to execute in the pane's PowerShell shell.",
          },
        },
        required: ["paneId", "command"],
      },
    },
  },
];

export interface ToolContext {
  panes: () => PaneInfo[];
  buffer: PaneBufferStore;
  hookUrl: string;
  label: string;
  orchestrator: OrchestratorApi | null;
}

const READ_TOOLS = new Set<ToolName>(["list_panes", "read_pane"]);
const APPROVAL_TOOLS = new Set<ToolName>([
  "run_command",
  "launch_agent",
  "prompt_pane",
]);

export function isReadTool(name: ToolName): boolean {
  return READ_TOOLS.has(name);
}

export function requiresApproval(name: ToolName): boolean {
  return APPROVAL_TOOLS.has(name);
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function findPane(ctx: ToolContext, paneId: string) {
  return ctx.panes().find((p) => p.paneId === paneId);
}

function readPaneOutput(ctx: ToolContext, paneId: string, lines?: number): string {
  const pane = findPane(ctx, paneId);
  if (!pane) return `error: no such pane ${paneId}`;
  const count = Math.min(Math.max(lines ?? 200, 1), 1000);
  const raw = ctx.buffer.read(pane.ptyId, count);
  return raw || "(no output captured yet)";
}

const pendingRuns = new Map<string, (result: RunCommandResult) => void>();

export async function runCommandInPane(
  ctx: ToolContext,
  paneId: string,
  command: string,
  token: string
): Promise<RunCommandResult> {
  const pane = findPane(ctx, paneId);
  if (!pane) {
    return { output: `error: no such pane ${paneId}`, exitCode: 1 };
  }

  const input = buildAgentCommand(command, token, ctx.hookUrl, ctx.label);

  let unlisten: UnlistenFn | null = null;
  let accumulated = "";
  let resolved = false;

  const done = new Promise<RunCommandResult>((resolve) => {
    pendingRuns.set(token, resolve);
    void listen<{ id: string; data: string }>("pty-output", (e) => {
      if (e.payload.id !== pane.ptyId) return;
      accumulated += e.payload.data;
      const parsed = splitAgentCompletionMarkers(accumulated);
      for (const marker of parsed.markers) {
        if (marker.token === token) {
          const visible = splitAgentCompletionMarkers(accumulated).visible;
          const cleaned = stripAnsi(visible);
          resolved = true;
          resolve({ output: cleaned, exitCode: marker.exitCode });
          break;
        }
      }
    }).then((u) => {
      if (resolved) u();
      else unlisten = u;
    });
  });

  void invoke("write_powershell", { id: pane.ptyId, input }).catch(() => {
    if (!resolved) {
      resolved = true;
      pendingRuns.get(token)?.({ output: "error: failed to write to pane", exitCode: 1 });
    }
  });

  const timeout = new Promise<RunCommandResult>((resolve) => {
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ output: "(command timed out after 60s)", exitCode: 124 });
      }
    }, 60_000);
  });

  const result = await Promise.race([done, timeout]);
  pendingRuns.delete(token);
  if (unlisten) (unlisten as () => void)();
  return result;
}

export async function executeApprovalTool(
  ctx: ToolContext,
  name: ToolName,
  args: ToolCallArgs,
  token: string
): Promise<RunCommandResult> {
  switch (name) {
    case "run_command":
      return runCommandInPane(ctx, args.paneId ?? "", args.command ?? "", token);
    case "launch_agent": {
      if (!ctx.orchestrator) {
        return { output: "error: orchestrator not available", exitCode: 1 };
      }
      const agent = args.agent;
      if (!agent || !args.paneId || !args.task) {
        return { output: "error: paneId, agent, and task are required", exitCode: 1 };
      }
      return ctx.orchestrator.launchAgent(args.paneId, agent, args.task);
    }
    case "prompt_pane": {
      if (!ctx.orchestrator) {
        return { output: "error: orchestrator not available", exitCode: 1 };
      }
      if (!args.paneId || !args.prompt) {
        return { output: "error: paneId and prompt are required", exitCode: 1 };
      }
      return ctx.orchestrator.promptPane(args.paneId, args.prompt);
    }
    default:
      return { output: `error: tool ${name} is not an approval tool`, exitCode: 1 };
  }
}

export async function executeReadTool(
  ctx: ToolContext,
  name: ToolName,
  args: ToolCallArgs
): Promise<string> {
  switch (name) {
    case "list_panes": {
      const panes = ctx.panes();
      if (panes.length === 0) return "No terminal panes in the active session.";
      const runs = ctx.orchestrator?.listAgentRuns() ?? [];
      const runByPane = new Map(runs.map((r) => [r.paneId, r]));
      return panes
        .map((p) => {
          const run = runByPane.get(p.paneId);
          const agentPart = run
            ? ` agent=${run.label} busy=${run.busy}`
            : " agent=(none)";
          return `- paneId=${p.paneId}${agentPart} session="${p.sessionName}" folder=${p.folder ?? "(none)"} alive=${p.alive}`;
        })
        .join("\n");
    }
    case "read_pane": {
      if (!args.paneId) return "error: paneId is required";
      return readPaneOutput(ctx, args.paneId, args.lines);
    }
    default:
      return `error: tool ${name} is not a read tool`;
  }
}

export type { AgentCompletionMarker };