import { expect, test } from "bun:test";

import { createActions } from "../../src/actions";
import { selectMessages } from "../../src/store/selectors";
import { createStore, emptyState } from "../../src/store/store";

const CH = "100000000000000002";
const id = (n: number) => String(100000000000000000n + BigInt(n) * 1000n);
const msg = (n: number) => ({ id: id(n), channel_id: CH, content: "m" + n, author: { id: "7", username: "u" }, timestamp: "2026-01-01T00:00:00Z" });
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => msg(from + i));
const gw = { send() {} } as any;

function fakeRest(handler: (path: string) => unknown) {
  const paths: string[] = [];
  return { paths, rest: { closed: false, request: async (_method: string, path: string) => (paths.push(path), handler(path)) } as any };
}

function withDm() {
  const store = createStore(emptyState());
  store.dispatch({
    type: "gw",
    t: "READY",
    d: { user: { id: "1", username: "me" }, guilds: [], private_channels: [{ id: CH, type: 1, recipients: [{ id: "7", username: "u" }], last_message_id: id(1) }] },
  });
  return store;
}

const ids = (store: ReturnType<typeof withDm>) => selectMessages(store.getState(), CH).map((m) => m.id);

test("opening a channel whose only message came from MESSAGE_CREATE still loads its history", async () => {
  const store = withDm();
  store.dispatch({ type: "gw", t: "MESSAGE_CREATE", d: msg(2000) });
  const { rest, paths } = fakeRest(() => [...range(1951, 49), msg(2000)].reverse());
  await createActions({ store, rest, gateway: gw }).openChannel(CH);
  expect(paths.length).toBe(1);
  expect(ids(store).length).toBe(50);
  expect(ids(store).at(-1)).toBe(id(2000));
});
