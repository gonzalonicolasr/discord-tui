// Los tests nunca escriben en el log ni en la config reales de Gon (~/.local/state y ~/.config).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DISCORD_TUI_TEST_ENV) {
  process.env.DISCORD_TUI_TEST_ENV = "1";
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "discord-tui-test-state-"));
}

// Ni el compositor de Gon: el auto-silencio por inactividad (src/desktop/wayland-idle.ts) no se conecta a su Wayland.
delete process.env.WAYLAND_DISPLAY;
