/**
 * Terminal font presets with availability detection + optional web loading.
 *
 * System fonts are only offered when installed.
 * Google Fonts are fetched on demand so they actually render (not silent fallbacks).
 */

export interface FontPreset {
  id: string;
  label: string;
  /** Primary typeface name (for detection / FontFace). */
  face: string;
  /** Full CSS font-family stack applied to xterm. */
  stack: string;
  /**
   * Google Fonts family query segment, e.g. "JetBrains+Mono".
   * When set, the font is loaded over the network so it works without installing.
   */
  google?: string;
}

export const FONT_PRESETS: FontPreset[] = [
  // --- Windows / common system ---
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    face: "Cascadia Code",
    stack: '"Cascadia Code", Consolas, "Courier New", monospace',
  },
  {
    id: "cascadia-mono",
    label: "Cascadia Mono",
    face: "Cascadia Mono",
    stack: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  },
  {
    id: "consolas",
    label: "Consolas",
    face: "Consolas",
    stack: 'Consolas, "Courier New", monospace',
  },
  {
    id: "courier-new",
    label: "Courier New",
    face: "Courier New",
    stack: '"Courier New", Courier, monospace',
  },
  {
    id: "lucida-console",
    label: "Lucida Console",
    face: "Lucida Console",
    stack: '"Lucida Console", Consolas, monospace',
  },
  {
    id: "segoe-ui-mono",
    label: "Segoe UI Mono",
    face: "Segoe UI Mono",
    stack: '"Segoe UI Mono", Consolas, monospace',
  },

  // --- Loaded from Google Fonts (work without install) ---
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    face: "JetBrains Mono",
    stack: '"JetBrains Mono", Consolas, monospace',
    google: "JetBrains+Mono:wght@400;500;600;700",
  },
  {
    id: "fira-code",
    label: "Fira Code",
    face: "Fira Code",
    stack: '"Fira Code", Consolas, monospace',
    google: "Fira+Code:wght@400;500;600;700",
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    face: "Source Code Pro",
    stack: '"Source Code Pro", Consolas, monospace',
    google: "Source+Code+Pro:wght@400;500;600;700",
  },
  {
    id: "ibm-plex-mono",
    label: "IBM Plex Mono",
    face: "IBM Plex Mono",
    stack: '"IBM Plex Mono", Consolas, monospace',
    google: "IBM+Plex+Mono:wght@400;500;600;700",
  },
  {
    id: "inconsolata",
    label: "Inconsolata",
    face: "Inconsolata",
    stack: "Inconsolata, Consolas, monospace",
    google: "Inconsolata:wght@400;500;600;700",
  },
  {
    id: "roboto-mono",
    label: "Roboto Mono",
    face: "Roboto Mono",
    stack: '"Roboto Mono", Consolas, monospace',
    google: "Roboto+Mono:wght@400;500;600;700",
  },
  {
    id: "ubuntu-mono",
    label: "Ubuntu Mono",
    face: "Ubuntu Mono",
    stack: '"Ubuntu Mono", Consolas, monospace',
    google: "Ubuntu+Mono:wght@400;700",
  },
  {
    id: "space-mono",
    label: "Space Mono",
    face: "Space Mono",
    stack: '"Space Mono", Consolas, monospace',
    google: "Space+Mono:wght@400;700",
  },
  {
    id: "anonymous-pro",
    label: "Anonymous Pro",
    face: "Anonymous Pro",
    stack: '"Anonymous Pro", Consolas, monospace',
    google: "Anonymous+Pro:wght@400;700",
  },
  {
    id: "red-hat-mono",
    label: "Red Hat Mono",
    face: "Red Hat Mono",
    stack: '"Red Hat Mono", Consolas, monospace',
    google: "Red+Hat+Mono:wght@400;500;600;700",
  },
  {
    id: "noto-sans-mono",
    label: "Noto Sans Mono",
    face: "Noto Sans Mono",
    stack: '"Noto Sans Mono", Consolas, monospace',
    google: "Noto+Sans+Mono:wght@400;500;600;700",
  },
  {
    id: "pt-mono",
    label: "PT Mono",
    face: "PT Mono",
    stack: '"PT Mono", Consolas, monospace',
    google: "PT+Mono",
  },
  {
    id: "share-tech-mono",
    label: "Share Tech Mono",
    face: "Share Tech Mono",
    stack: '"Share Tech Mono", Consolas, monospace',
    google: "Share+Tech+Mono",
  },

  // --- System-only (shown only when installed) ---
  {
    id: "sf-mono",
    label: "SF Mono",
    face: "SF Mono",
    stack: '"SF Mono", Menlo, Monaco, Consolas, monospace',
  },
  {
    id: "menlo",
    label: "Menlo",
    face: "Menlo",
    stack: "Menlo, Monaco, Consolas, monospace",
  },
  {
    id: "monaco",
    label: "Monaco",
    face: "Monaco",
    stack: "Monaco, Menlo, Consolas, monospace",
  },
  {
    id: "hack",
    label: "Hack",
    face: "Hack",
    stack: "Hack, Consolas, monospace",
  },
  {
    id: "iosevka",
    label: "Iosevka",
    face: "Iosevka",
    stack: "Iosevka, Consolas, monospace",
  },
  {
    id: "dejavu-sans-mono",
    label: "DejaVu Sans Mono",
    face: "DejaVu Sans Mono",
    stack: '"DejaVu Sans Mono", Consolas, monospace',
  },
  {
    id: "liberation-mono",
    label: "Liberation Mono",
    face: "Liberation Mono",
    stack: '"Liberation Mono", Consolas, monospace',
  },
  {
    id: "system-mono",
    label: "System mono",
    face: "ui-monospace",
    stack: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
];

