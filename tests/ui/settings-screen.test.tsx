import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { Actions } from "../../src/actions";
import { createStore, emptyState } from "../../src/store/store";
import { SettingsScreen, type SettingsDeps } from "../../src/ui/screens/SettingsScreen";

function setup(inVoice = false) {
  const store = createStore(emptyState());
  const actions = {} as Actions;
  const captured: Array<{ target?: string }> = [];
  const played: Array<{ target?: string }> = [];
  let stopped = 0;

  const fakeCapture = {
    onFrame(fn: (pcm: Uint8Array) => void) {
      fakeCapture.listener = fn;
      return () => {};
    },
    async stop() {
      stopped += 1;
    },
    listener: null as null | ((pcm: Uint8Array) => void),
  };
  const fakePlayback = {
    write() {},
    async stop() {},
    dropped: () => 0,
  };

  const deps: SettingsDeps = {
    listAudioDevices: async () => ({
      inputs: [
        { name: "mic1", description: "Mic 1" },
        { name: "mic2", description: "Mic 2" },
      ],
      outputs: [
        { name: "spk1", description: "Speaker 1" },
        { name: "spk2", description: "Speaker 2" },
      ],
    }),
    startCapture: async (opts) => {
      captured.push(opts ?? {});
      return fakeCapture as any;
    },
    startPlayback: async (opts) => {
      played.push(opts ?? {});
      return fakePlayback as any;
    },
  };

  return { store, actions, deps, captured, played, fakeCapture, inVoice, stopped: () => stopped };
}

