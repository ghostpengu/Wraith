export type PaneAgentName = "codex" | "claude" | "grok" | "opencode";

export interface AgentRunInfo {
  paneId: string;
  ptyId: string;
  label: string;
  busy: boolean;
}

export interface OrchestratorResult {
  output: string;
  exitCode: number;
}

export interface OrchestratorApi {
  listAgentRuns: () => AgentRunInfo[];
  launchAgent: (
    paneId: string,
    agent: PaneAgentName,
    task: string
  ) => Promise<OrchestratorResult>;
  promptPane: (paneId: string, prompt: string) => Promise<OrchestratorResult>;
}