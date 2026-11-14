import { expect, test } from "bun:test";
import type { KittyImageTransportStatus } from "@opentui/core";

import type { LogFields } from "../../src/log/logger";
import { logKittyTransport } from "../../src/ui/kitty";

function fakeRenderer(status: KittyImageTransportStatus) {
  return { kittyImageTransportStatus: status, capabilities: { kitty_graphics: true }, isDestroyed: false };
}

const base: KittyImageTransportStatus = { requested: "file", effective: "raw", fileState: "probing", fallback: "not-ready", pendingFiles: 0, pendingBytes: 0 };

test("logs the kitty image transport at start, on every change and periodically, without env values", async () => {
  const lines: { event: string; fields?: LogFields }[] = [];
  const renderer = fakeRenderer({ ...base });
  const env = { TERM_PROGRAM: "ghostty", SSH_TTY: "/dev/pts/9", TMPDIR: "/somewhere/private", TMUX: "", HC_TERMINAL_SOCKET: "/run/hc/private.sock" };
  const stop = logKittyTransport(renderer, { info: (event, fields) => void lines.push({ event, fields }) }, { env, everyMs: 5, periodicMs: 40 });

  await Bun.sleep(15);
  renderer.kittyImageTransportStatus = { ...base, effective: "file", fileState: "ready", fallback: "none", pendingFiles: 1 };
  await Bun.sleep(15);
  renderer.kittyImageTransportStatus = { ...base, effective: "file", fileState: "ready", fallback: "none", pendingFiles: 2 }; // solo cambian los contadores
  await Bun.sleep(40);
  stop();

  expect(lines.every((l) => l.event === "kitty.transport")).toBe(true);
  const states = lines.map((l) => l.fields?.state);
  expect(states[0]).toBe("start");
  expect(states.filter((s) => s === "change")).toHaveLength(1);
  expect(states).toContain("periodic");
  const start = JSON.parse(String(lines[0]!.fields!.msg));
  expect(start).toMatchObject({ requested: "file", effective: "raw", fileState: "probing", fallback: "not-ready", kitty_graphics: true, term_program: "ghostty" });
  expect(start.env).toEqual(["SSH_TTY", "TMPDIR", "HC_TERMINAL_SOCKET"]);
  const change = JSON.parse(String(lines.find((l) => l.fields?.state === "change")!.fields!.msg));
  expect(change).toMatchObject({ effective: "file", fileState: "ready", fallback: "none" });
  const all = JSON.stringify(lines);
  expect(all).not.toContain("/somewhere/private");
  expect(all).not.toContain("/dev/pts/9");
  expect(all).not.toContain("/run/hc/private.sock");
});

test("never throws from its timers when the native session is already closing", async () => {
  const lines: string[] = [];
  let closing = false;
  const renderer = {
    get kittyImageTransportStatus(): KittyImageTransportStatus {
      if (closing) throw new Error("NativeSession is closing or disposed");
      return base;
    },
    capabilities: null,
    isDestroyed: false, // OpenTUI cierra la sesión nativa antes de que esto llegue a true
  };
  const stop = logKittyTransport(renderer, { info: (event) => void lines.push(event) }, { env: {}, everyMs: 5, periodicMs: 5 });
  closing = true;
  await Bun.sleep(30);
  stop();
  expect(lines).toEqual(["kitty.transport"]);
});