/** Back-compat shape used by older settings UI. */
export const FONT_FAMILY_PRESETS = FONT_PRESETS.map((p) => ({
  label: p.label,
  value: p.stack,
}));

const loadedGoogle = new Set<string>();
const loadPromises = new Map<string, Promise<void>>();
let detectedCache: Map<string, boolean> | null = null;

function quoteFace(face: string): string {
  return face.includes(" ") ? `"${face}"` : face;
}

/**
 * Canvas-based system font detection.
 * Compares metrics against two different fallbacks to reduce false negatives.
 */
export function isSystemFontInstalled(face: string): boolean {
  if (typeof document === "undefined") return false;
  if (face === "ui-monospace") return true; // generic family always "available"

  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const sample = "ABCDEFGWijmno0123456789@#$%";
    const size = "72px";

    const measure = (family: string) => {
      ctx.font = `${size} ${family}`;
      return ctx.measureText(sample).width;
    };

    const quoted = quoteFace(face);
    const baseMono = measure("monospace");
    const baseSerif = measure("serif");
    const baseSans = measure("sans-serif");
    const testMono = measure(`${quoted}, monospace`);
    const testSerif = measure(`${quoted}, serif`);
    const testSans = measure(`${quoted}, sans-serif`);

    // If the primary face is used, widths differ from the pure fallback.
    return (
      testMono !== baseMono || testSerif !== baseSerif || testSans !== baseSans
    );
  } catch {
    return false;
  }
}

/** Prefer Font Loading API when available, fall back to canvas. */
export function isFontAvailable(face: string): boolean {
  if (typeof document === "undefined") return false;
  if (face === "ui-monospace") return true;

  try {
    if (document.fonts?.check) {
      // check() is true when a matching face can be used.
      if (document.fonts.check(`16px ${quoteFace(face)}`)) return true;
    }
  } catch {
    // fall through
  }
  return isSystemFontInstalled(face);
}

export function detectAvailableFontIds(): Set<string> {
  if (detectedCache) {
    return new Set(
      [...detectedCache.entries()].filter(([, ok]) => ok).map(([id]) => id)
    );
  }

  const map = new Map<string, boolean>();
  for (const preset of FONT_PRESETS) {
    if (preset.google) {
      // Google fonts become available after load; treat as offerable always.
      map.set(preset.id, true);
    } else {
      map.set(preset.id, isFontAvailable(preset.face));
    }
  }
  detectedCache = map;

  const available = new Set<string>();
  for (const [id, ok] of map) {
    if (ok) available.add(id);
  }
  return available;
}

