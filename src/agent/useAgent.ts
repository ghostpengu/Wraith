import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PaneBufferStore } from "./paneBuffer";
import type { OrchestratorApi } from "./orchestratorTypes";
import {
  TOOL_DEFINITIONS,
  executeApprovalTool,
  executeReadTool,
  isReadTool,
  type PaneInfo,
  type ToolCallArgs,
  type ToolContext,
  type ToolName,
} from "./tools";
import { createAgentRunToken } from "./commandMarker";

export interface AgentSettings {
  provider: "openrouter" | "ollama";
  model: string;
  baseUrl: string;
  apiKey: string;
}

export type MessageStatus =
  | "streaming"
  | "awaiting-approval"
  | "approved"
  | "running"
  | "rejected"
  | "done"
  | "error";

export interface AgentToolCall {
  id: string;
  name: ToolName;
  args: ToolCallArgs;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: AgentToolCall[];
  toolName?: ToolName;
  toolCallId?: string;
  toolResult?: { output: string; exitCode?: number } | null;
  status: MessageStatus;
}

export interface AgentThread {
  messages: AgentMessage[];
  busy: boolean;
  error: string | null;
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}


interface AgentChatCompletionResponse {
  status: number;
  body: string;
}

interface OllamaMessage {
  role: OpenAiMessage["role"];
  content?: string;
  tool_calls?: Array<{
    type: "function";
    function: { name: string; arguments: ToolCallArgs };
  }>;
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: {
    content?: unknown;
    tool_calls?: Array<{
      function?: {
        name?: unknown;
        arguments?: unknown;
      };
    }>;
  };
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OLLAMA_CLOUD_API_BASE_URL = "https://ollama.com/api";
const LEGACY_OLLAMA_BASE_URLS = new Set([
  "https://api.ollama.com",
  "https://api.ollama.com/v1",
]);

function normalizeBaseUrl(provider: AgentSettings["provider"], baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return provider === "ollama" ? OLLAMA_CLOUD_API_BASE_URL : OPENROUTER_BASE_URL;
  }
  if (provider === "ollama" && LEGACY_OLLAMA_BASE_URLS.has(trimmed.toLowerCase())) {
    return OLLAMA_CLOUD_API_BASE_URL;
  }
  return trimmed;
}

function normalizeSettings(settings: AgentSettings): AgentSettings {
  return {
    ...settings,
    baseUrl: normalizeBaseUrl(settings.provider, settings.baseUrl),
  };
}

function isOllamaNative(settings: AgentSettings): boolean {
  return settings.provider === "ollama" && !settings.baseUrl.match(/\/v1$/i);
}

function completionUrl(settings: AgentSettings): string {
  return `${settings.baseUrl}/${isOllamaNative(settings) ? "chat" : "chat/completions"}`;
}

function requestModel(settings: AgentSettings): string {
  if (!isOllamaNative(settings) || !settings.baseUrl.startsWith(OLLAMA_CLOUD_API_BASE_URL)) {
    return settings.model;
  }
  return settings.model.replace(/(?::cloud|-cloud)$/i, "");
}

function parseToolArgs(value: unknown): ToolCallArgs {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseToolArgs(parsed);
    } catch {
      return { command: value };
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as ToolCallArgs;
  }
  return {};
}

let msgSerial = 0;
function newMessageId() {
  msgSerial += 1;
  return `msg-${Date.now()}-${msgSerial}`;
}

let runSerial = 0;
function nextRunToken() {
  runSerial += 1;
  return createAgentRunToken(() => runSerial);
}

function buildSystemPrompt(folder: string | null): string {
  return [
    "You are the orchestrator agent in Wraith, a Windows tiling terminal emulator.",
    "Terminal panes may host AI agent CLIs: codex, claude, grok, or opencode.",
    "Your job is to observe panes and drive those agents to complete user tasks.",
    "You are in a multi-turn agent loop — keep calling tools until the task is done.",
    "",
    "Tools:",
    "- list_panes(): list panes with agent status (agent label, busy). Call first when pane IDs are unknown.",
    "- read_pane(paneId, lines?): read recent scrollback from a pane.",
    "- launch_agent(paneId, agent, task): start an agent CLI with a task.",
    "- prompt_pane(paneId, prompt): send a follow-up prompt to a running pane.",
    "- run_command(paneId, command): raw PowerShell only.",
    "",
    "Rules:",
    "- NEVER reply with a capability menu or 'what would you like me to do?'. Always act with tools.",
    "- On every user request: list_panes → read_pane → launch_agent or prompt_pane → read_pane → summarize.",
    "- When the user asks to act on multiple panes or agents at the same time, emit one tool call per target in the same assistant turn.",
    "- Prefer launch_agent/prompt_pane for AI work; use run_command only for direct shell commands.",
    "- Tool calls run immediately; wait for tool results before claiming success.",
    `- Active session folder: ${folder ?? "(none)"}`,
    "- Be concise: brief plan, then tool calls.",
  ].join("\n");
}

