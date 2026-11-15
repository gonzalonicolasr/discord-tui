import { expect, test } from "bun:test";

import { createVoiceStats } from "../../src/voice/stats";
import { formatPrivacyCode } from "../../src/voice/privacy-code";

test("stats log only allowlisted fields every 60 s", () => {
  const logged: { event: string; fields: unknown }[] = [];
  let tick: (() => void) | null = null;
  let every = 0;
  const stats = createVoiceStats({
    log: { info: (event, fields) => void logged.push({ event, fields }) },
    read: () => ({ packets: 120, decodeErrors: 2, state: "connected" }),
    setTimer: (fn, ms) => ((tick = fn), (every = ms), 1),
    clearTimer: () => (tick = null),
  });
  expect(every).toBe(60_000);
  tick!();
  expect(logged).toEqual([{ event: "voice.stats", fields: { packets: 120, decode_errors: 2, state: "connected" } }]);
  stats.stop();
  expect(tick).toBeNull();
});

test("privacy code is grouped by 5 digits", () => {
  expect(formatPrivacyCode("123451234512")).toBe("12345 12345 12");
});

test("stats also log the dropout diagnostics (aggregated counters only)", () => {
  const logged: { event: string; fields: unknown }[] = [];
  let tick: (() => void) | null = null;
  createVoiceStats({
    log: { info: (event, fields) => void logged.push({ event, fields }) },
    read: () => ({
      packets: 10,
      decodeErrors: 0,
      state: "connected",
      underruns: 3,
      jitterDrops: 1,
      jitterMsMax: 160,
      concealed: 5,
      arrivalP95Ms: 25,
      arrivalMaxMs: 140.4,
      lateTicks: 2,
      skippedFrames: 0,
      loopLagMaxMs: 61,
      playbackPending: 4,
      playbackDropped: 0,
    }),
    setTimer: (fn) => ((tick = fn), 1),
    clearTimer: () => {},
  });
  tick!();
  expect(logged[0]!.fields).toEqual({
    packets: 10,
    decode_errors: 0,
    state: "connected",
    underruns: 3,
    jitter_drops: 1,
    jitter_ms_max: 160,
    concealed: 5,
    arrival_p95_ms: 25,
    arrival_max_ms: 140,
    late_ticks: 2,
    skipped_frames: 0,
    loop_lag_max_ms: 61,
    playback_pending: 4,
    playback_dropped: 0,
  });
});
