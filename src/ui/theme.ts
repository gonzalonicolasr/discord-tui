import type { Store } from "../store/store";
import { useSelector } from "./store-bridge";

export interface Theme {
  bg: string;
  fg: string;
  dim: string;
  faint: string;
  accent: string;
  unread: string;
  mention: string;
  error: string;
  warn: string;
  ok: string;
  border: string;
  borderFocus: string;
  panel: string;
  selection: string;
  selectionFg: string;
  header: string;
  codeBg: string;
  codeFg: string;
  link: string;
  mentionBg: string;
  mentionFg: string;
  quote: string;
  online: string;
  idle: string;
  dnd: string;
  offline: string;
  speaking: string;
  modeNormal: string;
  modeInsert: string;
  modeFg: string;
  /** Paleta para colorear nombres de usuarios sin rol con color. */
  names: string[];
  /** Degradé del logo de zcord en el splash. */
  brand: string[];
}

export const THEMES: Record<"dark" | "light", Theme> = {
  dark: {
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    dim: "#7f849c",
    faint: "#45475a",
    accent: "#89b4fa",
    unread: "#f5e0dc",
    mention: "#f9e2af",
    error: "#f38ba8",
    warn: "#fab387",
    ok: "#a6e3a1",
    border: "#45475a",
    borderFocus: "#89b4fa",
    panel: "#181825",
    selection: "#313244",
    selectionFg: "#f5e0dc",
    header: "#b4befe",
    codeBg: "#11111b",
    codeFg: "#fab387",
    link: "#74c7ec",
    mentionBg: "#3b3f6b",
    mentionFg: "#b4befe",
    quote: "#6c7086",
    online: "#a6e3a1",
    idle: "#f9e2af",
    dnd: "#f38ba8",
    offline: "#6c7086",
    speaking: "#a6e3a1",
    modeNormal: "#89b4fa",
    modeInsert: "#a6e3a1",
    modeFg: "#11111b",
    names: ["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#89b4fa", "#cba6f7", "#f5c2e7", "#eba0ac"],
    brand: ["#74c7ec", "#89b4fa", "#b4befe", "#cba6f7", "#f5c2e7", "#cba6f7", "#b4befe", "#89b4fa"],
  },
  light: {
    bg: "#eff1f5",
    fg: "#4c4f69",
    dim: "#8c8fa1",
    faint: "#bcc0cc",
    accent: "#1e66f5",
    unread: "#8839ef",
    mention: "#df8e1d",
    error: "#d20f39",
    warn: "#fe640b",
    ok: "#40a02b",
    border: "#bcc0cc",
    borderFocus: "#1e66f5",
    panel: "#e6e9ef",
    selection: "#ccd0da",
    selectionFg: "#4c4f69",
    header: "#7287fd",
    codeBg: "#dce0e8",
    codeFg: "#d20f39",
    link: "#209fb5",
    mentionBg: "#c6d0f5",
    mentionFg: "#1e66f5",
    quote: "#8c8fa1",
    online: "#40a02b",
    idle: "#df8e1d",
    dnd: "#d20f39",
    offline: "#9ca0b0",
    speaking: "#40a02b",
    modeNormal: "#1e66f5",
    modeInsert: "#40a02b",
    modeFg: "#eff1f5",
    names: ["#d20f39", "#fe640b", "#df8e1d", "#40a02b", "#179299", "#04a5e5", "#1e66f5", "#8839ef", "#ea76cb", "#e64553"],
    brand: ["#209fb5", "#1e66f5", "#7287fd", "#8839ef", "#ea76cb", "#8839ef", "#7287fd", "#1e66f5"],
  },
};

/**
 * Paleta base de un tema: 13 colores (más dos opcionales) de los que salen los ~30 de `Theme`. Es lo que conviene
 * escribir en un tema propio; los campos de `Theme` se pueden pisar uno por uno igual (ver docs/themes.md).
 */
export interface Palette {
  bg: string;
  panel: string;
  selection: string;
  faint: string;
  dim: string;
  fg: string;
  accent: string;
  red: string;
  orange: string;
  yellow: string;
  green: string;
  cyan: string;
  purple: string;
  pink?: string;
  codeBg?: string;
}

export const PALETTE_KEYS = ["bg", "panel", "selection", "faint", "dim", "fg", "accent", "red", "orange", "yellow", "green", "cyan", "purple", "pink", "codeBg"] as const;

