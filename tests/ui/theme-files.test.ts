import { afterEach, expect, test } from "bun:test";

import { normalizeSettings as parseSettings } from "../../src/settings/settings";
import { cycleTheme, getTheme, registerThemes, resetThemes, themeEntries, themeLabel, THEMES } from "../../src/ui/theme";
import { loadThemeDir, parseThemeFile } from "../../src/ui/theme-files";

afterEach(() => resetThemes());

const PALETTE = {
  bg: "#101010", panel: "#0a0a0a", selection: "#303030", faint: "#404040", dim: "#909090", fg: "#f0f0f0",
  accent: "#00aaff", red: "#ff0000", orange: "#ff8800", yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", purple: "#aa00ff",
};

test("built-in themes: dark, light plus gruvbox, tokyo-night, nord and dracula, all complete", () => {
  const names = themeEntries().map((e) => e.name);
  expect(names).toEqual(["dark", "light", "gruvbox", "tokyo-night", "nord", "dracula"]);
  for (const entry of themeEntries()) {
    for (const [key, value] of Object.entries(entry.theme)) {
      if (Array.isArray(value)) expect(value.length).toBeGreaterThan(0);
      else expect(value, `${entry.name}.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.keys(entry.theme).sort()).toEqual(Object.keys(THEMES.dark).sort());
  }
});

test("a palette file builds every color; colors overrides single fields", () => {
  const entry = parseThemeFile(JSON.stringify({ label: "Mi Tema", palette: PALETTE, colors: { mention: "#123456", names: ["#111111"] } }), "mi-tema.json");
  expect(entry.name).toBe("mi-tema");
  expect(entry.label).toBe("Mi Tema (propio)");
  expect(entry.theme.bg).toBe("#101010");
  expect(entry.theme.error).toBe("#ff0000");
  expect(entry.theme.borderFocus).toBe("#00aaff");
  expect(entry.theme.mention).toBe("#123456");
  expect(entry.theme.names).toEqual(["#111111"]);
});

test("extends starts from another theme (built-in or an earlier file) and only changes what you list", () => {
  const nordish = parseThemeFile(JSON.stringify({ extends: "nord", colors: { accent: "#ff00ff" } }), "nord-rosa.json");
  expect(nordish.theme.bg).toBe(getTheme("nord").bg);
  expect(nordish.theme.accent).toBe("#ff00ff");
  const child = parseThemeFile(JSON.stringify({ extends: "nord-rosa", colors: { bg: "#000000" } }), "hijo.json", [nordish]);
  expect(child.theme).toMatchObject({ accent: "#ff00ff", bg: "#000000" });
  // sin extends: parte del oscuro
  expect(parseThemeFile(JSON.stringify({ colors: { accent: "#00ff00" } }), "x.json").theme.bg).toBe(THEMES.dark.bg);
});

test("bad files fail with a clear Spanish message", () => {
  const bad = (text: string, file = "t.json") => {
    try {
      parseThemeFile(text, file);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect(bad("{nope")).toContain("no es JSON válido");
  expect(bad("{}")).toContain('falta "palette" o "colors"');
  expect(bad(JSON.stringify({ palette: { bg: "#000000" } }))).toContain('a "palette" le falta: panel');
  expect(bad(JSON.stringify({ colors: { accent: "rojo" } }))).toContain('"colors.accent" tiene que ser un color #rrggbb');
  expect(bad(JSON.stringify({ colors: { fondo: "#000000" } }))).toContain('"colors.fondo" no existe');
  expect(bad(JSON.stringify({ extends: "nada", colors: { accent: "#000000" } }))).toContain('no hay un tema "nada"');
  expect(bad(JSON.stringify({ colors: {} }), "Mi Tema.json")).toContain("el nombre del archivo");
});

test("loadThemeDir reads the .json files in order, keeps going after a bad one, and no folder means no themes", () => {
  const files: Record<string, string> = {
    "b-hijo.json": JSON.stringify({ extends: "a-base", colors: { bg: "#000000" } }),
    "a-base.json": JSON.stringify({ palette: PALETTE }),
    "roto.json": "{",
    "notas.txt": "no es un tema",
  };
  const result = loadThemeDir("/temas", { readdir: () => Object.keys(files), readFile: (p) => files[p.split("/").pop()!]! });
  expect(result.themes.map((t) => t.name)).toEqual(["a-base", "b-hijo"]);
  expect(result.themes[1]!.theme.accent).toBe("#00aaff");
  expect(result.errors).toEqual([expect.stringContaining("tema roto.json: no es JSON válido")]);
  expect(loadThemeDir("/no/existe", { readdir: () => { throw new Error("ENOENT"); }, readFile: () => "" })).toEqual({ themes: [], errors: [] });
});

test("registered themes join the cycle; an unknown saved name falls back to dark", () => {
  registerThemes([parseThemeFile(JSON.stringify({ palette: PALETTE }), "mio.json")]);
  expect(cycleTheme("dracula", 1)).toBe("mio");
  expect(cycleTheme("mio", 1)).toBe("dark");
  expect(cycleTheme("dark", -1)).toBe("mio");
  expect(getTheme("borrado")).toBe(THEMES.dark);
  expect(themeLabel("borrado")).toContain("no encontrado");
});

test("settings keep any valid theme name and drop garbage", () => {
  expect(parseSettings({ theme: "tokyo-night" }).theme).toBe("tokyo-night");
  expect(parseSettings({ theme: "mi-tema-2" }).theme).toBe("mi-tema-2");
  expect(parseSettings({ theme: "../../etc" }).theme).toBe("dark");
  expect(parseSettings({ theme: 42 }).theme).toBe("dark");
});

test("the example theme in docs/themes parses", async () => {
  const text = await Bun.file(new URL("../../docs/themes/kanagawa.json", import.meta.url)).text();
  const entry = parseThemeFile(text, "kanagawa.json");
  expect(entry.label).toBe("Kanagawa (propio)");
  expect(entry.theme.unread).toBe("#e6c384");
});
