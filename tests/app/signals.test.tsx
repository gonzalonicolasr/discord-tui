import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { testRender } from "@opentui/solid";

import type { Actions } from "../../src/actions";
import type { RaEvent } from "../../src/auth/remote-auth";
import { Root } from "../../src/app/root";
import type { Runtime } from "../../src/app/runtime";
import { RENDERER_EXIT_OPTIONS } from "../../src/app/signals";
import { createClientProps } from "../../src/client-props/props";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import { createStore, emptyState } from "../../src/store/store";

const noopAuth = { on: (_fn: (event: RaEvent) => void) => () => {}, start() {} };

function fakeRuntime(): Runtime {
  const actions = {
    selectGuild: () => {},
    openChannel: async () => {},
    loadOlder: async () => {},
    focus: () => {},
    toggleMembers: () => {},
    send: async () => {},
    retry: async () => {},
    edit: async () => {},
    remove: async () => {},
    toggleReaction: async () => {},
  } as Actions;
  return {
    store: createStore(emptyState()),
    actions,
    start() {},
    async stop() {},
    onUnauthorized: () => () => {},
    activity() {},
  };
}

async function mount(initialRuntime: Runtime | null) {
  const signals = new EventEmitter();
  const quits: Array<Runtime | null> = [];
  const rendered = await testRender(
    () => (
      <Root
        buildNumber={400000}
        settings={DEFAULT_SETTINGS}
        clientProps={createClientProps({ buildNumber: 400000 })}
        initialRuntime={initialRuntime}
        onQuit={(runtime) => quits.push(runtime)}
        kittyKeyboard={() => true}
        auth={noopAuth}
        signals={signals}
      />
    ),
    { width: 100, height: 30 },
  );
  await rendered.renderOnce();
  return { ...rendered, signals, quits };
}

test("OpenTUI no maneja señales ni Ctrl+C: solo destruiría la UI y dejaría el proceso vivo", () => {
  expect(RENDERER_EXIT_OPTIONS.exitSignals).toEqual([]);
  expect(RENDERER_EXIT_OPTIONS.exitOnCtrlC).toBe(false);
});

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT", "SIGQUIT"] as const) {
  test(`${signal} sale por onQuit con el runtime activo`, async () => {
    const runtime = fakeRuntime();
    const { signals, quits } = await mount(runtime);
    signals.emit(signal);
    expect(quits).toEqual([runtime]);
  });
}

test("una señal en el login sale con runtime null", async () => {
  const { signals, quits } = await mount(null);
  signals.emit("SIGTERM");
  expect(quits).toEqual([null]);
});

test("Ctrl+C sale por onQuit con el runtime activo", async () => {
  const runtime = fakeRuntime();
  const { mockInput, renderOnce, quits } = await mount(runtime);
  mockInput.pressKey("c", { ctrl: true });
  await renderOnce();
  expect(quits).toEqual([runtime]);
});
