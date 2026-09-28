import type { ThemeId } from "./types";

export type CssVarMap = Record<string, string>;

export interface XtermThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface ThemePreset {
  id: ThemeId;
  label: string;
  description: string;
  css: CssVarMap;
  terminal: XtermThemeColors;
}

/** Full set of CSS variables that themes must define. */
export const THEME_CSS_KEYS = [
  "--bg",
  "--sidebar-bg",
  "--sidebar-border",
  "--accent",
  "--accent-hover",
  "--text",
  "--text-dim",
  "--danger",
  "--toolbar-bg",
  "--pane-header-bg",
  "--tile-border",
  "--tile-border-active",
  "--tile-border-target",
  "--divider",
] as const;

function theme(
  id: ThemeId,
  label: string,
  description: string,
  css: CssVarMap,
  terminal: XtermThemeColors
): ThemePreset {
  return { id, label, description, css, terminal };
}

export const THEME_PRESETS: Record<ThemeId, ThemePreset> = {
  wraith: theme(
    "wraith",
    "Wraith",
    "Quiet charcoal with a soft mint accent.",
    {
      "--bg": "#0d1216",
      "--sidebar-bg": "#12191e",
      "--sidebar-border": "#263239",
      "--accent": "#187f70",
      "--accent-hover": "#229984",
      "--text": "#e1e9e9",
      "--text-dim": "#91a1a5",
      "--danger": "#df777c",
      "--toolbar-bg": "#11181d",
      "--pane-header-bg": "#151d22",
      "--tile-border": "#29373e",
      "--tile-border-active": "#58aa97",
      "--tile-border-target": "#a2c8b3",
      "--divider": "rgba(225, 233, 233, 0.08)",
    },
    {
      background: "#0d1216",
      foreground: "#e1e9e9",
      cursor: "#78d8bd",
      selectionBackground: "#285348",
    }
  ),
  "vscode-dark": theme(
    "vscode-dark",
    "VS Code Dark",
    "Classic VS Code dark chrome.",
    {
      "--bg": "#1e1e1e",
      "--sidebar-bg": "#252526",
      "--sidebar-border": "#333333",
      "--accent": "#0e639c",
      "--accent-hover": "#1177bb",
      "--text": "#cccccc",
      "--text-dim": "#858585",
      "--danger": "#f14c4c",
      "--toolbar-bg": "#2d2d2d",
      "--pane-header-bg": "#2d2d2d",
      "--tile-border": "#343434",
      "--tile-border-active": "#6e6e6e",
      "--tile-border-target": "#c7a64a",
      "--divider": "rgba(255, 255, 255, 0.06)",
    },
    {
      background: "#1e1e1e",
      foreground: "#cccccc",
      cursor: "#ffffff",
      selectionBackground: "#264f78",
    }
  ),

  midnight: theme(
    "midnight",
    "Midnight",
    "Deep blue-black with cool accents.",
    {
      "--bg": "#0d1117",
      "--sidebar-bg": "#010409",
      "--sidebar-border": "#21262d",
      "--accent": "#1f6feb",
      "--accent-hover": "#388bfd",
      "--text": "#e6edf3",
      "--text-dim": "#8b949e",
      "--danger": "#f85149",
      "--toolbar-bg": "#161b22",
      "--pane-header-bg": "#161b22",
      "--tile-border": "#30363d",
      "--tile-border-active": "#58a6ff",
      "--tile-border-target": "#d29922",
      "--divider": "rgba(240, 246, 252, 0.08)",
    },
    {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      selectionBackground: "#1f3a5f",
    }
  ),

  "one-dark": theme(
    "one-dark",
    "One Dark",
    "Atom-inspired dark with soft blues.",
    {
      "--bg": "#282c34",
      "--sidebar-bg": "#21252b",
      "--sidebar-border": "#181a1f",
      "--accent": "#61afef",
      "--accent-hover": "#7cc0f4",
      "--text": "#abb2bf",
      "--text-dim": "#5c6370",
      "--danger": "#e06c75",
      "--toolbar-bg": "#2c313a",
      "--pane-header-bg": "#2c313a",
      "--tile-border": "#3e4451",
      "--tile-border-active": "#61afef",
      "--tile-border-target": "#e5c07b",
      "--divider": "rgba(255, 255, 255, 0.07)",
    },
    {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
    }
  ),

  dracula: theme(
    "dracula",
    "Dracula",
    "Purple-tinted dark with vivid accents.",
    {
      "--bg": "#282a36",
      "--sidebar-bg": "#21222c",
      "--sidebar-border": "#44475a",
      "--accent": "#bd93f9",
      "--accent-hover": "#d6b4ff",
      "--text": "#f8f8f2",
      "--text-dim": "#6272a4",
      "--danger": "#ff5555",
      "--toolbar-bg": "#343746",
      "--pane-header-bg": "#343746",
      "--tile-border": "#44475a",
      "--tile-border-active": "#bd93f9",
      "--tile-border-target": "#f1fa8c",
      "--divider": "rgba(248, 248, 242, 0.08)",
    },
    {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
    }
  ),

  nord: theme(
    "nord",
    "Nord",
    "Arctic, bluish polar night palette.",
    {
      "--bg": "#2e3440",
      "--sidebar-bg": "#3b4252",
      "--sidebar-border": "#4c566a",
      "--accent": "#88c0d0",
      "--accent-hover": "#8fbcbb",
      "--text": "#eceff4",
      "--text-dim": "#d8dee9",
      "--danger": "#bf616a",
      "--toolbar-bg": "#3b4252",
      "--pane-header-bg": "#434c5e",
      "--tile-border": "#4c566a",
      "--tile-border-active": "#88c0d0",
      "--tile-border-target": "#ebcb8b",
      "--divider": "rgba(236, 239, 244, 0.08)",
    },
    {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
    }
  ),

  "tokyo-night": theme(
    "tokyo-night",
    "Tokyo Night",
    "Cool neon night city tones.",
    {
      "--bg": "#1a1b26",
      "--sidebar-bg": "#16161e",
      "--sidebar-border": "#292e42",
      "--accent": "#7aa2f7",
      "--accent-hover": "#89b4fa",
      "--text": "#c0caf5",
      "--text-dim": "#565f89",
      "--danger": "#f7768e",
      "--toolbar-bg": "#1f2335",
      "--pane-header-bg": "#1f2335",
      "--tile-border": "#292e42",
      "--tile-border-active": "#7aa2f7",
      "--tile-border-target": "#e0af68",
      "--divider": "rgba(192, 202, 245, 0.08)",
    },
    {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selectionBackground: "#283457",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
    }
  ),

  "catppuccin-mocha": theme(
    "catppuccin-mocha",
    "Catppuccin Mocha",
    "Soft pastel dark chocolate tones.",
    {
      "--bg": "#1e1e2e",
      "--sidebar-bg": "#181825",
      "--sidebar-border": "#313244",
      "--accent": "#cba6f7",
      "--accent-hover": "#f5c2e7",
      "--text": "#cdd6f4",
      "--text-dim": "#6c7086",
      "--danger": "#f38ba8",
      "--toolbar-bg": "#252538",
      "--pane-header-bg": "#252538",
      "--tile-border": "#313244",
      "--tile-border-active": "#cba6f7",
      "--tile-border-target": "#f9e2af",
      "--divider": "rgba(205, 214, 244, 0.08)",
    },
    {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#45475a",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
    }
  ),

  "gruvbox-dark": theme(
    "gruvbox-dark",
    "Gruvbox Dark",
    "Warm retro groove palette.",
    {
      "--bg": "#282828",
      "--sidebar-bg": "#1d2021",
      "--sidebar-border": "#3c3836",
      "--accent": "#fe8019",
      "--accent-hover": "#fabd2f",
      "--text": "#ebdbb2",
      "--text-dim": "#a89984",
      "--danger": "#fb4934",
      "--toolbar-bg": "#32302f",
      "--pane-header-bg": "#32302f",
      "--tile-border": "#504945",
      "--tile-border-active": "#fe8019",
      "--tile-border-target": "#b8bb26",
      "--divider": "rgba(235, 219, 178, 0.08)",
    },
    {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
    }
  ),

  monokai: theme(
    "monokai",
    "Monokai",
    "Classic neon green and pink terminal.",
    {
      "--bg": "#272822",
      "--sidebar-bg": "#1e1f1c",
      "--sidebar-border": "#3e3d32",
      "--accent": "#a6e22e",
      "--accent-hover": "#b6f03e",
      "--text": "#f8f8f2",
      "--text-dim": "#75715e",
      "--danger": "#f92672",
      "--toolbar-bg": "#2f302a",
      "--pane-header-bg": "#2f302a",
      "--tile-border": "#49483e",
      "--tile-border-active": "#a6e22e",
      "--tile-border-target": "#e6db74",
      "--divider": "rgba(248, 248, 242, 0.08)",
    },
    {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f0",
      selectionBackground: "#49483e",
      black: "#272822",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#f4bf75",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
    }
  ),

  "solarized-dark": theme(
    "solarized-dark",
    "Solarized Dark",
    "Ethan Schoonover’s precision palette.",
    {
      "--bg": "#002b36",
      "--sidebar-bg": "#073642",
      "--sidebar-border": "#094352",
      "--accent": "#268bd2",
      "--accent-hover": "#2aa198",
      "--text": "#839496",
      "--text-dim": "#586e75",
      "--danger": "#dc322f",
      "--toolbar-bg": "#073642",
      "--pane-header-bg": "#094352",
      "--tile-border": "#0a4a5a",
      "--tile-border-active": "#268bd2",
      "--tile-border-target": "#b58900",
      "--divider": "rgba(131, 148, 150, 0.12)",
    },
    {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
    }
  ),

  forest: theme(
    "forest",
    "Forest",
    "Deep green canopy with moss accents.",
    {
      "--bg": "#0f1a14",
      "--sidebar-bg": "#0a1210",
      "--sidebar-border": "#1c2e24",
      "--accent": "#3d9a6a",
      "--accent-hover": "#4db87e",
      "--text": "#d4e5d8",
      "--text-dim": "#6f8f7a",
      "--danger": "#e06b6b",
      "--toolbar-bg": "#15241c",
      "--pane-header-bg": "#15241c",
      "--tile-border": "#24382c",
      "--tile-border-active": "#3d9a6a",
      "--tile-border-target": "#c9a227",
      "--divider": "rgba(212, 229, 216, 0.08)",
    },
    {
      background: "#0f1a14",
      foreground: "#d4e5d8",
      cursor: "#4db87e",
      selectionBackground: "#1c3326",
      black: "#0a1210",
      red: "#e06b6b",
      green: "#3d9a6a",
      yellow: "#c9a227",
      blue: "#5b9bc6",
      magenta: "#a078b0",
      cyan: "#5cb89a",
      white: "#d4e5d8",
    }
  ),

  ember: theme(
    "ember",
    "Ember",
    "Warm charcoal with amber glow.",
    {
      "--bg": "#1a1410",
      "--sidebar-bg": "#120e0b",
      "--sidebar-border": "#2a211c",
      "--accent": "#e08a3c",
      "--accent-hover": "#f0a04a",
      "--text": "#f0e0d0",
      "--text-dim": "#9a7f6a",
      "--danger": "#e05a4a",
      "--toolbar-bg": "#221a15",
      "--pane-header-bg": "#221a15",
      "--tile-border": "#3a2e26",
      "--tile-border-active": "#e08a3c",
      "--tile-border-target": "#e0c04a",
      "--divider": "rgba(240, 224, 208, 0.08)",
    },
    {
      background: "#1a1410",
      foreground: "#f0e0d0",
      cursor: "#e08a3c",
      selectionBackground: "#3a2820",
      black: "#120e0b",
      red: "#e05a4a",
      green: "#8aab5a",
      yellow: "#e0c04a",
      blue: "#6a9abf",
      magenta: "#c070a0",
      cyan: "#70b0a0",
      white: "#f0e0d0",
    }
  ),

  light: theme(
    "light",
    "Light",
    "Bright chrome for well-lit rooms.",
    {
      "--bg": "#ffffff",
      "--sidebar-bg": "#f3f3f3",
      "--sidebar-border": "#e0e0e0",
      "--accent": "#0078d4",
      "--accent-hover": "#106ebe",
      "--text": "#1e1e1e",
      "--text-dim": "#6e6e6e",
      "--danger": "#c72e0f",
      "--toolbar-bg": "#f8f8f8",
      "--pane-header-bg": "#f0f0f0",
      "--tile-border": "#d0d0d0",
      "--tile-border-active": "#0078d4",
      "--tile-border-target": "#b89500",
      "--divider": "rgba(0, 0, 0, 0.08)",
    },
    {
      background: "#ffffff",
      foreground: "#1e1e1e",
      cursor: "#0078d4",
      selectionBackground: "#add6ff",
    }
  ),

  "solarized-light": theme(
    "solarized-light",
    "Solarized Light",
    "Warm light Solarized base.",
    {
      "--bg": "#fdf6e3",
      "--sidebar-bg": "#eee8d5",
      "--sidebar-border": "#ddd6c1",
      "--accent": "#268bd2",
      "--accent-hover": "#2aa198",
      "--text": "#657b83",
      "--text-dim": "#93a1a1",
      "--danger": "#dc322f",
      "--toolbar-bg": "#f5efdc",
      "--pane-header-bg": "#eee8d5",
      "--tile-border": "#ddd6c1",
      "--tile-border-active": "#268bd2",
      "--tile-border-target": "#b58900",
      "--divider": "rgba(101, 123, 131, 0.12)",
    },
    {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
    }
  ),

  paper: theme(
    "paper",
    "Paper",
    "Soft off-white, easy on the eyes.",
    {
      "--bg": "#f7f4ef",
      "--sidebar-bg": "#efeae2",
      "--sidebar-border": "#ddd5c8",
      "--accent": "#5b6abf",
      "--accent-hover": "#6f7dcf",
      "--text": "#2c2a26",
      "--text-dim": "#7a7368",
      "--danger": "#c44b4b",
      "--toolbar-bg": "#f2ede6",
      "--pane-header-bg": "#ebe4d9",
      "--tile-border": "#d8d0c3",
      "--tile-border-active": "#5b6abf",
      "--tile-border-target": "#b8860b",
      "--divider": "rgba(44, 42, 38, 0.08)",
    },
    {
      background: "#f7f4ef",
      foreground: "#2c2a26",
      cursor: "#5b6abf",
      selectionBackground: "#d8e0f0",
    }
  ),

  "high-contrast": theme(
    "high-contrast",
    "High Contrast",
    "Maximum contrast for visibility.",
    {
      "--bg": "#000000",
      "--sidebar-bg": "#000000",
      "--sidebar-border": "#ffffff",
      "--accent": "#1aebff",
      "--accent-hover": "#6ef0ff",
      "--text": "#ffffff",
      "--text-dim": "#a0a0a0",
      "--danger": "#ff0000",
      "--toolbar-bg": "#000000",
      "--pane-header-bg": "#000000",
      "--tile-border": "#ffffff",
      "--tile-border-active": "#1aebff",
      "--tile-border-target": "#ffff00",
      "--divider": "rgba(255, 255, 255, 0.35)",
    },
    {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#1aebff",
      selectionBackground: "#1aebff66",
    }
  ),
};

export const THEME_LIST: ThemePreset[] = Object.values(THEME_PRESETS);

export function getTheme(id: ThemeId): ThemePreset {
  return THEME_PRESETS[id] ?? THEME_PRESETS.wraith;
}
