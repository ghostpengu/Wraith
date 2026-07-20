import { useEffect, useMemo, useState } from "react";
import type { AppSettingsApi } from "./useAppSettings";
import {
  AI_PROVIDER_PRESETS,
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type AiProvider,
  type AiSettings,
  type DictationStyle,
  type SettingsTab,
  type TerminalColors,
} from "./types";
import {
  ensureFontStackReady,
  getSelectableFonts,
  preloadWebFonts,
  refreshFontDetection,
  type FontPreset,
} from "./fonts";
import { getTheme, THEME_LIST } from "./themes";

interface AppSettingsModalProps {
  api: AppSettingsApi;
}

export function AppSettingsModal({ api }: AppSettingsModalProps) {
  const { settings, settingsTab, setSettingsTab, closeSettings } = api;
  const [fontOptions, setFontOptions] = useState<FontPreset[]>(() =>
    getSelectableFonts()
  );
  const [fontsReady, setFontsReady] = useState(false);

  // AI form is buffered until Save (hybrid strategy).
  const [provider, setProvider] = useState<AiProvider>(settings.ai.provider);
  const [model, setModel] = useState(settings.ai.model);
  const [baseUrl, setBaseUrl] = useState(settings.ai.baseUrl);
  const [apiKey, setApiKey] = useState(settings.ai.apiKey);
  const [dictationStyle, setDictationStyle] = useState<DictationStyle>(
    settings.ai.dictationStyle
  );
  const [confirmClosePane, setConfirmClosePane] = useState(
    settings.general.confirmClosePane
  );
  const [confirmCloseSession, setConfirmCloseSession] = useState(
    settings.general.confirmCloseSession
  );
  const [savingAi, setSavingAi] = useState(false);
  const [savingGeneral, setSavingGeneral] = useState(false);

  useEffect(() => {
    setProvider(settings.ai.provider);
    setModel(settings.ai.model);
    setBaseUrl(settings.ai.baseUrl);
    setApiKey(settings.ai.apiKey);
    setDictationStyle(settings.ai.dictationStyle);
    setConfirmClosePane(settings.general.confirmClosePane);
    setConfirmCloseSession(settings.general.confirmCloseSession);
  }, [settings]);

  // Detect system fonts + preload Google Fonts when Terminal tab opens.
  useEffect(() => {
    if (settingsTab !== "terminal") return;
    let cancelled = false;
    void (async () => {
      await preloadWebFonts().catch(() => undefined);
      if (cancelled) return;
      refreshFontDetection();
      setFontOptions(getSelectableFonts());
      setFontsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsTab]);

  const selectedFontStack = useMemo(() => {
    const match = fontOptions.find(
      (p) => p.stack === settings.terminal.fontFamily
    );
    return match?.stack ?? fontOptions[0]?.stack ?? settings.terminal.fontFamily;
  }, [fontOptions, settings.terminal.fontFamily]);

  const onProviderChange = (next: AiProvider) => {
    setProvider(next);
    const preset = AI_PROVIDER_PRESETS[next];
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  };

  const onSaveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAi(true);
    try {
      const next: AiSettings = {
        provider,
        model,
        baseUrl,
        apiKey,
        dictationStyle,
      };
      await api.setAiSettings(next);
    } finally {
      setSavingAi(false);
    }
  };

  const onSaveGeneral = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGeneral(true);
    try {
      await api.setGeneralSettings({
        confirmClosePane,
        confirmCloseSession,
      });
    } finally {
      setSavingGeneral(false);
    }
  };

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "terminal", label: "Terminal" },
    { id: "ai", label: "AI" },
    { id: "general", label: "General" },
  ];

  return (
    <div className="agent-modal-backdrop settings-modal-backdrop" onClick={closeSettings}>
      <div
        className="agent-modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header className="agent-modal-header">
          <span className="agent-modal-title">Settings</span>
          <button type="button" className="agent-modal-close" onClick={closeSettings}>
            ×
          </button>
        </header>

        <div className="settings-modal-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={
                  settingsTab === tab.id
                    ? "settings-tab settings-tab-active"
                    : "settings-tab"
                }
                onClick={() => setSettingsTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {settingsTab === "appearance" && (
              <div className="settings-section">
                <p className="settings-section-hint">
                  Theme applies immediately to the app chrome and terminals.
                </p>
                <div className="theme-grid">
                  {THEME_LIST.map((theme) => {
                    const selected = settings.appearance.theme === theme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        className={
                          selected
                            ? "theme-card theme-card-selected"
                            : "theme-card"
                        }
                        onClick={() => api.setTheme(theme.id)}
                      >
                        <span
                          className="theme-swatch"
                          style={{
                            background: `linear-gradient(135deg, ${theme.css["--bg"]} 50%, ${theme.css["--sidebar-bg"]} 50%)`,
                            borderColor: theme.css["--tile-border"],
                          }}
                        >
                          <span
                            className="theme-swatch-accent"
                            style={{ background: theme.css["--accent"] }}
                          />
                        </span>
                        <span className="theme-card-label">{theme.label}</span>
                        <span className="theme-card-desc">{theme.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {settingsTab === "terminal" && (
              <div className="settings-section">
                <p className="settings-section-hint">
                  Font changes apply to all open terminals. Toolbar zoom shortcuts still work.
                </p>
                <div className="agent-modal-row">
                  <label className="agent-modal-label" htmlFor="settings-font-family">
                    Font family
                  </label>
                  <select
                    id="settings-font-family"
                    className="agent-modal-input settings-select settings-font-select"
                    style={{ fontFamily: selectedFontStack }}
                    value={selectedFontStack}
                    disabled={!fontsReady && fontOptions.length === 0}
                    onChange={(e) => {
                      const stack = e.target.value;
                      void ensureFontStackReady(stack).finally(() => {
                        api.setFontFamily(stack);
                      });
                    }}
                  >
                    {fontOptions.map((preset) => (
                      <option
                        key={preset.id}
                        value={preset.stack}
                        style={{ fontFamily: preset.stack }}
                      >
                        {preset.label}
                        {preset.google ? " · web" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="settings-font-note">
                    Showing fonts available on this PC plus free web fonts (loaded
                    automatically). Unavailable system fonts are hidden.
                  </p>
                </div>
                <div className="agent-modal-row">
                  <label className="agent-modal-label" htmlFor="settings-font-size">
                    Font size
                  </label>
                  <div className="settings-font-size-row">
                    <input
                      id="settings-font-size"
                      className="settings-range"
                      type="range"
                      min={MIN_FONT_SIZE}
                      max={MAX_FONT_SIZE}
                      value={settings.terminal.fontSize}
                      onChange={(e) =>
                        api.setFontSize(Number.parseInt(e.target.value, 10))
                      }
                    />
                    <span className="settings-font-size-value">
                      {settings.terminal.fontSize}px
                    </span>
                    <button
                      type="button"
                      className="agent-modal-cancel settings-reset-btn"
                      onClick={() => api.setFontSize(DEFAULT_FONT_SIZE)}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="agent-modal-row">
                  <label className="agent-modal-label">Terminal colors</label>
                  <div className="agent-modal-radio-row">
                    <label className="agent-modal-radio">
                      <input
                        type="radio"
                        name="terminal-color-mode"
                        checked={settings.terminal.colorMode === "theme"}
                        onChange={() => api.setTerminalColorMode("theme")}
                      />
                      <span>Match theme</span>
                    </label>
                    <label className="agent-modal-radio">
                      <input
                        type="radio"
                        name="terminal-color-mode"
                        checked={settings.terminal.colorMode === "custom"}
                        onChange={() => api.setTerminalColorMode("custom")}
                      />
                      <span>Custom</span>
                    </label>
                  </div>
                  <p className="settings-font-note">
                    {settings.terminal.colorMode === "theme"
                      ? "Terminal text follows the selected appearance theme."
                      : "Custom colors override the theme for terminal panes only."}
                  </p>
                </div>

                {settings.terminal.colorMode === "custom" && (
                  <div className="agent-modal-row">
                    <div className="settings-color-grid">
                      {(
                        [
                          ["foreground", "Text"],
                          ["background", "Background"],
                          ["cursor", "Cursor"],
                          ["selectionBackground", "Selection"],
                        ] as const satisfies ReadonlyArray<
                          [keyof TerminalColors, string]
                        >
                      ).map(([key, label]) => {
                        const value = settings.terminal.colors[key];
                        return (
                          <label key={key} className="settings-color-field">
                            <span className="settings-color-label">{label}</span>
                            <span className="settings-color-controls">
                              <input
                                type="color"
                                className="settings-color-swatch"
                                value={value.length === 7 ? value : value.slice(0, 7)}
                                onChange={(e) =>
                                  api.setTerminalColor(key, e.target.value)
                                }
                                aria-label={`${label} color`}
                              />
                              <input
                                type="text"
                                className="agent-modal-input settings-color-hex"
                                value={value}
                                spellCheck={false}
                                onChange={(e) => {
                                  const next = e.target.value.trim();
                                  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(next)) {
                                    api.setTerminalColor(key, next);
                                  }
                                }}
                              />
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <div
                      className="settings-color-preview"
                      style={{
                        background: settings.terminal.colors.background,
                        color: settings.terminal.colors.foreground,
                        borderColor: settings.terminal.colors.selectionBackground,
                      }}
                    >
                      <span
                        className="settings-color-preview-cursor"
                        style={{ background: settings.terminal.colors.cursor }}
                      />
                      <code style={{ fontFamily: settings.terminal.fontFamily }}>
                        PS&gt; echo &quot;Hello from Wraith&quot;
                      </code>
                    </div>
                    <button
                      type="button"
                      className="agent-modal-cancel settings-reset-btn"
                      onClick={() => api.resetTerminalColorsFromTheme()}
                    >
                      Reset from {getTheme(settings.appearance.theme).label}
                    </button>
                  </div>
                )}
              </div>
            )}

            {settingsTab === "ai" && (
              <form className="settings-section" onSubmit={onSaveAi}>
                <p className="settings-section-hint">
                  Provider and API key for the in-app agent and dictation. Save to persist.
                </p>
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
                  <label className="agent-modal-label" htmlFor="settings-base-url">
                    Base URL
                  </label>
                  <input
                    id="settings-base-url"
                    className="agent-modal-input"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={
                      provider === "ollama" ? "https://ollama.com/api" : "https://.../v1"
                    }
                    spellCheck={false}
                  />
                </div>

                <div className="agent-modal-row">
                  <label className="agent-modal-label" htmlFor="settings-model">
                    Model
                  </label>
                  <input
                    id="settings-model"
                    className="agent-modal-input"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={AI_PROVIDER_PRESETS[provider].model}
                    spellCheck={false}
                  />
                </div>

                <div className="agent-modal-row">
                  <label className="agent-modal-label" htmlFor="settings-api-key">
                    API key
                  </label>
                  <input
                    id="settings-api-key"
                    className="agent-modal-input"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      provider === "ollama" ? "(Ollama Cloud key)" : "sk-or-…"
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>

                <div className="agent-modal-row">
                  <label className="agent-modal-label">Dictation style</label>
                  <div className="agent-modal-radio-row agent-modal-radio-row-wrap">
                    <label className="agent-modal-radio">
                      <input
                        type="radio"
                        name="dictation-style"
                        value="clean"
                        checked={dictationStyle === "clean"}
                        onChange={() => setDictationStyle("clean")}
                      />
                      <span>Clean</span>
                    </label>
                    <label className="agent-modal-radio">
                      <input
                        type="radio"
                        name="dictation-style"
                        value="command-safe"
                        checked={dictationStyle === "command-safe"}
                        onChange={() => setDictationStyle("command-safe")}
                      />
                      <span>Command-safe</span>
                    </label>
                    <label className="agent-modal-radio">
                      <input
                        type="radio"
                        name="dictation-style"
                        value="verbatim"
                        checked={dictationStyle === "verbatim"}
                        onChange={() => setDictationStyle("verbatim")}
                      />
                      <span>Verbatim</span>
                    </label>
                  </div>
                </div>

                <footer className="agent-modal-footer settings-panel-footer">
                  <button type="submit" className="agent-modal-save" disabled={savingAi}>
                    {savingAi ? "Saving…" : "Save AI settings"}
                  </button>
                </footer>
              </form>
            )}

            {settingsTab === "general" && (
              <form className="settings-section" onSubmit={onSaveGeneral}>
                <p className="settings-section-hint">
                  Quality-of-life options. Window size is restored automatically on launch.
                </p>
                <div className="agent-modal-row">
                  <label className="agent-modal-radio settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={confirmClosePane}
                      onChange={(e) => setConfirmClosePane(e.target.checked)}
                    />
                    <span>Confirm before closing a pane</span>
                  </label>
                </div>
                <div className="agent-modal-row">
                  <label className="agent-modal-radio settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={confirmCloseSession}
                      onChange={(e) => setConfirmCloseSession(e.target.checked)}
                    />
                    <span>Confirm before closing a session</span>
                  </label>
                </div>
                <footer className="agent-modal-footer settings-panel-footer">
                  <button
                    type="submit"
                    className="agent-modal-save"
                    disabled={savingGeneral}
                  >
                    {savingGeneral ? "Saving…" : "Save general"}
                  </button>
                </footer>
              </form>
            )}
          </div>
        </div>

        <footer className="agent-modal-footer settings-modal-footer">
          <button type="button" className="agent-modal-cancel" onClick={closeSettings}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
