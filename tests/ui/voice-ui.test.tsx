import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { Actions } from "../../src/actions";
import type { VoiceActions } from "../../src/actions/voice";
import { App } from "../../src/ui/App";
import { buildDemoStore, DEMO } from "../../scripts/demo-state";

function setup() {
  const store = buildDemoStore();
  const calls: string[] = [];
  const voice: VoiceActions = {
    toggleVoice: async (id) => void calls.push(`toggle:${id}`),
    leaveVoice: async () => void calls.push("leave"),
    toggleMute: () => void calls.push("mute"),
    toggleDeaf: () => void calls.push("deaf"),
    setInputMode: (m) => void calls.push(`mode:${m}`),
    toggleInputMode: () => void calls.push("inputMode"),
    pttKey: (e) => void calls.push(`ptt:${e.eventType}`),
    micLevel: () => null,
  };
  const actions: Actions = {
    selectGuild: (id) => store.dispatch({ type: "ui/selectGuild", id }),
    openChannel: async (id) => store.dispatch({ type: "ui/selectChannel", id }),
    loadOlder: async () => {},
    focus: (focus) => store.dispatch({ type: "ui/focus", focus }),
    toggleMembers: () => store.dispatch({ type: "ui/toggleMembers" }),
    send: async () => {},
    retry: async () => {},
    edit: async () => {},
    remove: async () => {},
    toggleReaction: async () => {},
    voice,
  };
  return { store, actions, calls };
}

async function render(setupResult: ReturnType<typeof setup>, width = 160, height = 45) {
  return testRender(() => <App store={setupResult.store} actions={setupResult.actions} onQuit={() => {}} />, { width, height });
}

test("participants appear under the voice channel with mute/deaf badges", async () => {
  const s = setup();
  const { captureCharFrame, renderOnce } = await render(s);
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("🔊 Sala 1");
  expect(frame).toMatch(/○ R  Ramiro/);
  expect(frame).toMatch(/Celes💜\s+🔇/);
  expect(frame).toMatch(/Pepa\s+🙉/);
});

test("connected bar shows channel, E2EE with the privacy code, input mode and who speaks", async () => {
  const s = setup();
  s.store.dispatch({ type: "voice/joining", guildId: DEMO.guild, channelId: DEMO.voice });
  s.store.dispatch({ type: "voice/status", status: "connected" });
  s.store.dispatch({ type: "voice/privacyCode", code: "1234512345" });
  s.store.dispatch({ type: "voice/speaking", userId: "900000000000000101", on: true });
  s.store.dispatch({ type: "voice/selfSpeaking", on: true });
  s.store.dispatch({ type: "voice/flags", selfMute: true, selfDeaf: false, muteBeforeDeaf: false });
  const { captureCharFrame, renderOnce } = await render(s);
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("🔊 Sala 1 · Los Andes · 🔒 E2EE 12345 12345 · VAD · ● vos 🔇");
  expect(frame).toContain("hablando: Ramiro");
  expect(frame).toMatch(/● R  Ramiro/);
});

test("a voice error is shown in the bar", async () => {
  const s = setup();
  s.store.dispatch({ type: "voice/left", error: "Discord exige cifrado E2EE (DAVE) y no se pudo negociar" });
  const { captureCharFrame, renderOnce } = await render(s);
  await renderOnce();
  expect(captureCharFrame()).toContain("✗ voz: Discord exige cifrado E2EE (DAVE) y no se pudo negociar");
});

test("v on a selected voice channel toggles voice; Enter only opens its chat", async () => {
  const s = setup();
  s.store.dispatch({ type: "ui/selectChannel", id: DEMO.voice });
  s.store.dispatch({ type: "ui/focus", focus: "channels" });
  const { mockInput, renderOnce } = await render(s);
  await renderOnce();
  mockInput.pressEnter();
  await renderOnce();
  expect(s.calls).toEqual([]);
  expect(s.store.getState().ui.focus).toBe("messages");
  mockInput.pressKey("v");
  await renderOnce();
  expect(s.calls).toEqual([`toggle:${DEMO.voice}`]);
});

