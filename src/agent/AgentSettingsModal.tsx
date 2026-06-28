import { useEffect, useState } from "react";
import type { AgentSettings } from "./useAgent";

interface AgentSettingsModalProps {
  settings: AgentSettings | null;
  onClose: () => void;
  onSave: (settings: AgentSettings) => Promise<void>;
}

const PRESETS: Record<AgentSettings["provider"], { baseUrl: string; model: string }> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-sonnet",
  },
  ollama: {
    baseUrl: "https://ollama.com/api",
    model: "qwen2.5:32b",
  },
};

export function AgentSettingsModal({ settings, onClose, onSave }: AgentSettingsModalProps) {
  const [provider, setProvider] = useState<AgentSettings["provider"]>(
    settings?.provider ?? "openrouter"
  );
  const [model, setModel] = useState(settings?.model ?? PRESETS.openrouter.model);
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? PRESETS.openrouter.baseUrl);
  const [apiKey, setApiKey] = useState(settings?.apiKey ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setProvider(settings.provider);
      setModel(settings.model);
      setBaseUrl(settings.baseUrl);
      setApiKey(settings.apiKey);
    }
  }, [settings]);

  const onProviderChange = (next: AgentSettings["provider"]) => {
    setProvider(next);
    const preset = PRESETS[next];
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ provider, model, baseUrl, apiKey });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agent-modal-backdrop" onClick={onClose}>
      <form
        className="agent-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
      >
        <header className="agent-modal-header">
          <span className="agent-modal-title">Agent settings</span>
          <button type="button" className="agent-modal-close" onClick={onClose}>×</button>
        </header>

        <div className="agent-modal-row">
          <label className="agent-modal-label">Provider</label>
          <div className="agent-modal-radio-row">
            <label className="agent-modal-radio">
              <input
                type="radio"
                name="provider"
                value="openrouter"
                checked={provider === "openrouter"}
                onChange={() => onProviderChange("openrouter")}
              />
              <span>OpenRouter</span>
            </label>
            <label className="agent-modal-radio">
              <input
                type="radio"
                name="provider"
                value="ollama"
                checked={provider === "ollama"}
                onChange={() => onProviderChange("ollama")}
              />
              <span>Ollama Cloud</span>
            </label>
          </div>
        </div>

        <div className="agent-modal-row">
          <label className="agent-modal-label" htmlFor="agent-base-url">Base URL</label>
          <input
            id="agent-base-url"
            className="agent-modal-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === "ollama" ? "https://ollama.com/api" : "https://.../v1"}
            spellCheck={false}
          />
        </div>

        <div className="agent-modal-row">
          <label className="agent-modal-label" htmlFor="agent-model">Model</label>
          <input
            id="agent-model"
            className="agent-modal-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={PRESETS[provider].model}
            spellCheck={false}
          />
        </div>

        <div className="agent-modal-row">
          <label className="agent-modal-label" htmlFor="agent-key">API key</label>
          <input
            id="agent-key"
            className="agent-modal-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === "ollama" ? "(Ollama Cloud key)" : "sk-or-…"}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <footer className="agent-modal-footer">
          <button type="button" className="agent-modal-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="agent-modal-save" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}