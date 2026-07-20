import type { Terminal } from "@xterm/xterm";
import { getTheme, type XtermThemeColors } from "./themes";
import type {
  TerminalColorMode,
  TerminalColors,
  ThemeId,
} from "./types";

export interface TerminalLike {
  term: Terminal;
  alive?: boolean;
}

const LIGHT_THEME_IDS = new Set<ThemeId>([
  "light",
  "solarized-light",
  "paper",
]);

export function isLightTheme(themeId: ThemeId): boolean {
  return LIGHT_THEME_IDS.has(themeId);
}

export function applyThemeToDocument(themeId: ThemeId, monoFont?: string): void {
  const theme = getTheme(themeId);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.themeMode = isLightTheme(themeId) ? "light" : "dark";
  root.style.colorScheme = isLightTheme(themeId) ? "light" : "dark";
  for (const [key, value] of Object.entries(theme.css)) {
    root.style.setProperty(key, value);
  }
  if (monoFont) {
    root.style.setProperty("--mono-font", monoFont);
  }
}

/** Resolve effective xterm colors from theme + optional custom overrides. */
export function resolveTerminalTheme(
  themeId: ThemeId,
  colorMode: TerminalColorMode = "theme",
  colors?: TerminalColors
): XtermThemeColors {
  const base = { ...getTheme(themeId).terminal };
  if (colorMode !== "custom" || !colors) return base;
  return {
    ...base,
    foreground: colors.foreground,
    background: colors.background,
    cursor: colors.cursor,
    selectionBackground: colors.selectionBackground,
  };
}

export function applyTerminalTheme(
  term: Terminal,
  themeId: ThemeId,
  colorMode: TerminalColorMode = "theme",
  colors?: TerminalColors
): void {
  try {
    term.options.theme = resolveTerminalTheme(themeId, colorMode, colors);
    term.clearTextureAtlas();
  } catch {
    // ignore
  }
}

export function applyTerminalFont(
  term: Terminal,
  fontFamily: string,
  fontSize: number
): void {
  try {
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.clearTextureAtlas();
  } catch {
    // ignore
  }
}

export interface TerminalAppearanceOpts {
  themeId: ThemeId;
  fontFamily: string;
  fontSize: number;
  colorMode?: TerminalColorMode;
  colors?: TerminalColors;
}

export function applyTerminalAppearance(
  win: TerminalLike,
  opts: TerminalAppearanceOpts,
  fit?: (win: TerminalLike) => void
): void {
  if (win.alive === false) return;
  applyTerminalTheme(
    win.term,
    opts.themeId,
    opts.colorMode ?? "theme",
    opts.colors
  );
  applyTerminalFont(win.term, opts.fontFamily, opts.fontSize);
  fit?.(win);
}

export function applyAppearanceAll(
  windows: TerminalLike[],
  opts: TerminalAppearanceOpts,
  fit?: (win: TerminalLike) => void
): void {
  applyThemeToDocument(opts.themeId, opts.fontFamily);
  for (const win of windows) {
    applyTerminalAppearance(win, opts, fit);
  }
}
