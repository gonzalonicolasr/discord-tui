import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "discord-tui-automute-state-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "discord-tui-automute-config-"));

import { createRuntime } from "../../src/app/runtime";
import { createClientProps } from "../../src/client-props/props";
import type { SystemIdleEvents } from "../../src/desktop/wayland-idle";
import { Secret } from "../../src/secret";
import type { Cue } from "../../src/sounds/synth";
import { fakeToken } from "../helpers/fake-token";

const ME = "100000000000000010";

test("wired in the runtime: idle in a call mutes like the m key (Discord sees it), notifies, plays the mute cue; stop() stops watching", async () => {
  const flags: string[] = [];
  const cues: Cue[] = [];
  const notified: string[] = [];
  let events: SystemIdleEvents | null = null;
  let watching = 0;
  const statusListeners = new Set<(s: any) => void>();
  const runtime = createRuntime({
    session: { token: new Secret(fakeToken()), userId: ME, buildNumber: 663810 },
    me: { id: ME, username: "user1" },
    props: createClientProps({ buildNumber: 663810 }),
    checkUpdates: false,
    fetch: (async () => Response.json([])) as unknown as typeof fetch,
    sounds: { play: (cue) => void cues.push(cue) },
    notify: (title) => void notified.push(title),
    systemIdle: (_ms, on) => {
      events = on;
      watching += 1;
      return () => {
        watching -= 1;
      };
    },
    voiceSession: {
      join: async () => {},
      setFlags: (f) => void flags.push(`${f.selfMute}:${f.selfDeaf}`),
      leave: async () => statusListeners.forEach((fn) => fn("idle")),
      onStatus: (fn) => {
        statusListeners.add(fn);
        return () => statusListeners.delete(fn);
      },
      sendOpus() {},
      setSpeaking() {},
      onSpeaking: () => () => {},
      onOpus: () => () => {},
      privacyCode: () => null,
    },
  });
  runtime.store.dispatch({ type: "voice/joining", guildId: "100000000000000001", channelId: "100000000000000003" });
  expect(watching).toBe(1);
  events!.idle();
  expect(runtime.store.getState().voice.selfMute).toBe(true);
  expect(flags).toEqual(["true:false"]);
  expect(cues).toContain("mute");
  expect(notified).toHaveLength(1);
  await runtime.stop();
  expect(watching).toBe(0);
});
