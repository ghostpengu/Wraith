import { useEffect, useRef, useState } from "react";
import agentIcon from "../assets/ai-agent.svg";
import { AgentMarkdown } from "./AgentMarkdown";
import {
  useAgent,
  type AgentMessage,
} from "./useAgent";
import type { OrchestratorApi } from "./orchestratorTypes";
import type { PaneInfo } from "./tools";
import { AgentSettingsModal } from "./AgentSettingsModal";

const STARTER_PROMPTS = [
  "what's running in the panes?",
  "check the git diff",
  "prompt the codex pane to review recent changes",
];

interface AgentPaneViewProps {
  sessionName: string;
  folder: string | null;
  panes: () => PaneInfo[];
  orchestrator: OrchestratorApi;
}

function statusLabel(status: AgentMessage["status"]): string {
  switch (status) {
    case "streaming":
      return "thinking...";
    case "awaiting-approval":
      return "approval needed";
    case "approved":
      return "thinking...";
    case "running":
      return "thinking...";
    case "rejected":
      return "declined";
    case "error":
      return "error";
    default:
      return "";
  }
}


function MessageBubble({ message }: {
  message: AgentMessage;
}) {
  if (message.role === "user") {
    return (
      <div className="agent-msg agent-msg-user">
        <div className="agent-msg-body">{message.content}</div>
      </div>
    );
  }

  if (message.role === "tool") {
    return null;
  }

  const status = statusLabel(message.status);
  if (!message.content && !status) {
    return null;
  }

  return (
    <div className="agent-msg agent-msg-assistant">
      {message.content && (
        <div className="agent-msg-body">
          <AgentMarkdown text={message.content} />
        </div>
      )}
      {status && <div className="agent-msg-status">{status}</div>}
    </div>
  );
}

export function AgentPaneView({ sessionName, folder, panes, orchestrator }: AgentPaneViewProps) {
  const api = useAgent(folder, sessionName, orchestrator);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.setPanesProvider(panes);
  }, [api, panes]);

  const messages = api.thread.messages;
  const visibleMessages = messages.filter((message) => {
    if (message.role === "tool") return false;
    if (message.role !== "assistant") return true;
    return !!message.content || !!statusLabel(message.status);
  });
  const messagesLen = visibleMessages.length;
  const canClear = messages.length > 0 || !!api.thread.error;
  const lastStatus = messages.length > 0 ? messages[messages.length - 1].status : "done";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messagesLen, lastStatus]);

  const canSend = !api.thread.busy && !!api.settings && draft.trim().length > 0;
  const placeholder = api.settings
    ? "Add a follow up..."
    : "Configure a provider first...";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    api.send(draft);
    setDraft("");
  };

  const sendStarter = (prompt: string) => {
    if (api.thread.busy || !api.settings) return;
    api.send(prompt);
  };

  const modelLabel = api.settings?.model ?? "Set model";
  const providerLabel = api.settings?.provider === "ollama" ? "Ollama" : "Agent";

  return (
    <div className="agent-pane">

      <div className="agent-pane-scroll" ref={scrollRef}>
        <div className="agent-thread-title">{sessionName}</div>
        {messages.length === 0 && (
          <div className="agent-pane-empty">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="agent-empty-prompt"
                disabled={api.thread.busy || !api.settings}
                onClick={() => sendStarter(prompt)}
              >
                {prompt}
              </button>
            ))}
            <p>Ready for the next task.</p>
          </div>
        )}
        {visibleMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
          />
        ))}
        {api.thread.error && (
          <div className="agent-pane-error">{api.thread.error}</div>
        )}
      </div>

      <form className="agent-pane-input-row" onSubmit={onSubmit}>
        <textarea
          className="agent-pane-input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) {
                api.send(draft);
                setDraft("");
              }
            }
          }}
          rows={2}
        />
        <div className="agent-pane-input-footer">
          <div className="agent-pane-input-tools">
            <button
              type="button"
              className="agent-pane-pill"
              onClick={api.openSettings}
              title="Agent settings"
            >
              <img src={agentIcon} alt="" className="agent-pane-pill-icon" />
              <span>{providerLabel}</span>
              <span className="agent-pane-caret">⌄</span>
            </button>
            <button
              type="button"
              className="agent-pane-pill"
              onClick={api.openSettings}
              title={modelLabel}
            >
              <span>{modelLabel}</span>
              <span className="agent-pane-caret">⌄</span>
            </button>
            {api.thread.busy && (
              <button
                type="button"
                className="agent-pane-stop"
                onClick={api.cancel}
                title="Stop"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              className="agent-pane-clear"
              onClick={api.clearThread}
              disabled={!canClear}
              title="Clear AI chat session"
            >
              Clear
            </button>
          </div>
          <button
            type="submit"
            className="agent-pane-send"
            disabled={!canSend}
            aria-label="Send"
            title="Send"
          >
            ↑
          </button>
        </div>
      </form>

      {api.settingsOpen && (
        <AgentSettingsModal
          settings={api.settings}
          onClose={api.closeSettings}
          onSave={api.saveSettings}
        />
      )}
    </div>
  );
}