function parseSseChunk(chunk: string): string[] {
  const events: string[] = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") continue;
    events.push(data);
  }
  return events;
}

function authHeaders(settings: AgentSettings): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://wraith.local";
    headers["X-Title"] = "Wraith";
  }
  if (settings.apiKey) {
    headers["Authorization"] = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

export interface UseAgentApi {
  thread: AgentThread;
  settings: AgentSettings | null;
  settingsOpen: boolean;
  panes: () => PaneInfo[];
  setPanesProvider: (provider: () => PaneInfo[]) => void;
  send: (text: string) => void;
  approveToolCall: (messageId: string) => void;
  rejectToolCall: (messageId: string) => void;
  cancel: () => void;
  clearThread: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  saveSettings: (settings: AgentSettings) => Promise<void>;
}

export function useAgent(
  folder: string | null,
  sessionName: string,
  orchestrator: OrchestratorApi
): UseAgentApi {
  const [thread, setThread] = useState<AgentThread>({
    messages: [],
    busy: false,
    error: null,
  });
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const bufferRef = useRef<PaneBufferStore>(new PaneBufferStore());
  const panesRef = useRef<() => PaneInfo[]>(() => []);
  const abortRef = useRef<AbortController | null>(null);
  const threadEpochRef = useRef(0);
  const threadRef = useRef<AgentThread>(thread);
  const settingsRef = useRef<AgentSettings | null>(null);
  const folderRef = useRef<string | null>(folder);
  const sessionNameRef = useRef<string>(sessionName);
  const hookUrlRef = useRef<string | null>(null);
  const orchestratorRef = useRef<OrchestratorApi>(orchestrator);
  const streamRef = useRef<() => Promise<void>>(async () => {});

  orchestratorRef.current = orchestrator;

  threadRef.current = thread;
  settingsRef.current = settings;
  folderRef.current = folder;
  sessionNameRef.current = sessionName;

  useEffect(() => {
    const sub = bufferRef.current.attach();
    return () => {
      void sub.then((s) => s.unlisten());
      bufferRef.current.detach();
    };
  }, []);

  useEffect(() => {
    void invoke<unknown>("load_agent_settings")
      .then((raw) => {
        if (!raw || typeof raw !== "object") return;
        const obj = raw as Record<string, unknown>;
        const provider = obj.provider === "ollama" ? "ollama" : "openrouter";
        const model =
          typeof obj.model === "string" && obj.model
            ? obj.model
            : provider === "ollama"
              ? "qwen2.5:32b"
              : "anthropic/claude-3.5-sonnet";
        const baseUrl =
          typeof obj.baseUrl === "string" && obj.baseUrl
            ? obj.baseUrl
            : provider === "ollama"
              ? OLLAMA_CLOUD_API_BASE_URL
              : OPENROUTER_BASE_URL;
        const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : "";
        setSettings(normalizeSettings({ provider, model, baseUrl, apiKey }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void invoke<string>("agent_hook_url")
      .then((url) => {
        hookUrlRef.current = url;
      })
      .catch(() => undefined);
  }, []);

  const setPanesProvider = useCallback((provider: () => PaneInfo[]) => {
    panesRef.current = provider;
  }, []);

  const panes = useCallback(() => panesRef.current(), []);

  const toolContext = useCallback((): ToolContext => {
    const hookUrl = hookUrlRef.current ?? "http://127.0.0.1:0/agent-finished";
    return {
      panes: panesRef.current,
      buffer: bufferRef.current,
      hookUrl,
      label: "wraith-agent",
      orchestrator: orchestratorRef.current,
    };
  }, []);

  const updateMessage = useCallback(
    (id: string, patch: Partial<AgentMessage>) => {
      setThread((prev) => ({
        ...prev,
        messages: prev.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }));
    },
    []
  );

  const appendMessage = useCallback((message: AgentMessage) => {
    setThread((prev) => ({ ...prev, messages: [...prev.messages, message] }));
  }, []);

  const buildHistory = useCallback((): OpenAiMessage[] => {
    const sys: OpenAiMessage = {
      role: "system",
      content: buildSystemPrompt(folderRef.current),
    };
    const rest: OpenAiMessage[] = threadRef.current.messages.flatMap((m): OpenAiMessage[] => {
      if (m.role === "user") {
        return [{ role: "user", content: m.content }];
      }
      if (m.role === "assistant") {
        if (m.toolCalls && m.toolCalls.length > 0) {
          return [
            {
              role: "assistant",
              content: m.content || null,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            },
          ];
        }
        return [{ role: "assistant", content: m.content }];
      }
      if (m.role === "tool" && m.toolName) {
        const resultText = m.toolResult?.output ?? "(no output)";
        const exitSuffix =
          m.toolResult?.exitCode !== undefined
            ? `\n[exit code: ${m.toolResult.exitCode}]`
            : "";
        return [
          {
            role: "tool",
            content: `${resultText}${exitSuffix}`,
            tool_call_id: m.toolCallId ?? m.id,
          },
        ];
      }
      return [];
    });
    return [sys, ...rest];
  }, []);

  const buildOllamaHistory = useCallback((): OllamaMessage[] => {
    const sys: OllamaMessage = {
      role: "system",
      content: buildSystemPrompt(folderRef.current),
    };
    const rest: OllamaMessage[] = threadRef.current.messages.flatMap((m): OllamaMessage[] => {
      if (m.role === "user") {
        return [{ role: "user", content: m.content }];
      }
      if (m.role === "assistant") {
        if (m.toolCalls && m.toolCalls.length > 0) {
          return [
            {
              role: "assistant",
              content: m.content || "",
              tool_calls: m.toolCalls.map((tc) => ({
                type: "function" as const,
                function: { name: tc.name, arguments: tc.args },
              })),
            },
          ];
        }
        return [{ role: "assistant", content: m.content }];
      }
      if (m.role === "tool" && m.toolName) {
        const resultText = m.toolResult?.output ?? "(no output)";
        const exitSuffix =
          m.toolResult?.exitCode !== undefined
            ? `\n[exit code: ${m.toolResult.exitCode}]`
            : "";
        return [
          {
            role: "tool",
            content: `${resultText}${exitSuffix}`,
            tool_name: m.toolName,
          },
        ];
      }
      return [];
    });
    return [sys, ...rest];
  }, []);

  const runReadTools = useCallback(
    async (toolCalls: AgentToolCall[], continueAfter = true) => {
      const epoch = threadEpochRef.current;
      const ctx = toolContext();
      for (const tc of toolCalls) {
        const toolMsgId = newMessageId();
        appendMessage({
          id: toolMsgId,
          role: "tool",
          content: "",
          toolName: tc.name,
          toolCallId: tc.id,
          toolResult: null,
          status: "running",
        });
        const output = await executeReadTool(ctx, tc.name, tc.args);
        if (epoch !== threadEpochRef.current) return;
        updateMessage(toolMsgId, {
          content: output,
          toolResult: { output },
          status: "done",
        });
      }
      if (continueAfter && epoch === threadEpochRef.current) {
        void streamRef.current();
      }
    },
    [appendMessage, toolContext, updateMessage]
  );

  const runActionTools = useCallback(
    async (toolCalls: AgentToolCall[], continueAfter = true) => {
      const epoch = threadEpochRef.current;
      const ctx = toolContext();
      const runs = toolCalls.map((tc) => {
        const toolMsgId = newMessageId();
        const token = nextRunToken();
        appendMessage({
          id: toolMsgId,
          role: "tool",
          content: "",
          toolName: tc.name,
          toolCallId: tc.id,
          toolResult: null,
          status: "running",
        });

        return executeApprovalTool(ctx, tc.name, tc.args, token)
          .catch((err: unknown) => ({
            output: err instanceof Error ? err.message : String(err),
            exitCode: 1,
          }))
          .then((result) => ({ result, toolMsgId }));
      });

      const results = await Promise.all(runs);
      if (epoch !== threadEpochRef.current) return;

      for (const { result, toolMsgId } of results) {
        updateMessage(toolMsgId, {
          content: result.output,
          toolResult: { output: result.output, exitCode: result.exitCode },
          status: "done",
        });
      }

      if (continueAfter && epoch === threadEpochRef.current) {
        void streamRef.current();
      }
    },
    [appendMessage, toolContext, updateMessage]
  );

  const streamAssistant = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) {
      setThread((prev) => ({ ...prev, error: "No agent settings configured." }));
      setSettingsOpen(true);
      return;
    }

    const epoch = threadEpochRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setThread((prev) => ({ ...prev, busy: true, error: null }));

    const assistantId = newMessageId();
    appendMessage({
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
    });

    let collectedContent = "";
    let collectedToolCalls: AgentToolCall[] = [];

    try {
      const normalizedSettings = normalizeSettings(s);
      const nativeOllama = isOllamaNative(normalizedSettings);
      const response = await invoke<AgentChatCompletionResponse>("agent_chat_completion", {
        url: completionUrl(normalizedSettings),
        headers: authHeaders(normalizedSettings),
        body: nativeOllama
          ? {
              model: requestModel(normalizedSettings),
              messages: buildOllamaHistory(),
              tools: TOOL_DEFINITIONS,
              stream: false,
              think: true,
            }
          : {
              model: normalizedSettings.model,
              messages: buildHistory(),
              tools: TOOL_DEFINITIONS,
              stream: true,
            },
      });

      if (epoch !== threadEpochRef.current) return;

      if (controller.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.body.slice(0, 300)}`);
      }

      if (nativeOllama) {
        const json = JSON.parse(response.body) as OllamaChatResponse;
        const message = json.message ?? {};
        if (typeof message.content === "string" && message.content) {
          collectedContent = message.content;
          updateMessage(assistantId, { content: collectedContent });
        }
        collectedToolCalls = (message.tool_calls ?? [])
          .map((tc, index): AgentToolCall | null => {
            const name = tc.function?.name;
            if (typeof name !== "string" || !name) return null;
            return {
              id: `call-${assistantId}-${index}`,
              name: name as ToolName,
              args: parseToolArgs(tc.function?.arguments),
            };
          })
          .filter((tc): tc is AgentToolCall => tc !== null && tc.name.length > 0);
      } else {
        const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
        const events = parseSseChunk(response.body);
        for (const evt of events) {
          let json: unknown;
          try {
            json = JSON.parse(evt);
          } catch {
            continue;
          }
          const choice = (json as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          if (typeof delta.content === "string" && delta.content) {
            collectedContent += delta.content;
            updateMessage(assistantId, { content: collectedContent });
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              let entry = toolCallBuffers.get(idx);
              if (!entry) {
                entry = {
                  id: typeof tc.id === "string" ? tc.id : `call-${assistantId}-${idx}`,
                  name: "",
                  args: "",
                };
                toolCallBuffers.set(idx, entry);
              }
              const fn = tc.function as Record<string, unknown> | undefined;
              if (fn) {
                if (typeof fn.name === "string") entry.name += fn.name;
                if (typeof fn.arguments === "string") entry.args += fn.arguments;
              }
              if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
            }
          }
        }

        collectedToolCalls = Array.from(toolCallBuffers.values())
          .map((entry) => ({
            id: entry.id,
            name: entry.name as ToolName,
            args: parseToolArgs(entry.args),
          }))
          .filter((tc) => tc.name.length > 0);
      }
      collectedToolCalls = collectedToolCalls.filter((tc) => tc.name.length > 0);

      if (collectedToolCalls.length > 0) {
        const readCalls = collectedToolCalls.filter((tc) => isReadTool(tc.name));
        const actionCalls = collectedToolCalls.filter((tc) => !isReadTool(tc.name));

        updateMessage(assistantId, {
          content: collectedContent,
          toolCalls: collectedToolCalls,
          status: "running",
        });

        if (readCalls.length > 0) {
          await runReadTools(readCalls, false);
          if (epoch !== threadEpochRef.current) return;
        }

        if (actionCalls.length > 0) {
          await runActionTools(actionCalls, false);
          if (epoch !== threadEpochRef.current) return;
        }

        updateMessage(assistantId, { status: "done" });
        void streamRef.current();
      } else {
        updateMessage(assistantId, { status: "done" });
        setThread((prev) => ({ ...prev, busy: false }));
      }
    } catch (err) {
      if (epoch !== threadEpochRef.current) return;
      if (controller.signal.aborted) {
        updateMessage(assistantId, {
          status: "done",
          content: collectedContent + "\n\n(stopped by user)",
        });
        setThread((prev) => ({ ...prev, busy: false }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      updateMessage(assistantId, { status: "error", content: collectedContent || "" });
      setThread((prev) => ({ ...prev, busy: false, error: message }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [appendMessage, buildHistory, buildOllamaHistory, runActionTools, runReadTools, updateMessage]);

  streamRef.current = streamAssistant;

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      appendMessage({
        id: newMessageId(),
        role: "user",
        content: trimmed,
        status: "done",
      });
      void streamAssistant();
    },
    [appendMessage, streamAssistant]
  );

  const approveToolCall = useCallback((messageId: string) => {
    void messageId;
  }, []);

  const rejectToolCall = useCallback((messageId: string) => {
    void messageId;
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setThread((prev) => ({ ...prev, busy: false }));
  }, []);

  const clearThread = useCallback(() => {
    threadEpochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const nextThread: AgentThread = { messages: [], busy: false, error: null };
    threadRef.current = nextThread;
    setThread(nextThread);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const saveSettings = useCallback(async (next: AgentSettings) => {
    const normalized = normalizeSettings(next);
    setSettings(normalized);
    setSettingsOpen(false);
    await invoke("save_agent_settings", {
      state: {
        provider: normalized.provider,
        model: normalized.model,
        baseUrl: normalized.baseUrl,
        apiKey: normalized.apiKey,
      },
    }).catch(() => undefined);
  }, []);

  return {
    thread,
    settings,
    settingsOpen,
    panes,
    setPanesProvider,
    send,
    approveToolCall,
    rejectToolCall,
    cancel,
    clearThread,
    openSettings,
    closeSettings,
    saveSettings,
  };
}