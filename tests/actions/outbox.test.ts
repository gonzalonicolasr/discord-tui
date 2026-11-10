import { expect, test } from "bun:test";

import { createActions } from "../../src/actions";
import { createSendActions } from "../../src/actions/send";
import { createClientProps } from "../../src/client-props/props";
import { createRestClient, type RestClient } from "../../src/rest/client";
import { createHttp } from "../../src/rest/http";
import { selectMessages, selectOutbox } from "../../src/store/selectors";
import { createStore, emptyState } from "../../src/store/store";
import { startFakeHttp } from "../fakes/fake-http";

const CH = "100000000000000002";
const gateway = { send() {} } as never;

function messageResponse(nonce: string) {
  return { id: "100000000000000900", channel_id: CH, author: { id: "1" }, content: "x", nonce };
}

test("429 then 200: waits retry_after and ends sent with 2 requests", async () => {
  let calls = 0;
  const fake = startFakeHttp(() => {
    calls += 1;
    if (calls === 1) return Response.json({ retry_after: 0.01, global: false }, { status: 429 });
    return Response.json(messageResponse(""));
  });

  const http = createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: fake.url });
  const rest = createRestClient({ http, onUnauthorized: () => {} });
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });

  await actions.send(CH, "hola");
  expect(selectOutbox(store.getState(), CH)).toHaveLength(0);
  expect(calls).toBe(2);
  fake.stop();
});

test("500: ends failed after exactly 1 request, no automatic retry", async () => {
  let calls = 0;
  const fake = startFakeHttp(() => {
    calls += 1;
    return Response.json({ code: 50035 }, { status: 500 });
  });

  const http = createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: fake.url });
  const rest = createRestClient({ http, onUnauthorized: () => {} });
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });

  await actions.send(CH, "hola");
  await Bun.sleep(120);

  const items = selectOutbox(store.getState(), CH);
  expect(items).toHaveLength(1);
  expect(items[0]!.state).toBe("failed");
  expect(calls).toBe(1);
  fake.stop();
});

test("network error ends failed with a visible error", async () => {
  const rest: RestClient = {
    closed: false,
    request: async () => {
      throw new TypeError("network");
    },
  };
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });
  await actions.send(CH, "hola");

  const items = selectOutbox(store.getState(), CH);
  expect(items[0]!.state).toBe("failed");
  expect(items[0]!.error).toBe("network");
});

test("retry resends with the same nonce", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const fake = startFakeHttp(async (req) => {
    calls += 1;
    const nonce = (JSON.parse(await req.text()) as { nonce: string }).nonce;
    bodies.push(nonce);
    if (calls === 1) return Response.json({ code: 50035 }, { status: 500 });
    return Response.json(messageResponse(nonce));
  });

  const http = createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: fake.url });
  const rest = createRestClient({ http, onUnauthorized: () => {} });
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });

  await actions.send(CH, "hola");
  const nonce = selectOutbox(store.getState(), CH)[0]!.nonce;
  await actions.retry(nonce);

  expect(bodies[0]).toBe(bodies[1]);
  expect(selectOutbox(store.getState(), CH)).toHaveLength(0);
  fake.stop();
});

test("gateway MESSAGE_CREATE with our nonce before the POST resolves leaves a single message", async () => {
  let release!: (value: any) => void;
  const rest: RestClient = {
    closed: false,
    request: async <T>(): Promise<T> =>
      new Promise<T>((resolve) => {
        release = resolve;
      }),
  };

  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });

  const pending = actions.send(CH, "x");
  const item = selectOutbox(store.getState(), CH)[0]!;
  store.dispatch({
    type: "gw",
    t: "MESSAGE_CREATE",
    d: { id: "100000000000000901", channel_id: CH, author: { id: "1" }, content: "x", nonce: item.nonce },
  });
  release(messageResponse(item.nonce));
  await pending;

  expect(selectMessages(store.getState(), CH).filter((message) => message.nonce === item.nonce)).toHaveLength(1);
  expect(selectOutbox(store.getState(), CH)).toHaveLength(0);
});

test("failed item stays after other messages arrive", async () => {
  const rest: RestClient = {
    closed: false,
    request: async () => {
      throw new TypeError("network");
    },
  };
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });
  await actions.send(CH, "x");

  store.dispatch({
    type: "gw",
    t: "MESSAGE_CREATE",
    d: { id: "100000000000000902", channel_id: CH, author: { id: "1" }, content: "otro" },
  });

  expect(selectOutbox(store.getState(), CH)).toHaveLength(1);
});

test("retry reuses the uploaded attachments instead of uploading again", async () => {
  let uploads = 0;
  let attempts = 0;
  const rest: RestClient = {
    closed: false,
    request: async <T>(): Promise<T> => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return { id: "100000000000000903", channel_id: CH, author: { id: "1" }, content: "x" } as T;
    },
  };
  const store = createStore(emptyState());
  const actions = createSendActions({
    store,
    rest,
    upload: async (_channelId, files) => {
      uploads += 1;
      return files.map((file) => ({ id: "0", filename: file.filename, uploaded_filename: `slot_${file.filename}` }));
    },
  });

  await actions.send(CH, "hola", { attachments: [{ filename: "a.png", mime: "image/png", bytes: new Uint8Array([1]) }] });
  const nonce = selectOutbox(store.getState(), CH)[0]!.nonce;
  await actions.retry(nonce);

  expect(uploads).toBe(1);
  expect(selectOutbox(store.getState(), CH)).toHaveLength(0);
});

test("different sends upload their own attachments", async () => {
  let uploads = 0;
  const rest: RestClient = {
    closed: false,
    request: async <T>(): Promise<T> => ({ id: "100000000000000904", channel_id: CH, author: { id: "1" }, content: "x" }) as T,
  };
  const store = createStore(emptyState());
  const actions = createSendActions({
    store,
    rest,
    upload: async (_channelId, files) => {
      uploads += 1;
      return files.map((file) => ({ id: "0", filename: file.filename, uploaded_filename: `slot_${file.filename}` }));
    },
  });

  await actions.send(CH, "uno", { attachments: [{ filename: "a.png", mime: "image/png", bytes: new Uint8Array([1]) }] });
  await actions.send(CH, "dos", { attachments: [{ filename: "b.png", mime: "image/png", bytes: new Uint8Array([2]) }] });

  expect(uploads).toBe(2);
});

test("a 403 Missing Permissions says it plainly instead of 'HTTP 403'", async () => {
  const fake = startFakeHttp(() => Response.json({ code: 50013, message: "Missing Permissions" }, { status: 403 }));
  const http = createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: fake.url });
  const rest = createRestClient({ http, onUnauthorized: () => {} });
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });
  await actions.send(CH, "hola");
  await Bun.sleep(50);
  const items = selectOutbox(store.getState(), CH);
  expect(items[0]!.state).toBe("failed");
  expect(items[0]!.error).toBe("no tenés permiso para escribir acá");
  fake.stop();
});
