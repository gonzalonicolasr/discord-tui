import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getTheme, registerThemes, resetThemes, THEMES, useTheme } from "../../src/ui/theme";
import { parseThemeFile } from "../../src/ui/theme-files";
import { createStore, emptyState } from "../../src/store/store";

describe("THEMES", () => {
  test("dark and light have the same keys", () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(Object.keys(THEMES.light).sort());
  });

  test("useTheme follows store settings", () => {
    const store = createStore(emptyState());
    const theme = useTheme(store);
    expect(theme()).toEqual(THEMES.dark);
    store.dispatch({ type: "settings/set", patch: { theme: "light" } });
    expect(theme()).toEqual(THEMES.light);
  });

  test("useTheme follows built-in extras and custom themes", () => {
    const store = createStore(emptyState());
    const theme = useTheme(store);
    store.dispatch({ type: "settings/set", patch: { theme: "gruvbox" } });
    expect(theme().bg).toBe(getTheme("gruvbox").bg);
    registerThemes([parseThemeFile(JSON.stringify({ extends: "dracula", colors: { bg: "#010203" } }), "mio.json")]);
    store.dispatch({ type: "settings/set", patch: { theme: "mio" } });
    expect(theme().bg).toBe("#010203");
    resetThemes();
  });
});

describe("no component uses a literal color outside theme.ts", () => {
  test("src/ui has no hex colors or literal color names outside theme.ts", () => {
    const dir = join(import.meta.dir, "..", "..", "src", "ui");
    const offenders: string[] = [];

    function walk(path: string): void {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (full.endsWith(join("src", "ui", "theme.ts"))) continue;
        const content = readFileSync(full, "utf8");
        if (/#[0-9a-fA-F]{3,6}\b/.test(content) || /"(red|green|blue|yellow)"/.test(content)) {
          offenders.push(full);
        }
      }
    }

    walk(dir);
    expect(offenders).toEqual([]);
  });
});
