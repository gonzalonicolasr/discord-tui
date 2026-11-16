import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { Monitor } from "../../src/golive/capture";
import { MonitorPicker, monitorLabel, MONITOR_LABEL_WIDTH } from "../../src/ui/components/MonitorPicker";
import { THEMES } from "../../src/ui/theme";

const mon = (name: string, model?: string, focused = false): Monitor => ({ name, width: 1920, height: 1080, focused, ...(model !== undefined ? { model } : {}) });

describe("monitor picker rows", () => {
  test("model first, then the connector and the size; the active mark stays", () => {
    expect(monitorLabel(mon("HDMI-A-1", "Legion 27-10"))).toBe("Legion 27-10 · HDMI-A-1 · 1920×1080");
    expect(monitorLabel(mon("DP-3", "KG251Q", true))).toBe("KG251Q · DP-3 · 1920×1080 · activo");
  });

  test("without a model it reads as before", () => {
    expect(monitorLabel(mon("DP-1"))).toBe("DP-1 · 1920×1080");
    expect(monitorLabel(mon("DP-1", undefined, true))).toBe("DP-1 · 1920×1080 · activo");
    expect(monitorLabel({ name: "", width: 0, height: 0, focused: true })).toBe("pantalla predeterminada · activo");
  });

  test("a long model is cut so the row fits; the connector and the active mark are never cut", () => {
    const label = monitorLabel(mon("HDMI-A-1", "Lenovo Group Limited Legion 27-10 Pro", true));
    expect(Bun.stringWidth(label)).toBeLessThanOrEqual(MONITOR_LABEL_WIDTH);
    expect(label).toMatch(/^Lenovo.*… · HDMI-A-1 · 1920×1080 · activo$/);
  });

  test("two monitors of the same model are told apart by the connector", () => {
    expect(monitorLabel(mon("DP-1", "ASUS VA24E"))).not.toBe(monitorLabel(mon("DP-2", "ASUS VA24E")));
  });

  test("the box shows the model rows without overflowing", async () => {
    const monitors = [mon("DP-1", "Odyssey G40B", true), mon("HDMI-A-1", "Legion 27-10"), mon("DP-3", "Lenovo Group Limited Legion 27-10 Pro Max")];
    const { renderOnce, captureCharFrame } = await testRender(
      () => <MonitorPicker monitors={monitors} theme={THEMES.dark} onPick={() => {}} onClose={() => {}} />,
      { width: 80, height: 20 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Odyssey G40B · DP-1 · 1920×1080 · activo");
    expect(frame).toContain("Legion 27-10 · HDMI-A-1 · 1920×1080");
    const rows = frame.split("\n").filter((l) => l.includes("🖥"));
    expect(rows).toHaveLength(3);
    // cada fila termina en el borde derecho del cuadro: nada se sale
    for (const row of rows) expect(row.trimEnd()).toMatch(/│ *│?$/);
    expect(rows.find((r) => r.includes("DP-3"))).toMatch(/… · DP-3 · 1920×1080/);
  });
});
