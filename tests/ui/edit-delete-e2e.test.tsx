// Editar y borrar un mensaje propio de punta a punta: composer → acciones reales → REST (Discord falso) → store → UI.
// El gateway no manda nada: lo que se ve sale de la respuesta de Discord.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { createActions, type Actions } from "../../src/actions";
import { createClientProps } from "../../src/client-props/props";
import { createRestClient } from "../../src/rest/client";
import { createHttp } from "../../src/rest/http";
import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";
import { startFakeHttp } from "../fakes/fake-http";

const NEW_ID = "930000000000009001";

async function setup() {
  const store = buildDemoStore();
  const bodies: { method: string; path: string; body: any }[] = [];
  const fake = startFakeHttp(async (req) => {
    const path = new URL(req.url).pathname;
    const body: any = req.method === "DELETE" ? null : await req.json().catch(() => null);
    bodies.push({ method: req.method, path, body });
    if (req.method === "POST") {
      return Response.json({ id: NEW_ID, channel_id: DEMO.general, author: { id: DEMO.me, username: "gon" }, content: body.content, timestamp: new Date().toISOString(), nonce: body.nonce });
    }
    if (req.method === "PATCH") {
      return Response.json({ id: path.split("/").pop(), channel_id: DEMO.general, author: { id: DEMO.me, username: "gon" }, content: body.content, edited_timestamp: new Date().toISOString() });
    }
    return new Response(null, { status: 204 });
  });
  const http = createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: fake.url });
  const rest = createRestClient({ http, onUnauthorized: () => {} });
  const real = createActions({ store, rest, gateway: { send() {} } as never });
  const actions: Actions = { ...demoActions(store), send: real.send, edit: real.edit, remove: real.remove };
  const h = await testRender(() => <App store={store} actions={actions} onQuit={() => {}} />, { width: 160, height: 45 });
  await h.renderOnce();
  return { store, fake, bodies, h };
}

async function settle(h: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(15);
    await h.renderOnce();
  }
}

test("send → e edits it (PATCH, shown right away with (editado)) → dd y deletes it (DELETE, gone)", async () => {
  const { store, fake, bodies, h } = await setup();
  h.mockInput.pressKey("i");
  await h.mockInput.typeText("hola mundo");
  h.mockInput.pressEnter();
  await settle(h);
  // el eco del gateway (MESSAGE_CREATE) es lo que mete el mensaje enviado en el canal
  store.dispatch({ type: "gw", t: "MESSAGE_CREATE", d: { id: NEW_ID, channel_id: DEMO.general, author: { id: DEMO.me, username: "gon" }, content: "hola mundo", timestamp: new Date().toISOString() } });
  await settle(h);
  expect(h.captureCharFrame()).toContain("hola mundo");

  h.mockInput.pressEscape();
  await Bun.sleep(80);
  h.mockInput.pressKey("k"); // el último mensaje: el propio
  h.mockInput.pressKey("e");
  await settle(h);
  await h.mockInput.typeText(" editado");
  h.mockInput.pressEnter();
  await settle(h);
  h.mockInput.pressEscape(); // después de editar sigue en modo escritura: Esc vuelve a los atajos
  await Bun.sleep(80);
  expect(bodies.find((b) => b.method === "PATCH")).toEqual({ method: "PATCH", path: `/channels/${DEMO.general}/messages/${NEW_ID}`, body: { content: "hola mundo editado" } });
  expect(store.getState().messages[DEMO.general]!.byId[NEW_ID]!.content).toBe("hola mundo editado");
  expect(h.captureCharFrame()).toMatch(/hola mundo editado.*\(editado\)/);

  // después de editar el mensaje sigue seleccionado
  h.mockInput.pressKey("d");
  h.mockInput.pressKey("d");
  await settle(h);
  h.mockInput.pressKey("y");
  await settle(h);
  expect(bodies.at(-1)).toEqual({ method: "DELETE", path: `/channels/${DEMO.general}/messages/${NEW_ID}`, body: null });
  expect(store.getState().messages[DEMO.general]!.byId[NEW_ID]).toBeUndefined();
  expect(h.captureCharFrame()).not.toContain("hola mundo editado");
  fake.stop();
});

test("editing a message with a mention shows @Name and sends <@id> back", async () => {
  const { store, fake, bodies, h } = await setup();
  store.dispatch({ type: "gw", t: "MESSAGE_CREATE", d: { id: NEW_ID, channel_id: DEMO.general, author: { id: DEMO.me, username: "gon" }, content: "che <@900000000000000101> mirá", timestamp: new Date().toISOString() } });
  await settle(h);
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await settle(h);
  expect(h.captureCharFrame()).toContain("che @Ramiro mirá");
  await h.mockInput.typeText("!");
  h.mockInput.pressEnter();
  await settle(h);
  expect(bodies.find((b) => b.method === "PATCH")?.body).toEqual({ content: "che <@900000000000000101> mirá!" });
  fake.stop();
});

test("a failed edit keeps the text in the composer and says so", async () => {
  const { store, fake, h } = await setup();
  fake.stop();
  store.dispatch({ type: "gw", t: "MESSAGE_CREATE", d: { id: NEW_ID, channel_id: DEMO.general, author: { id: DEMO.me, username: "gon" }, content: "uno", timestamp: new Date().toISOString() } });
  await settle(h);
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await settle(h);
  await h.mockInput.typeText(" dos");
  h.mockInput.pressEnter();
  await Bun.sleep(300);
  await settle(h);
  const frame = h.captureCharFrame();
  expect(frame).toContain("no se pudo editar");
  expect(frame).toContain("uno dos");
  expect(store.getState().messages[DEMO.general]!.byId[NEW_ID]!.content).toBe("uno");
});
