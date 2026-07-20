export type ThemeId =
  | "vscode-dark"
  | "midnight"
  | "one-dark"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "gruvbox-dark"
  | "monokai"
  | "solarized-dark"
  | "forest"
  | "ember"
  | "light"
  | "solarized-light"
  | "paper"
  | "high-contrast";

export type DictationStyle = "clean" | "verbatim" | "command-safe";

export type AiProvider = "openrouter" | "ollama";

export interface AiSettings {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  dictationStyle: DictationStyle;
}

export type TerminalColorMode = "theme" | "custom";

/** Core xterm text/surface colors when colorMode is "custom". */
export interface TerminalColors {
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
}

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  /** "theme" follows the app theme; "custom" uses `colors`. */
  colorMode: TerminalColorMode;
  colors: TerminalColors;
}

export const DEFAULT_TERMINAL_COLORS: TerminalColors = {
  foreground: "#cccccc",
  background: "#1e1e1e",
  cursor: "#ffffff",
  selectionBackground: "#264f78",
};

export interface WindowGeometry {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
}

export interface GeneralSettings {
  confirmClosePane: boolean;
  confirmCloseSession: boolean;
  sidebarCollapsed: boolean;
  /** Expanded sidebar width in px (ignored while collapsed). */
  sidebarWidth: number;
  window: WindowGeometry;
}

export const DEFAULT_SIDEBAR_WIDTH = 220;
export const MIN_SIDEBAR_WIDTH = 160;
export const MAX_SIDEBAR_WIDTH = 420;
export const COLLAPSED_SIDEBAR_WIDTH = 48;
/** Drag width below this snaps the sidebar closed. */
export const SIDEBAR_COLLAPSE_THRESHOLD = 120;

export interface AppearanceSettings {
  theme: ThemeId;
}

export interface AppSettings {
  version: 1;
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  ai: AiSettings;
  general: GeneralSettings;
}

export type SettingsTab = "appearance" | "terminal" | "ai" | "general";

export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export const DEFAULT_FONT_FAMILY =
  '"Cascadia Code", Consolas, "Courier New", monospace';

// Font preset catalog lives in ./fonts.ts (detection + Google Font loading).
export {
  FONT_FAMILY_PRESETS,
  FONT_PRESETS,
  type FontPreset,
} from "./fonts";

export const AI_PROVIDER_PRESETS: Record<
  AiProvider,
  { baseUrl: string; model: string }
> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-sonnet",
  },
  ollama: {
    baseUrl: "https://ollama.com/api",
    model: "qwen2.5:32b",
  },
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  appearance: {
    theme: "vscode-dark",
  },
  terminal: {
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    colorMode: "theme",
    colors: { ...DEFAULT_TERMINAL_COLORS },
  },
  ai: {
    provider: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    dictationStyle: "clean",
  },
  general: {
    confirmClosePane: true,
    confirmCloseSession: true,
    sidebarCollapsed: false,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    window: {
      width: 900,
      height: 700,
      x: null,
      y: null,
    },
  },
};

const THEME_IDS: ThemeId[] = [
  "vscode-dark",
  "midnight",
  "one-dark",
  "dracula",
  "nord",
  "tokyo-night",
  "catppuccin-mocha",
  "gruvbox-dark",
  "monokai",
  "solarized-dark",
  "forest",
  "ember",
  "light",
  "solarized-light",
  "paper",
  "high-contrast",
];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampFontSize(size: number): number {
  return clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE);
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.includes(value as ThemeId);
}

function isDictationStyle(value: unknown): value is DictationStyle {
  return value === "clean" || value === "verbatim" || value === "command-safe";
}

function isAiProvider(value: unknown): value is AiProvider {
  return value === "openrouter" || value === "ollama";
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value.trim());
}

export function asHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return fallback;
  // Normalize short #rgb → #rrggbb for color inputs.
  if (trimmed.length === 4) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function normalizeTerminalColors(
  raw: Record<string, unknown>,
  fallback: TerminalColors
): TerminalColors {
  return {
    foreground: asHexColor(raw.foreground, fallback.foreground),
    background: asHexColor(raw.background, fallback.background),
    cursor: asHexColor(raw.cursor, fallback.cursor),
    selectionBackground: asHexColor(
      raw.selectionBackground,
      fallback.selectionBackground
    ),
  };
}

/** Normalize raw JSON from the backend into a full AppSettings object. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const d = DEFAULT_APP_SETTINGS;
  if (!raw || typeof raw !== "object") return structuredClone(d);

  const obj = raw as Record<string, unknown>;
  const appearance =
    obj.appearance && typeof obj.appearance === "object"
      ? (obj.appearance as Record<string, unknown>)
      : {};
  const terminal =
    obj.terminal && typeof obj.terminal === "object"
      ? (obj.terminal as Record<string, unknown>)
      : {};
  const ai =
    obj.ai && typeof obj.ai === "object"
      ? (obj.ai as Record<string, unknown>)
      : {};
  const general =
    obj.general && typeof obj.general === "object"
      ? (obj.general as Record<string, unknown>)
      : {};
  const window =
    general.window && typeof general.window === "object"
      ? (general.window as Record<string, unknown>)
      : {};

  const provider = isAiProvider(ai.provider) ? ai.provider : d.ai.provider;
  const preset = AI_PROVIDER_PRESETS[provider];

  return {
    version: 1,
    appearance: {
      theme: isThemeId(appearance.theme) ? appearance.theme : d.appearance.theme,
    },
    terminal: {
      fontFamily: asString(terminal.fontFamily, d.terminal.fontFamily),
      fontSize: clampFontSize(
        Math.round(asNumber(terminal.fontSize, d.terminal.fontSize))
      ),
      colorMode: terminal.colorMode === "custom" ? "custom" : "theme",
      colors: normalizeTerminalColors(
        terminal.colors && typeof terminal.colors === "object"
          ? (terminal.colors as Record<string, unknown>)
          : {},
        d.terminal.colors
      ),
    },
    ai: {
      provider,
      model: asString(ai.model, preset.model),
      baseUrl: asString(ai.baseUrl, preset.baseUrl),
      apiKey: typeof ai.apiKey === "string" ? ai.apiKey : "",
      dictationStyle: isDictationStyle(ai.dictationStyle)
        ? ai.dictationStyle
        : d.ai.dictationStyle,
    },
    general: {
      confirmClosePane: asBool(
        general.confirmClosePane,
        d.general.confirmClosePane
      ),
      confirmCloseSession: asBool(
        general.confirmCloseSession,
        d.general.confirmCloseSession
      ),
      sidebarCollapsed: asBool(
        general.sidebarCollapsed,
        d.general.sidebarCollapsed
      ),
      sidebarWidth: clamp(
        Math.round(asNumber(general.sidebarWidth, d.general.sidebarWidth)),
        MIN_SIDEBAR_WIDTH,
        MAX_SIDEBAR_WIDTH
      ),
      window: {
        width: clamp(Math.round(asNumber(window.width, d.general.window.width)), 400, 10000),
        height: clamp(
          Math.round(asNumber(window.height, d.general.window.height)),
          300,
          10000
        ),
        x: asNullableNumber(window.x),
        y: asNullableNumber(window.y),
      },
    },
  };
}

/** Migrate font size from legacy localStorage if present (frontend-only). */
export function readLegacyFontSize(): number | null {
  try {
    const raw = localStorage.getItem("wraith:font-size");
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return clampFontSize(parsed);
  } catch {
    return null;
  }
}

export function clearLegacyFontSize(): void {
  try {
    localStorage.removeItem("wraith:font-size");
  } catch {
    // ignore
  }
}