/** Invalidate detection cache (e.g. after installing fonts). */
export function refreshFontDetection(): Set<string> {
  detectedCache = null;
  return detectAvailableFontIds();
}

function injectGoogleFontsStylesheet(families: string[]): void {
  if (typeof document === "undefined" || families.length === 0) return;
  const id = "wraith-google-fonts";
  const href =
    "https://fonts.googleapis.com/css2?" +
    families.map((f) => `family=${f}`).join("&") +
    "&display=swap";

  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  // Always update href so newly requested families are included.
  const existing = link.dataset.families?.split("|") ?? [];
  const merged = Array.from(new Set([...existing, ...families]));
  link.dataset.families = merged.join("|");
  link.href =
    "https://fonts.googleapis.com/css2?" +
    merged.map((f) => `family=${f}`).join("&") +
    "&display=swap";
  void href;
}

/** Load a single Google Font family and wait until it's usable. */
export async function ensureGoogleFont(preset: FontPreset): Promise<void> {
  if (!preset.google) return;
  if (loadedGoogle.has(preset.google)) {
    // Still wait for face if browser is mid-load.
    try {
      await document.fonts.load(`16px ${quoteFace(preset.face)}`);
    } catch {
      // ignore
    }
    return;
  }

  const existing = loadPromises.get(preset.google);
  if (existing) {
    await existing;
    return;
  }

  const promise = (async () => {
    injectGoogleFontsStylesheet([preset.google!]);
    // Wait for stylesheet + face.
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      await document.fonts.load(`16px ${quoteFace(preset.face)}`);
      // Also warm a few weights common in terminals.
      await Promise.allSettled([
        document.fonts.load(`500 16px ${quoteFace(preset.face)}`),
        document.fonts.load(`700 16px ${quoteFace(preset.face)}`),
      ]);
    } catch {
      // Network offline — will fall back in CSS stack.
    }
    loadedGoogle.add(preset.google!);
  })();

  loadPromises.set(preset.google, promise);
  await promise;
}

/** Preload every Google Font preset so the picker is snappy. */
export async function preloadWebFonts(): Promise<void> {
  const google = FONT_PRESETS.filter((p) => p.google).map((p) => p.google!);
  if (google.length === 0) return;
  injectGoogleFontsStylesheet(google);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.allSettled(
      FONT_PRESETS.filter((p) => p.google).map((p) =>
        document.fonts.load(`16px ${quoteFace(p.face)}`)
      )
    );
    for (const g of google) loadedGoogle.add(g);
  } catch {
    // offline
  }
}

export function findFontPresetByStack(stack: string): FontPreset | undefined {
  return (
    FONT_PRESETS.find((p) => p.stack === stack) ??
    FONT_PRESETS.find((p) => stack.includes(p.face))
  );
}

/** Ensure the preferred face for a stack is ready, then return the stack. */
export async function ensureFontStackReady(stack: string): Promise<string> {
  const preset = findFontPresetByStack(stack);
  if (preset?.google) {
    await ensureGoogleFont(preset);
  } else if (preset) {
    try {
      await document.fonts?.load?.(`16px ${quoteFace(preset.face)}`);
    } catch {
      // ignore
    }
  }
  return stack;
}

export function getSelectableFonts(): FontPreset[] {
  const available = detectAvailableFontIds();
  return FONT_PRESETS.filter((p) => available.has(p.id));
}

/**
 * If the saved stack's primary face isn't available, fall back to Consolas /
 * Cascadia Code / system mono.
 */
export function resolveUsableFontStack(stack: string): string {
  const preset = findFontPresetByStack(stack);
  if (!preset) {
    // Unknown custom stack — keep as-is.
    return stack;
  }
  if (preset.google) return preset.stack; // will load
  if (isFontAvailable(preset.face)) return preset.stack;

  // Preferred face missing — pick best installed default.
  for (const id of ["cascadia-code", "consolas", "courier-new", "system-mono"]) {
    const fallback = FONT_PRESETS.find((p) => p.id === id);
    if (fallback && isFontAvailable(fallback.face)) return fallback.stack;
  }
  return 'Consolas, "Courier New", monospace';
}