test("v while connected asks for a second v before leaving (a stray key does not cut the call)", async () => {
  const s = setup();
  s.store.dispatch({ type: "voice/joining", guildId: DEMO.guild, channelId: DEMO.voice });
  const { mockInput, renderOnce, captureCharFrame } = await render(s);
  await renderOnce();
  mockInput.pressKey("v");
  await renderOnce();
  expect(s.calls).toEqual([]);
  expect(captureCharFrame()).toContain("apretá v otra vez para salir de la llamada");
  mockInput.pressKey("v");
  await renderOnce();
  expect(s.calls).toEqual(["leave"]);
});

test("on the voice channel you are in, v also needs a second press to leave", async () => {
  const s = setup();
  s.store.dispatch({ type: "voice/joining", guildId: DEMO.guild, channelId: DEMO.voice });
  s.store.dispatch({ type: "ui/selectChannel", id: DEMO.voice });
  const { mockInput, renderOnce } = await render(s);
  await renderOnce();
  mockInput.pressKey("v");
  await renderOnce();
  expect(s.calls).toEqual([]);
  mockInput.pressKey("v");
  await renderOnce();
  expect(s.calls).toEqual([`toggle:${DEMO.voice}`]);
});

test("m, D and M dispatch mute, deafen and input mode", async () => {
  const s = setup();
  const { mockInput, renderOnce } = await render(s);
  await renderOnce();
  mockInput.pressKey("m");
  mockInput.pressKey("D");
  mockInput.pressKey("M");
  await renderOnce();
  expect(s.calls).toEqual(["mute", "deaf", "inputMode"]);
});

test("space goes to PTT only in normal mode; typing in the composer does not transmit", async () => {
  const s = setup();
  const { mockInput, renderOnce } = await render(s);
  await renderOnce();
  mockInput.pressKey(" ");
  mockInput.pressKey("i");
  mockInput.pressKey(" ");
  await renderOnce();
  expect(s.calls).toEqual(["ptt:press"]);
});

test("j walks into a voice channel's participants and +/- change their volume", async () => {
  const s = setup();
  s.store.dispatch({ type: "ui/selectChannel", id: DEMO.voice });
  s.store.dispatch({ type: "ui/focus", focus: "channels" });
  const { mockInput, renderOnce, captureCharFrame } = await render(s);
  await renderOnce();
  mockInput.pressKey("j"); // primer participante (Ramiro)
  mockInput.pressKey("-");
  mockInput.pressKey("-");
  await renderOnce();
  expect(s.store.getState().settings.userVolumes["900000000000000101"]).toBe(80);
  expect(captureCharFrame()).toMatch(/Ramiro\s+80%/);
  expect(s.calls).toEqual([]);
});

test("with the kitty protocol, holding Space sends press, repeats and release to PTT", async () => {
  const s = setup();
  const { mockInput, renderOnce } = await render(s);
  await renderOnce();
  mockInput.pressKeys(["\u001b[32u", "\u001b[32;1:2u", "\u001b[32;1:3u"]);
  await renderOnce();
  expect(s.calls).toEqual(["ptt:press", "ptt:repeat", "ptt:release"]);
});

test("KITTY_KEYBOARD asks for all keys as escapes so Space reports its release", async () => {
  const { buildKittyKeyboardFlags } = await import("@opentui/core");
  const { KITTY_KEYBOARD } = await import("../../src/ui/kitty");
  expect(buildKittyKeyboardFlags(KITTY_KEYBOARD) & 0b1010).toBe(0b1010);
});

test("holding v or m (auto-repeat) toggles only once", async () => {
  const s = setup();
  s.store.dispatch({ type: "ui/selectChannel", id: DEMO.voice });
  s.store.dispatch({ type: "ui/focus", focus: "channels" });
  const { mockInput, renderOnce } = await render(s);
  await renderOnce();
  mockInput.pressKeys(["\u001b[118u", "\u001b[118;1:2u", "\u001b[118;1:2u", "\u001b[109u", "\u001b[109;1:2u"]);
  await renderOnce();
  expect(s.calls).toEqual([`toggle:${DEMO.voice}`, "mute"]);
});
