import { expect, test } from "bun:test";

import { generateRaKeys, type RaKeys } from "../../src/auth/ra-crypto";
import { createRemoteAuth, type RaEvent, type RemoteAuth } from "../../src/auth/remote-auth";
import { createClientProps } from "../../src/client-props/props";
import { createHttp } from "../../src/rest/http";
import { startFakeHttp, type FakeHttp } from "../fakes/fake-http";
import { startFakeRemoteAuth, type FakeRaScript, type FakeRemoteAuth } from "../fakes/fake-remote-auth";
import { fakeToken } from "../helpers/fake-token";

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, 5);
  });
}

async function encryptFor(publicSpkiB64: string, plain: string): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    Buffer.from(publicSpkiB64, "base64"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const cipher = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, new TextEncoder().encode(plain));
  return Buffer.from(cipher).toString("base64");
}

interface Harness {
  keys: RaKeys;
  fake: FakeRemoteAuth;
  http: FakeHttp;
  auth: RemoteAuth;
  events: RaEvent[];
  stop(): void;
}

async function startHarness(
  script: FakeRaScript = {},
  httpHandler?: (req: Request) => Response | Promise<Response>,
): Promise<Harness> {
  const keys = await generateRaKeys();
  let latest = keys;
  let generations = 0;

  const fake = startFakeRemoteAuth(script);
  const http = startFakeHttp(async (req) => {
    if (new URL(req.url).pathname.endsWith("/experiments")) {
      return Response.json({ fingerprint: "1234567890.fp-falso" }, { headers: { "Set-Cookie": "__dcfduid=galleta; Path=/; HttpOnly" } });
    }
    if (httpHandler) return httpHandler(req);
    return Response.json({ encrypted_token: await encryptFor(latest.publicSpkiB64, fakeToken()) });
  });

  const auth = createRemoteAuth({
    http: createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: http.url }),
    wsUrl: fake.url,
    makeKeys: async () => {
      generations += 1;
      if (generations > 1) latest = await generateRaKeys();
      return latest;
    },
  });

  const events: RaEvent[] = [];
  auth.on((event) => events.push(event));
  auth.start();

  return {
    keys,
    fake,
    http,
    auth,
    events,
    stop() {
      auth.stop();
      fake.stop();
      http.stop();
    },
  };
}

test("happy path: qr → scanned → token", async () => {
  const h = await startHarness();
  try {
    await waitFor(() => h.events.some((event) => event.type === "token"));
    expect(h.events.map((event) => event.type)).toEqual(["qr", "scanned", "token"]);
    const qr = h.events[0] as Extract<RaEvent, { type: "qr" }>;
    expect(qr.url).toBe(`https://discord.com/ra/${h.keys.fingerprint}`);
    const scanned = h.events[1] as Extract<RaEvent, { type: "scanned" }>;
    expect(scanned.username).toBe("gonfake");
    const tokenEvent = h.events[2] as Extract<RaEvent, { type: "token" }>;
    expect(tokenEvent.token.reveal()).toBe(fakeToken());
    expect(tokenEvent.userId).toBe("123");
    expect(h.fake.originHeader).toBe("https://discord.com");
  } finally {
    h.stop();
  }
});