describe("SettingsScreen", () => {
  test("lists devices from the fake pw-dump and saves the choice", async () => {
    const { store, actions, deps } = setup();
    const { mockInput, renderOnce } = await testRender(() => (
      <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />
    ));
    await renderOnce();
    mockInput.pressKey("l");
    await renderOnce();
    expect(store.getState().settings.inputDevice).toBe("mic1");
    mockInput.pressKey("l");
    await renderOnce();
    expect(store.getState().settings.inputDevice).toBe("mic2");
  });

  test("sensitivity h/l moves 3 dB and persists", async () => {
    const { store, actions, deps } = setup();
    store.dispatch({ type: "settings/set", patch: { vadSensitivity: -45 } });
    const { mockInput, renderOnce } = await testRender(() => (
      <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />
    ));
    await renderOnce();
    for (let i = 0; i < 3; i += 1) mockInput.pressKey("j");
    await renderOnce();
    mockInput.pressKey("l");
    await renderOnce();
    expect(store.getState().settings.vadSensitivity).toBe(-42);
  });

  test("probar mic starts and stops the echo", async () => {
    const { store, actions, deps, captured, stopped } = setup();
    const { mockInput, renderOnce } = await testRender(() => (
      <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />
    ));
    await renderOnce();
    for (let i = 0; i < 4; i += 1) mockInput.pressKey("j");
    await renderOnce();
    mockInput.pressEnter();
    await Bun.sleep(10);
    await renderOnce();
    expect(captured.length).toBe(1);
    mockInput.pressEnter();
    await Bun.sleep(10);
    await renderOnce();
    expect(stopped()).toBe(1);
  });

  test("probar mic is disabled while in voice", async () => {
    const { store, actions, deps, captured } = setup(true);
    const { mockInput, renderOnce, captureCharFrame } = await testRender(() => (
      <SettingsScreen store={store} actions={actions} deps={deps} inVoice={true} onClose={() => {}} />
    ));
    await renderOnce();
    for (let i = 0; i < 4; i += 1) mockInput.pressKey("j");
    await renderOnce();
    mockInput.pressEnter();
    await Bun.sleep(10);
    await renderOnce();
    expect(captured.length).toBe(0);
    expect(captureCharFrame()).toContain("salí de voz");
  });

  test("Esc closes", async () => {
    const { store, actions, deps } = setup();
    let closed = 0;
    const { mockInput, renderOnce } = await testRender(() => (
      <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => (closed += 1)} />
    ));
    await renderOnce();
    mockInput.pressKeys(["\u001b[27u"]);
    await Bun.sleep(1);
    await renderOnce();
    expect(closed).toBe(1);
  });

  test("Go Live rows: monitor cycles ask → each monitor, quality toggles 720p30/1080p30 with the Nitro note", async () => {
    const { store, deps } = setup();
    const actions = {
      voice: { listMonitors: async () => [{ name: "DP-1", width: 1920, height: 1080, focused: true }, { name: "HDMI-A-1", width: 1920, height: 1080, focused: false }] },
    } as unknown as Actions;
    const { mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />,
      { width: 90, height: 30 },
    );
    await Bun.sleep(5);
    await renderOnce();
    expect(captureCharFrame()).toContain("monitor: preguntar si hay más de uno");
    expect(captureCharFrame()).toContain("calidad: 720p30");
    for (let i = 0; i < 5; i += 1) mockInput.pressKey("j");
    mockInput.pressKey("l");
    await renderOnce();
    expect(store.getState().settings.streamMonitor).toBe("DP-1");
    mockInput.pressKey("l");
    mockInput.pressKey("l");
    await renderOnce();
    expect(store.getState().settings.streamMonitor).toBeNull();
    mockInput.pressKey("h");
    await renderOnce();
    expect(store.getState().settings.streamMonitor).toBe("HDMI-A-1");
    mockInput.pressKey("j");
    mockInput.pressEnter();
    await renderOnce();
    expect(store.getState().settings.streamQuality).toBe("1080p30");
    expect(captureCharFrame()).toContain("calidad: 1080p30 (puede necesitar Nitro)");
  });

  test("Sonidos rows: Enter toggles, h/l moves the volume by 10, a cue can be picked and silenced", async () => {
    const { store, actions, deps } = setup();
    const { mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />,
      { width: 90, height: 34 },
    );
    await Bun.sleep(5);
    await renderOnce();
    expect(captureCharFrame()).toContain("sonidos de eventos: sí");
    expect(captureCharFrame()).toContain("volumen de sonidos: 60%");
    expect(captureCharFrame()).toContain("entrar a voz: suena");

    for (let i = 0; i < 7; i += 1) mockInput.pressKey("j");
    mockInput.pressEnter();
    await renderOnce();
    expect(store.getState().settings.sounds.enabled).toBe(false);
    expect(captureCharFrame()).toContain("sonidos de eventos: no");
    mockInput.pressEnter();

    mockInput.pressKey("j");
    mockInput.pressKey("l");
    mockInput.pressKey("l");
    mockInput.pressKey("l");
    mockInput.pressKey("l");
    mockInput.pressKey("l");
    await renderOnce();
    expect(store.getState().settings.sounds.volume).toBe(100);
    mockInput.pressKey("h");
    await renderOnce();
    expect(captureCharFrame()).toContain("volumen de sonidos: 90%");

    mockInput.pressKey("j");
    mockInput.pressKey("l"); // leave
    mockInput.pressKey("l"); // userJoin
    await renderOnce();
    expect(captureCharFrame()).toContain("alguien entra a tu canal: suena");
    mockInput.pressEnter();
    await renderOnce();
    expect(store.getState().settings.sounds.events.userJoin).toBe(false);
    expect(store.getState().settings.sounds.events.join).toBe(true);
    expect(captureCharFrame()).toContain("alguien entra a tu canal: no suena");
  });

  test("animar GIFs y emojis toggles animateImages (default on), next to imágenes inline", async () => {
    const { store, actions, deps } = setup();
    expect(store.getState().settings.animateImages).toBe(true);
    const { mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />,
      { width: 90, height: 40 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("animar GIFs y emojis: sí");
    for (let i = 0; i < 20; i += 1) mockInput.pressKey("j");
    mockInput.pressKey("k");
    await renderOnce();
    mockInput.pressEnter();
    await renderOnce();
    expect(store.getState().settings.animateImages).toBe(false);
    expect(store.getState().settings.inlineImages).toBe(true);
    expect(captureCharFrame()).toContain("animar GIFs y emojis: no (primer cuadro)");
  });

  test("avatares toggles showAvatars (default on), last row under the image options", async () => {
    const { store, actions, deps } = setup();
    expect(store.getState().settings.showAvatars).toBe(true);
    const { mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />,
      { width: 90, height: 40 },
    );
    await renderOnce();
    expect(captureCharFrame()).toMatch(/animar GIFs y emojis: sí\s*│?\s*│?\s*avatares: sí/);
    for (let i = 0; i < 20; i += 1) mockInput.pressKey("j");
    await renderOnce();
    mockInput.pressEnter();
    await renderOnce();
    expect(store.getState().settings.showAvatars).toBe(false);
    expect(store.getState().settings.animateImages).toBe(true);
    expect(captureCharFrame()).toContain("avatares: no");
  });
  test("Llamadas: 'entrar a voz silenciado' is on by default and Enter turns it off, under the sound rows", async () => {
    const { store, actions, deps } = setup();
    const { mockInput, renderOnce, captureCharFrame } = await testRender(
      () => <SettingsScreen store={store} actions={actions} deps={deps} inVoice={false} onClose={() => {}} />,
      { width: 90, height: 44 },
    );
    await renderOnce();
    expect(captureCharFrame()).toMatch(/Llamadas[\s│]*entrar a voz silenciado: sí/);
    for (let i = 0; i < 10; i += 1) mockInput.pressKey("j");
    await renderOnce();
    mockInput.pressEnter();
    await renderOnce();
    expect(store.getState().settings.joinMuted).toBe(false);
    expect(captureCharFrame()).toContain("entrar a voz silenciado: no");
  });
});
