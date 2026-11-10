import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { Actions } from "../../src/actions";
import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";

function setup() {
  const store = buildDemoStore();
  const base = demoActions(store);
  const calls: string[] = [];
  const voice = base.voice!;
  const actions: Actions = {
    ...base,
    voice: {
      ...voice,
      startStream: (monitor) => (calls.push(`start:${monitor ?? ""}`), voice.startStream!(monitor)),
      stopStream: () => (calls.push("stop"), voice.stopStream!()),
    },
  };
  return { store, actions, calls };
}

async function render(s: ReturnType<typeof setup>) {
  const r = await testRender(() => <App store={s.store} actions={s.actions} onQuit={() => {}} />, { width: 180, height: 50 });
  await r.renderOnce();
  return r;
}

type Harness = Awaited<ReturnType<typeof render>>;

function find(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (let y = 0; y < lines.length; y += 1) {
    const index = lines[y]!.indexOf(text);
    if (index !== -1) return { x: Bun.stringWidth(lines[y]!.slice(0, index)) + Math.floor(Bun.stringWidth(text) / 2), y };
  }
  throw new Error(`no encontré "${text}" en pantalla`);
}

async function click(h: Harness, text: string): Promise<void> {
  const { x, y } = find(h.captureCharFrame(), text);
  await h.mockMouse.click(x, y);
  await h.renderOnce();
  await Bun.sleep(5);
  await h.renderOnce();
}

async function joinVoice(s: ReturnType<typeof setup>) {
  await s.actions.voice!.toggleVoice(DEMO.voice);
}

test("the voice bar has a 📺 transmitir button only while in a call", async () => {
  const s = setup();
  const h = await render(s);
  expect(h.captureCharFrame()).not.toContain("📺 transmitir");
  await joinVoice(s);
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("📺 transmitir");
  await s.actions.voice!.leaveVoice();
});

test("click 📺 transmitir → monitor picker → ⏳ iniciando… → 🔴 EN VIVO · detener → click stops", async () => {
  const s = setup();
  const h = await render(s);
  await joinVoice(s);
  await h.renderOnce();
  await click(h, "📺 transmitir");
  await Bun.sleep(5);
  await h.renderOnce();
  const picker = h.captureCharFrame();
  expect(picker).toContain("¿Qué pantalla transmitir?");
  expect(picker).toContain("🖥 DP-1 · 1920×1080 · activo");
  expect(picker).toContain("🖥 HDMI-A-1 · 1920×1080");
  await click(h, "HDMI-A-1 · 1920×1080");
  expect(s.calls).toEqual(["start:HDMI-A-1"]);
  expect(h.captureCharFrame()).not.toContain("¿Qué pantalla transmitir?");
  expect(h.captureCharFrame()).toContain("⏳ iniciando…");
  await Bun.sleep(650);
  await h.renderOnce();
  const live = h.captureCharFrame();
  expect(live).toContain("🔴 EN VIVO · detener");
  expect(live).toContain("👁 Ramiro"); // quién te mira, por nombre
  expect(live).toMatch(/Ramiro\s+👁/); // y el 👁 al lado de Ramiro en la lista de la llamada
  expect(live).toMatch(/○ G  Gon\s+📺/);
  await click(h, "🔴 EN VIVO · detener");
  expect(s.calls).toEqual(["start:HDMI-A-1", "stop"]);
  expect(h.captureCharFrame()).toContain("📺 transmitir");
  expect(h.captureCharFrame()).not.toMatch(/○ G  Gon\s+📺/);
  await s.actions.voice!.leaveVoice();
});

test("S opens the picker; ↓ + Enter picks; Esc closes without streaming", async () => {
  const s = setup();
  const h = await render(s);
  await joinVoice(s);
  h.mockInput.pressKey("S");
  await Bun.sleep(5);
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("¿Qué pantalla transmitir?");
  h.mockInput.pressEscape();
  await Bun.sleep(80); // Esc solo se distingue de una secuencia después de un timeout
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toContain("¿Qué pantalla transmitir?");
  expect(s.calls).toEqual([]);
  h.mockInput.pressKey("S");
  await Bun.sleep(5);
  await h.renderOnce();
  h.mockInput.pressArrow("down");
  h.mockInput.pressEnter();
  await h.renderOnce();
  expect(s.calls).toEqual(["start:HDMI-A-1"]);
  h.mockInput.pressKey("S");
  await h.renderOnce();
  expect(s.calls).toEqual(["start:HDMI-A-1", "stop"]);
  await s.actions.voice!.leaveVoice();
});

test("the mouse wheel moves the picker selection", async () => {
  const s = setup();
  const h = await render(s);
  await joinVoice(s);
  h.mockInput.pressKey("S");
  await Bun.sleep(5);
  await h.renderOnce();
  const { x, y } = find(h.captureCharFrame(), "DP-1 · 1920×1080");
  await h.mockMouse.scroll(x, y, "down");
  await h.renderOnce();
  h.mockInput.pressEnter();
  await h.renderOnce();
  expect(s.calls).toEqual(["start:HDMI-A-1"]);
  await s.actions.voice!.leaveVoice();
});

test("with a saved monitor that is still connected it streams right away (no picker)", async () => {
  const s = setup();
  s.store.dispatch({ type: "settings/set", patch: { streamMonitor: "HDMI-A-1" } });
  const h = await render(s);
  await joinVoice(s);
  h.mockInput.pressKey("S");
  await Bun.sleep(5);
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toContain("¿Qué pantalla transmitir?");
  expect(s.calls).toEqual(["start:HDMI-A-1"]);
  await s.actions.voice!.leaveVoice();
});

test("S outside a call only shows a notice", async () => {
  const s = setup();
  const h = await render(s);
  h.mockInput.pressKey("S");
  await Bun.sleep(5);
  await h.renderOnce();
  expect(s.calls).toEqual(["start:"]);
  expect(Object.values(s.store.getState().notices).map((n) => n.text)).toContain("entrá a un canal de voz para transmitir");
  expect(h.captureCharFrame()).not.toContain("¿Qué pantalla transmitir?");
});

test("someone else streaming shows 📺 en vivo next to their name (from self_stream)", async () => {
  const s = setup();
  const h = await render(s);
  expect(h.captureCharFrame()).toMatch(/○ R  Ramiro\s+📺/);
  s.store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: DEMO.guild, user_id: "900000000000000101", channel_id: DEMO.voice, self_stream: false } });
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toMatch(/○ R  Ramiro\s+📺/);
});

test("a stream error shows in the voice bar", async () => {
  const s = setup();
  const h = await render(s);
  await joinVoice(s);
  s.store.dispatch({ type: "voice/stream", patch: { status: "error", error: "no hay con qué capturar la pantalla" } });
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("✗ transmisión: no hay con qué");
  await s.actions.voice!.leaveVoice();
});
