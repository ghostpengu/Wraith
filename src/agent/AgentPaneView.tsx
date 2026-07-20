import { useCallback, useEffect, useRef, useState } from "react";
import agentIcon from "../assets/ai-agent.svg";
import type { AiSettings } from "../settings";
import { AgentMarkdown } from "./AgentMarkdown";
import {
  useAgent,
  type AgentMessage,
} from "./useAgent";
import type { OrchestratorApi } from "./orchestratorTypes";
import type { PaneInfo } from "./tools";
import {
  errorMessage,
  formatElapsed,
  MAX_DICTATION_MS,
  selectRecorderMimeType,
  transcribeDictationBlob,
  validateDictationSettings,
  type DictationStatus,
} from "./dictation";

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
  aiSettings: AiSettings;
  onOpenAiSettings: () => void;
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

export function AgentPaneView({
  sessionName,
  folder,
  panes,
  orchestrator,
  aiSettings,
  onOpenAiSettings,
}: AgentPaneViewProps) {
  const api = useAgent(folder, sessionName, orchestrator, aiSettings);
  const [draft, setDraft] = useState("");
  const [dictationStatus, setDictationStatus] = useState<DictationStatus>("idle");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingCanceledRef = useRef(false);
  const recordingTimerRef = useRef<number | null>(null);
  const maxRecordingTimerRef = useRef<number | null>(null);

  const clearRecordingTimers = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (maxRecordingTimerRef.current !== null) {
      window.clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
  }, []);

  const stopRecordingTracks = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const finishRecordingSession = useCallback(() => {
    clearRecordingTimers();
    stopRecordingTracks();
    mediaRecorderRef.current = null;
    setRecordingSeconds(0);
  }, [clearRecordingTimers, stopRecordingTracks]);

  const insertDictation = useCallback((text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return;

    const input = inputRef.current;
    setDraft((current) => {
      const start = input ? input.selectionStart : current.length;
      const end = input ? input.selectionEnd : current.length;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leadingSpace = before && !/\s$/.test(before) ? " " : "";
      const trailingSpace = after && !/^\s/.test(after) ? " " : "";
      const next = `${before}${leadingSpace}${cleaned}${trailingSpace}${after}`;
      const cursor = before.length + leadingSpace.length + cleaned.length;

      window.requestAnimationFrame(() => {
        const target = inputRef.current;
        target?.focus();
        target?.setSelectionRange(cursor, cursor);
      });

      return next;
    });
  }, []);

  const requireOpenRouterSettings = useCallback((): AiSettings | null => {
    const settings = api.settings;
    const validationError = validateDictationSettings(settings);
    if (validationError) {
      setDictationStatus("error");
      setDictationError(validationError);
      onOpenAiSettings();
      return null;
    }
    return settings;
  }, [api, onOpenAiSettings]);

  const handleRecordedAudio = useCallback(
    async (blob: Blob) => {
      const settings = requireOpenRouterSettings();
      if (!settings) return;
      if (blob.size === 0) {
        setDictationStatus("error");
        setDictationError("No audio was captured.");
        return;
      }

      try {
        setDictationStatus("transcribing");
        setDictationError(null);
        if (settings.dictationStyle !== "verbatim") setDictationStatus("polishing");
        const result = await transcribeDictationBlob(settings, blob, "agent");
        insertDictation(result.text);
        if (result.cleanupError) {
          setDictationStatus("error");
          setDictationError(`Cleanup failed; inserted raw transcript. ${result.cleanupError}`);
        } else {
          setDictationStatus("idle");
        }
      } catch (err) {
        setDictationStatus("error");
        setDictationError(errorMessage(err));
      }
    },
    [insertDictation, requireOpenRouterSettings]
  );

  const stopDictation = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setDictationStatus("transcribing");
    clearRecordingTimers();
    recorder.requestData();
    recorder.stop();
  }, [clearRecordingTimers]);

  const cancelDictation = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    recordingCanceledRef.current = true;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    finishRecordingSession();
    recordingChunksRef.current = [];
    setDictationStatus("idle");
    setDictationError(null);
  }, [finishRecordingSession]);

  const startDictation = useCallback(async () => {
    if (dictationStatus === "recording") {
      stopDictation();
      return;
    }
    if (dictationStatus === "transcribing" || dictationStatus === "polishing") return;

    const settings = requireOpenRouterSettings();
    if (!settings) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setDictationStatus("error");
      setDictationError("Microphone recording is not available in this WebView.");
      return;
    }

    try {
      setDictationStatus("idle");
      setDictationError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mimeType = selectRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingCanceledRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        finishRecordingSession();
        setDictationStatus("error");
        setDictationError("Microphone recording failed.");
      };
      recorder.onstop = () => {
        const canceled = recordingCanceledRef.current;
        const chunks = recordingChunksRef.current;
        const type = recorder.mimeType || mimeType || "audio/webm";
        recordingChunksRef.current = [];
        finishRecordingSession();
        if (canceled) return;
        void handleRecordedAudio(new Blob(chunks, { type }));
      };

      recorder.start();
      setDictationStatus("recording");
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((seconds) => seconds + 1);
      }, 1000);
      maxRecordingTimerRef.current = window.setTimeout(stopDictation, MAX_DICTATION_MS);
    } catch (err) {
      finishRecordingSession();
      setDictationStatus("error");
      setDictationError(errorMessage(err));
    }
  }, [dictationStatus, finishRecordingSession, handleRecordedAudio, requireOpenRouterSettings, stopDictation]);

  const toggleDictation = useCallback(() => {
    if (dictationStatus === "recording") stopDictation();
    else void startDictation();
  }, [dictationStatus, startDictation, stopDictation]);

  useEffect(() => {
    api.setPanesProvider(panes);
  }, [api, panes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root?.contains(document.activeElement)) return;
      if (event.ctrlKey && event.shiftKey && event.key === " ") {
        event.preventDefault();
        toggleDictation();
      } else if (event.key === "Escape" && dictationStatus === "recording") {
        event.preventDefault();
        cancelDictation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelDictation, dictationStatus, toggleDictation]);

  useEffect(() => {
    return () => {
      recordingCanceledRef.current = true;
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      mediaRecorderRef.current = null;
      recordingChunksRef.current = [];
      clearRecordingTimers();
      stopRecordingTracks();
    };
  }, [clearRecordingTimers, stopRecordingTracks]);

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
  const dictationBusy = dictationStatus === "transcribing" || dictationStatus === "polishing";
  const dictationStatusText =
    dictationStatus === "recording"
      ? `recording ${formatElapsed(recordingSeconds)}`
      : dictationStatus === "transcribing"
        ? "transcribing"
        : dictationStatus === "polishing"
          ? "polishing"
          : dictationStatus === "error"
            ? dictationError
            : null;
  const dictationTitle =
    dictationStatus === "recording"
      ? "Stop dictation"
      : dictationBusy
        ? "Dictation is processing"
        : "Dictate (Ctrl+Shift+Space)";

  return (
    <div className="agent-pane" ref={rootRef}>

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
          ref={inputRef}
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
              onClick={onOpenAiSettings}
              title="AI settings"
            >
              <img src={agentIcon} alt="" className="agent-pane-pill-icon" />
              <span>{providerLabel}</span>
              <span className="agent-pane-caret">⌄</span>
            </button>
            <button
              type="button"
              className="agent-pane-pill"
              onClick={onOpenAiSettings}
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
          <div className="agent-pane-input-actions">
            {dictationStatusText && (
              <span className={`agent-pane-dictation-status ${dictationStatus}`}>
                {dictationStatusText}
              </span>
            )}
            <button
              type="button"
              className={`agent-pane-mic ${dictationStatus}`}
              disabled={dictationBusy}
              aria-label={dictationTitle}
              aria-pressed={dictationStatus === "recording"}
              title={dictationTitle}
              onClick={toggleDictation}
            >
              <span aria-hidden="true">{dictationStatus === "recording" ? "■" : "🎙"}</span>
            </button>
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
        </div>
      </form>

    </div>
  );
}