export function themeFromPalette(p: Palette): Theme {
  const pink = p.pink ?? p.purple;
  return {
    bg: p.bg,
    fg: p.fg,
    dim: p.dim,
    faint: p.faint,
    accent: p.accent,
    unread: p.fg,
    mention: p.yellow,
    error: p.red,
    warn: p.orange,
    ok: p.green,
    border: p.faint,
    borderFocus: p.accent,
    panel: p.panel,
    selection: p.selection,
    selectionFg: p.fg,
    header: p.purple,
    codeBg: p.codeBg ?? p.panel,
    codeFg: p.orange,
    link: p.cyan,
    mentionBg: p.selection,
    mentionFg: p.accent,
    quote: p.dim,
    online: p.green,
    idle: p.yellow,
    dnd: p.red,
    offline: p.dim,
    speaking: p.green,
    modeNormal: p.accent,
    modeInsert: p.green,
    modeFg: p.bg,
    names: [p.red, p.orange, p.yellow, p.green, p.cyan, p.accent, p.purple, pink],
    brand: [p.cyan, p.accent, p.purple, pink, p.purple, p.accent],
  };
}

export interface ThemeEntry {
  /** Nombre que se guarda en settings: minúsculas, números y guiones. */
  name: string;
  /** Cómo se muestra en settings. */
  label: string;
  theme: Theme;
  /** Archivo de donde salió (temas propios). */
  source?: string;
}

const BUILTIN: ThemeEntry[] = [
  { name: "dark", label: "oscuro (Catppuccin Mocha)", theme: THEMES.dark },
  { name: "light", label: "claro (Catppuccin Latte)", theme: THEMES.light },
  {
    name: "gruvbox",
    label: "Gruvbox",
    theme: themeFromPalette({ bg: "#282828", panel: "#1d2021", selection: "#3c3836", faint: "#504945", dim: "#a89984", fg: "#ebdbb2", accent: "#83a598", red: "#fb4934", orange: "#fe8019", yellow: "#fabd2f", green: "#b8bb26", cyan: "#8ec07c", purple: "#d3869b" }),
  },
  {
    name: "tokyo-night",
    label: "Tokyo Night",
    theme: themeFromPalette({ bg: "#1a1b26", panel: "#16161e", selection: "#283457", faint: "#3b4261", dim: "#737aa2", fg: "#c0caf5", accent: "#7aa2f7", red: "#f7768e", orange: "#ff9e64", yellow: "#e0af68", green: "#9ece6a", cyan: "#7dcfff", purple: "#bb9af7" }),
  },
  {
    name: "nord",
    label: "Nord",
    theme: themeFromPalette({ bg: "#2e3440", panel: "#272c36", selection: "#3b4252", faint: "#4c566a", dim: "#8a95ab", fg: "#eceff4", accent: "#88c0d0", red: "#bf616a", orange: "#d08770", yellow: "#ebcb8b", green: "#a3be8c", cyan: "#8fbcbb", purple: "#b48ead" }),
  },
  {
    name: "dracula",
    label: "Dracula",
    theme: themeFromPalette({ bg: "#282a36", panel: "#21222c", selection: "#44475a", faint: "#44475a", dim: "#7f8bbd", fg: "#f8f8f2", accent: "#bd93f9", red: "#ff5555", orange: "#ffb86c", yellow: "#f1fa8c", green: "#50fa7b", cyan: "#8be9fd", purple: "#bd93f9", pink: "#ff79c6" }),
  },
];

const registry = new Map<string, ThemeEntry>(BUILTIN.map((entry) => [entry.name, entry]));

/** Suma temas (los propios de ~/.config/zcord/themes); uno con el mismo nombre que otro lo reemplaza. */
export function registerThemes(entries: ThemeEntry[]): void {
  for (const entry of entries) registry.set(entry.name, entry);
}

/** Vuelve a dejar solo los temas incluidos (tests). */
export function resetThemes(): void {
  registry.clear();
  for (const entry of BUILTIN) registry.set(entry.name, entry);
}

export function themeEntries(): ThemeEntry[] {
  return [...registry.values()];
}

export function getThemeEntry(name: string): ThemeEntry | undefined {
  return registry.get(name);
}

/** El tema por nombre; si no existe (lo borraste, typo), el oscuro. */
export function getTheme(name: string): Theme {
  return registry.get(name)?.theme ?? THEMES.dark;
}

export function themeLabel(name: string): string {
  return registry.get(name)?.label ?? `${name} (no encontrado: uso el oscuro)`;
}

/** El siguiente (dir 1) o anterior (dir -1) tema de la lista, dando la vuelta. */
export function cycleTheme(current: string, dir: 1 | -1): string {
  const names = themeEntries().map((entry) => entry.name);
  const index = names.indexOf(current);
  return names[(index + dir + names.length) % names.length]!;
}

export function useTheme(store: Store): () => Theme {
  const themeName = useSelector(store, (state) => state.settings.theme);
  return () => getTheme(themeName());
}

/** Color de un rol de Discord (entero RGB) como hex; 0 = sin color. */
export function roleHex(color: number): string | null {
  if (!color) return null;
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function presenceColor(theme: Theme, status: string | undefined): string {
  if (status === "online") return theme.online;
  if (status === "idle") return theme.idle;
  if (status === "dnd") return theme.dnd;
  return theme.offline;
}
