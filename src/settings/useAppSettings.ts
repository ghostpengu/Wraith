import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  clearLegacyFontSize,
  DEFAULT_APP_SETTINGS,
  DEFAULT_TERMINAL_COLORS,
  normalizeAppSettings,
  readLegacyFontSize,
  type AiSettings,
  type AppSettings,
  type GeneralSettings,
  type TerminalColorMode,
  type TerminalColors,
  type ThemeId,
} from "./types";
import { applyThemeToDocument } from "./applyAppearance";
import {
  ensureFontStackReady,
  preloadWebFonts,
  resolveUsableFontStack,
} from "./fonts";
import { getTheme } from "./themes";

const SAVE_DEBOUNCE_MS = 300;

function toPersistedPayload(settings: AppSettings): AppSettings {
  return {
    version: 1,
    appearance: { ...settings.appearance },
    terminal: { ...settings.terminal },
    ai: { ...settings.ai },
    general: {
      confirmClosePane: settings.general.confirmClosePane,
      confirmCloseSession: settings.general.confirmCloseSession,
      sidebarCollapsed: settings.general.sidebarCollapsed,
      sidebarWidth: settings.general.sidebarWidth,
      window: { ...settings.general.window },
    },
  };
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "appearance" | "terminal" | "ai" | "general"
  >("appearance");

  const settingsRef = useRef(settings);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyRef = useRef(false);

  settingsRef.current = settings;

  const persist = useCallback(async (next: AppSettings) => {
    try {
      await invoke("save_app_settings", { state: toPersistedPayload(next) });
    } catch {
      // ignore persistence failures
    }
  }, []);

  const schedulePersist = useCallback(
    (next: AppSettings) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void persist(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist]
  );

  const flushPersist = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await persist(settingsRef.current);
  }, [persist]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await invoke<unknown>("load_app_settings");
        if (cancelled) return;
        let next = normalizeAppSettings(raw);

        // Frontend-only migration for localStorage font size.
        const legacySize = readLegacyFontSize();
        if (legacySize !== null && next.terminal.fontSize === DEFAULT_APP_SETTINGS.terminal.fontSize) {
          // Prefer legacy size when settings still has the default size and
          // settings.json may have been freshly created without a user font.
          // Always apply legacy if present on first ready so zoom survives upgrade.
          next = {
            ...next,
            terminal: { ...next.terminal, fontSize: legacySize },
          };
          clearLegacyFontSize();
          void persist(next);
        } else if (legacySize !== null) {
          clearLegacyFontSize();
        }

        // Preload Google Fonts, then ensure the saved face is actually ready.
        await preloadWebFonts().catch(() => undefined);
        const usable = resolveUsableFontStack(next.terminal.fontFamily);
        await ensureFontStackReady(usable).catch(() => undefined);
        if (usable !== next.terminal.fontFamily) {
          next = {
            ...next,
            terminal: { ...next.terminal, fontFamily: usable },
          };
          void persist(next);
        }

        setSettings(next);
        settingsRef.current = next;
        applyThemeToDocument(next.appearance.theme, next.terminal.fontFamily);
      } catch {
        if (cancelled) return;
        applyThemeToDocument(
          DEFAULT_APP_SETTINGS.appearance.theme,
          DEFAULT_APP_SETTINGS.terminal.fontFamily
        );
      } finally {
        if (!cancelled) {
          readyRef.current = true;
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [persist]);

  const updateSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings, options?: { persist?: boolean }) => {
      setSettings((prev) => {
        const next = updater(prev);
        settingsRef.current = next;
        if (options?.persist !== false) {
          schedulePersist(next);
        }
        return next;
      });
    },
    [schedulePersist]
  );

  const setTheme = useCallback(
    (theme: ThemeId) => {
      updateSettings((prev) => {
        const next = {
          ...prev,
          appearance: { ...prev.appearance, theme },
        };
        applyThemeToDocument(theme, next.terminal.fontFamily);
        return next;
      });
    },
    [updateSettings]
  );

  const setFontSize = useCallback(
    (fontSize: number) => {
      updateSettings((prev) => ({
        ...prev,
        terminal: { ...prev.terminal, fontSize },
      }));
    },
    [updateSettings]
  );

  const setFontFamily = useCallback(
    (fontFamily: string) => {
      void (async () => {
        const ready = await ensureFontStackReady(fontFamily).catch(
          () => fontFamily
        );
        updateSettings((prev) => {
          const next = {
            ...prev,
            terminal: { ...prev.terminal, fontFamily: ready },
          };
          applyThemeToDocument(next.appearance.theme, ready);
          return next;
        });
      })();
    },
    [updateSettings]
  );

  const setTerminalColorMode = useCallback(
    (colorMode: TerminalColorMode) => {
      updateSettings((prev) => {
        // When switching to custom for the first time, seed from the active theme.
        if (colorMode === "custom" && prev.terminal.colorMode !== "custom") {
          const themeColors = getTheme(prev.appearance.theme).terminal;
          return {
            ...prev,
            terminal: {
              ...prev.terminal,
              colorMode,
              colors: {
                foreground: themeColors.foreground,
                background: themeColors.background,
                cursor: themeColors.cursor,
                selectionBackground:
                  themeColors.selectionBackground ??
                  DEFAULT_TERMINAL_COLORS.selectionBackground,
              },
            },
          };
        }
        return {
          ...prev,
          terminal: { ...prev.terminal, colorMode },
        };
      });
    },
    [updateSettings]
  );

  const setTerminalColor = useCallback(
    (key: keyof TerminalColors, value: string) => {
      updateSettings((prev) => ({
        ...prev,
        terminal: {
          ...prev.terminal,
          colorMode: "custom",
          colors: {
            ...prev.terminal.colors,
            [key]: value,
          },
        },
      }));
    },
    [updateSettings]
  );

  const resetTerminalColorsFromTheme = useCallback(() => {
    updateSettings((prev) => {
      const themeColors = getTheme(prev.appearance.theme).terminal;
      return {
        ...prev,
        terminal: {
          ...prev.terminal,
          colorMode: "custom",
          colors: {
            foreground: themeColors.foreground,
            background: themeColors.background,
            cursor: themeColors.cursor,
            selectionBackground:
              themeColors.selectionBackground ??
              DEFAULT_TERMINAL_COLORS.selectionBackground,
          },
        },
      };
    });
  }, [updateSettings]);

  const setAiSettings = useCallback(
    async (ai: AiSettings) => {
      const next: AppSettings = {
        ...settingsRef.current,
        ai: { ...ai },
      };
      settingsRef.current = next;
      setSettings(next);
      await persist(next);
    },
    [persist]
  );

  const setGeneralSettings = useCallback(
    async (general: Partial<GeneralSettings>) => {
      const next: AppSettings = {
        ...settingsRef.current,
        general: {
          ...settingsRef.current.general,
          ...general,
          window: general.window
            ? { ...general.window }
            : { ...settingsRef.current.general.window },
        },
      };
      settingsRef.current = next;
      setSettings(next);
      await persist(next);
    },
    [persist]
  );

  const setSidebarCollapsed = useCallback(
    (sidebarCollapsed: boolean) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          sidebarCollapsed,
        },
      }));
    },
    [updateSettings]
  );

  const setSidebarWidth = useCallback(
    (sidebarWidth: number) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          sidebarWidth,
        },
      }));
    },
    [updateSettings]
  );

  /** Live resize: collapsed + width in one write (avoids double save thrash). */
  const setSidebarLayout = useCallback(
    (layout: { collapsed: boolean; width?: number }) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          sidebarCollapsed: layout.collapsed,
          sidebarWidth:
            layout.width !== undefined
              ? layout.width
              : prev.general.sidebarWidth,
        },
      }));
    },
    [updateSettings]
  );

  const setWindowGeometry = useCallback(
    (window: AppSettings["general"]["window"]) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          window: { ...window },
        },
      }));
    },
    [updateSettings]
  );

  const openSettings = useCallback(
    (tab: "appearance" | "terminal" | "ai" | "general" = "appearance") => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    },
    []
  );

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return {
    settings,
    settingsRef,
    ready,
    settingsOpen,
    settingsTab,
    setSettingsTab,
    openSettings,
    closeSettings,
    setTheme,
    setFontSize,
    setFontFamily,
    setTerminalColorMode,
    setTerminalColor,
    resetTerminalColorsFromTheme,
    setAiSettings,
    setGeneralSettings,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarLayout,
    setWindowGeometry,
    updateSettings,
    flushPersist,
  };
}

export type AppSettingsApi = ReturnType<typeof useAppSettings>;
