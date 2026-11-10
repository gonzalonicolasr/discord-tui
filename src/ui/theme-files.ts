import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { getThemeEntry, PALETTE_KEYS, themeFromPalette, THEMES, type Palette, type Theme, type ThemeEntry } from "./theme";

const HEX = /^#[0-9a-fA-F]{6}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REQUIRED_PALETTE = PALETTE_KEYS.filter((key) => key !== "pink" && key !== "codeBg");
const LIST_KEYS = new Set(["names", "brand"]);

export interface ThemeLoadResult {
  themes: ThemeEntry[];
  /** Un mensaje por archivo que no se pudo usar, para mostrarlo en la app. */
  errors: string[];
}

/**
 * Un tema propio, en JSON:
 *   { "label": "Mi tema", "extends": "dark", "palette": { …13 colores… }, "colors": { "accent": "#…" } }
 * Todo es opcional salvo que tiene que haber `palette` o `colors`. Con `palette` se arman todos los colores;
 * si no, se parte de `extends` (por defecto el oscuro). `colors` pisa campos sueltos al final.
 */
export function parseThemeFile(text: string, fileName: string, themesSoFar: ThemeEntry[] = []): ThemeEntry {
  const name = basename(fileName).replace(/\.json$/i, "").toLowerCase();
  if (!NAME.test(name)) throw new Error("el nombre del archivo tiene que ser minúsculas, números y guiones (ej. mi-tema.json)");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`no es JSON válido (${error instanceof Error ? error.message : "error"})`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("tiene que ser un objeto JSON");
  const raw = data as Record<string, unknown>;
  if (raw.palette === undefined && raw.colors === undefined) throw new Error('falta "palette" o "colors"');

  let theme: Theme;
  if (raw.palette !== undefined) {
    const palette = checkObject(raw.palette, "palette");
    const missing = REQUIRED_PALETTE.filter((key) => palette[key] === undefined);
    if (missing.length > 0) throw new Error(`a "palette" le falta: ${missing.join(", ")}`);
    for (const [key, value] of Object.entries(palette)) {
      if (!(PALETTE_KEYS as readonly string[]).includes(key)) throw new Error(`"palette.${key}" no existe (valen: ${PALETTE_KEYS.join(", ")})`);
      checkHex(value, `palette.${key}`);
    }
    theme = themeFromPalette(palette as unknown as Palette);
  } else {
    const base = typeof raw.extends === "string" ? raw.extends : "dark";
    const parent = themesSoFar.find((entry) => entry.name === base)?.theme ?? getThemeEntry(base)?.theme;
    if (!parent) throw new Error(`"extends": no hay un tema "${base}"`);
    theme = { ...parent, names: [...parent.names], brand: [...parent.brand] };
  }

  if (raw.colors !== undefined) {
    const colors = checkObject(raw.colors, "colors");
    for (const [key, value] of Object.entries(colors)) {
      if (!(key in THEMES.dark)) throw new Error(`"colors.${key}" no existe (ver docs/themes.md)`);
      if (LIST_KEYS.has(key)) {
        if (!Array.isArray(value) || value.length === 0) throw new Error(`"colors.${key}" tiene que ser una lista de colores`);
        value.forEach((color, i) => checkHex(color, `colors.${key}[${i}]`));
        (theme as unknown as Record<string, unknown>)[key] = [...value];
      } else {
        checkHex(value, `colors.${key}`);
        (theme as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 40) : name;
  return { name, label: `${label} (propio)`, theme, source: fileName };
}

function checkObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`"${field}" tiene que ser un objeto`);
  return value as Record<string, unknown>;
}

function checkHex(value: unknown, field: string): void {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error(`"${field}" tiene que ser un color #rrggbb (vino ${JSON.stringify(value)})`);
}

/** Lee todos los .json de la carpeta en orden alfabético; los que fallan van a `errors` y no frenan al resto. */
export function loadThemeDir(
  dir: string,
  fs: { readdir(dir: string): string[]; readFile(path: string): string } = {
    readdir: (d) => readdirSync(d),
    readFile: (path) => readFileSync(path, "utf8"),
  },
): ThemeLoadResult {
  let files: string[];
  try {
    files = fs.readdir(dir).filter((file) => file.toLowerCase().endsWith(".json")).sort();
  } catch {
    return { themes: [], errors: [] }; // sin carpeta: sin temas propios
  }
  const themes: ThemeEntry[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      themes.push(parseThemeFile(fs.readFile(join(dir, file)), file, themes));
    } catch (error) {
      errors.push(`tema ${file}: ${error instanceof Error ? error.message : "error"}`);
    }
  }
  return { themes, errors };
}

let pendingErrors: string[] = [];

/** Carga y registra los temas propios de ~/.config/zcord/themes; los errores quedan para mostrarlos en la app. */
export function loadUserThemes(dir: string, register: (themes: ThemeEntry[]) => void): ThemeLoadResult {
  const result = loadThemeDir(dir);
  register(result.themes);
  pendingErrors = [...result.errors];
  return result;
}

/** Los errores de la última carga (una sola vez: la app los muestra como aviso al arrancar). */
export function takeThemeErrors(): string[] {
  const errors = pendingErrors;
  pendingErrors = [];
  return errors;
}
