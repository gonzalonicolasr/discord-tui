import { expect, test } from "bun:test";

import { createActions } from "../../src/actions";
import { createClientProps } from "../../src/client-props/props";
import { createRestClient } from "../../src/rest/client";
import { createHttp } from "../../src/rest/http";
import { createStore, emptyState } from "../../src/store/store";
import { startFakeHttp } from "../fakes/fake-http";

const gateway = { send() {} } as never;

function setup(handler: (req: Request) => Response | Promise<Response>) {
  const fake = startFakeHttp(handler);
  const http = createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: fake.url });
  const rest = createRestClient({ http, onUnauthorized: () => {} });
  const store = createStore(emptyState());
  const actions = createActions({ store, rest, gateway: gateway as never });
  return { fake, actions };
}

test("edit sends PATCH with the content", async () => {
  const { fake, actions } = setup(() => Response.json({ id: "223456789012345678" }));
  await actions.edit("123456789012345678", "223456789012345678", "nuevo");

  expect(fake.requests[0]!.method).toBe("PATCH");
  expect(new URL(fake.requests[0]!.url).pathname).toBe("/channels/123456789012345678/messages/223456789012345678");
  fake.stop();
});

test("remove sends DELETE", async () => {
  const { fake, actions } = setup(() => new Response(null, { status: 204 }));
  await actions.remove("123456789012345678", "223456789012345678");

  expect(fake.requests[0]!.method).toBe("DELETE");
  expect(new URL(fake.requests[0]!.url).pathname).toBe("/channels/123456789012345678/messages/223456789012345678");
  fake.stop();
});

test("edit with kept attachments sends their ids (Discord removes the rest)", async () => {
  const bodies: unknown[] = [];
  const { fake, actions } = setup(async (req) => {
    bodies.push(await req.json());
    return Response.json({ id: "223456789012345678" });
  });
  await actions.edit("123456789012345678", "223456789012345678", "nuevo", ["900000000000000001"]);
  await actions.edit("123456789012345678", "223456789012345678", "sin tocar adjuntos");
  expect(bodies).toEqual([{ content: "nuevo", attachments: [{ id: "900000000000000001" }] }, { content: "sin tocar adjuntos" }]);
  fake.stop();
});