test("nonce_proof answer is base64url without padding", async () => {
  const h = await startHarness();
  try {
    await waitFor(() => h.events.some((event) => event.type === "token"));
    const reply = h.fake.received.find((message) => message.op === "nonce_proof");
    expect(reply).toBeDefined();
    expect(reply.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(reply.nonce).not.toContain("=");
  } finally {
    h.stop();
  }
});

test("fingerprint mismatch reconnects with a fresh key pair", async () => {
  const h = await startHarness({ fingerprint: "wrong" });
  try {
    await waitFor(() => h.events.some((event) => event.type === "qr"));
    expect(h.fake.connections).toBe(2);
    const inits = h.fake.received.filter((message) => message.op === "init");
    expect(inits).toHaveLength(2);
    expect(inits[0]!.encoded_public_key).not.toBe(inits[1]!.encoded_public_key);
  } finally {
    h.stop();
  }
});

test("close 4003 produces a new qr without restarting", async () => {
  const h = await startHarness({ closeAfterQr: 4003 });
  try {
    await waitFor(() => h.events.filter((event) => event.type === "qr").length === 2);
    expect(h.fake.connections).toBe(2);
  } finally {
    h.stop();
  }
});

test("cancel emits cancelled and then a new qr", async () => {
  const h = await startHarness({ cancel: true });
  try {
    await waitFor(() => h.events.some((event) => event.type === "cancelled"));
    await waitFor(() => h.events.filter((event) => event.type === "qr").length === 2);
  } finally {
    h.stop();
  }
});

test("missing heartbeat_ack reconnects", async () => {
  const h = await startHarness({ noHeartbeatAck: true, heartbeatInterval: 50, stallAfterQr: true });
  try {
    await waitFor(() => h.fake.connections >= 2, 4000);
  } finally {
    h.stop();
  }
});

test("like the web client: fingerprint + Discord's cookies go with the ticket exchange (fewer captchas)", async () => {
  const h = await startHarness();
  try {
    await waitFor(() => h.events.some((event) => event.type === "token"));
    const paths = h.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toEqual(["GET /experiments", "POST /users/@me/remote-auth/login"]);
    const login = h.http.requests[1]!;
    expect(login.headers.get("x-fingerprint")).toBe("1234567890.fp-falso");
    expect(login.headers.get("cookie")).toBe("__dcfduid=galleta");
  } finally {
    h.stop();
  }
});

test("captcha on login emits captcha and stops", async () => {
  const h = await startHarness({}, () => Response.json({ captcha_key: ["captcha-required"] }, { status: 400 }));
  try {
    await waitFor(() => h.events.some((event) => event.type === "captcha"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.events.some((event) => event.type === "token")).toBe(false);
    expect(h.fake.connections).toBe(1);
  } finally {
    h.stop();
  }
});

test("4000/4001/4002 retry, 1000 after pending_login does not", async () => {
  for (const code of [4000, 4001, 4002]) {
    const h = await startHarness({ closeAfterQr: code });
    try {
      await waitFor(() => h.events.filter((event) => event.type === "qr").length === 2);
      expect(h.fake.connections).toBe(2);
    } finally {
      h.stop();
    }
  }

  const h = await startHarness();
  try {
    await waitFor(() => h.events.some((event) => event.type === "token"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.fake.connections).toBe(1);
  } finally {
    h.stop();
  }
});

test("login without encrypted_token reports the response keys", async () => {
  const h = await startHarness({}, () => Response.json({ message: "nope" }));
  try {
    await waitFor(() => h.events.some((event) => event.type === "error"));
    const errorEvent = h.events.find((event) => event.type === "error") as Extract<RaEvent, { type: "error" }>;
    expect(errorEvent.reason).toContain("login sin encrypted_token");
    expect(errorEvent.reason).toContain("message");
  } finally {
    h.stop();
  }
});

test("non-JSON login response reports the content type", async () => {
  const h = await startHarness({}, () => new Response("<html>nope</html>", { headers: { "content-type": "text/html" } }));
  try {
    await waitFor(() => h.events.some((event) => event.type === "error"));
    const errorEvent = h.events.find((event) => event.type === "error") as Extract<RaEvent, { type: "error" }>;
    expect(errorEvent.reason).toContain("text/html");
  } finally {
    h.stop();
  }
});

test("stop() while the ticket exchange is in flight: the token is never emitted", async () => {
  let loginArrived = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let answer: () => Promise<Response> = async () => Response.json({});
  const h = await startHarness({}, async () => {
    loginArrived = true;
    await gate;
    return answer();
  });
  try {
    answer = async () => Response.json({ encrypted_token: await encryptFor(h.keys.publicSpkiB64, fakeToken()) });
    await waitFor(() => loginArrived);
    h.auth.stop(); // el usuario canceló
    release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.events.some((event) => event.type === "token")).toBe(false);
  } finally {
    h.stop();
  }
});

async function gatedAuth(makeKeys: () => Promise<RaKeys>) {
  const fake = startFakeRemoteAuth({ stallAfterQr: true });
  const http = startFakeHttp(() => Response.json({}));
  const auth = createRemoteAuth({
    http: createHttp({ props: createClientProps({ buildNumber: 1 }), baseUrl: http.url }),
    wsUrl: fake.url,
    makeKeys,
  });
  const events: RaEvent[] = [];
  auth.on((event) => events.push(event));
  return { fake, auth, events, stop: () => (auth.stop(), fake.stop(), http.stop()) };
}

test("start() again while the keys are being made never leaves a second socket", async () => {
  const keys = await generateRaKeys();
  for (const restart of ["start-start", "stop-start"] as const) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const g = await gatedAuth(async () => (await gate, keys));
    try {
      g.auth.start();
      if (restart === "stop-start") g.auth.stop();
      g.auth.start();
      release();
      await waitFor(() => g.events.some((event) => event.type === "qr"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(g.fake.connections).toBe(1);
    } finally {
      g.stop();
    }
  }
});

test("a key generation failure reports an error instead of an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const g = await gatedAuth(async () => {
    throw new Error("no RSA");
  });
  try {
    g.auth.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    expect(g.events.map((event) => event.type)).toEqual(["error"]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    g.stop();
  }
});
