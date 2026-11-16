import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCueLibrary, cueDurationMs, cueFrames, defaultSoundsDir, preloadCuesLater } from "../../src/sounds/library";
import { CUES, PEAK, renderCue, type Cue } from "../../src/sounds/synth";
import { parseWav } from "../../src/sounds/wav";
import { sampleAt } from "../helpers/pcm";
import { loudness } from "../helpers/loudness";
import { makeWav } from "../helpers/wav";

function samples(frames: Uint8Array[]): number[] {
  const out: number[] = [];
  for (const frame of frames) for (let i = 0; i < frame.byteLength / 2; i += 1) out.push(sampleAt(frame, i));
  return out;
}

/** Sonoridad a la que se normalizaron los WAV al convertirlos (ver CREDITS.md). */
const TARGET_LUFS = -21.7;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "zcord-sounds-"));
}

function withWarnings(dir: string) {
  const warnings: { cue: Cue; reason: string }[] = [];
  const lib = createCueLibrary({ dir, warn: (cue, reason) => warnings.push({ cue, reason }) });
  return { lib, warnings };
}

describe("cue library: fallback to the synthesized cue", () => {
  test("a missing file falls back to the synth cue and logs it once", () => {
    const { lib, warnings } = withWarnings(tempDir());
    expect(lib.frames("join")).toEqual(renderCue("join"));
    lib.frames("join");
    expect(warnings).toEqual([{ cue: "join", reason: "missing" }]);
    expect(lib.durationMs("join")).toBe(renderCue("join").length * 20);
  });

  test("a truncated, odd-format or too-long file falls back too, each with its reason", () => {
    const dir = tempDir();
    const good = makeWav({ ms: 100, sample: 500 });
    writeFileSync(join(dir, "leave.wav"), good.subarray(0, good.byteLength - 7));
    writeFileSync(join(dir, "mute.wav"), makeWav({ ms: 100, rate: 44_100 }));
    writeFileSync(join(dir, "unmute.wav"), makeWav({ ms: 1500 }));
    const { lib, warnings } = withWarnings(dir);
    expect(lib.frames("leave")).toEqual(renderCue("leave"));
    expect(lib.frames("mute")).toEqual(renderCue("mute"));
    expect(lib.frames("unmute")).toEqual(renderCue("unmute"));
    expect(warnings).toEqual([
      { cue: "leave", reason: "truncated" },
      { cue: "mute", reason: "format" },
      { cue: "unmute", reason: "too-long" },
    ]);
  });

  test("a read error never throws: synth cue, reason logged", () => {
    const warnings: string[] = [];
    const lib = createCueLibrary({
      dir: "/nowhere",
      readFile: () => {
        throw new Error("EACCES");
      },
      warn: (_cue, reason) => warnings.push(reason),
    });
    expect(lib.frames("message")).toEqual(renderCue("message"));
    expect(warnings).toEqual(["unreadable"]);
  });

  test("no sounds folder at all: every cue is the synth one", () => {
    const { lib, warnings } = withWarnings(join(tempDir(), "nope"));
    for (const cue of CUES) expect(lib.frames(cue)).toEqual(renderCue(cue));
    expect(warnings).toHaveLength(CUES.length);
  });

  test("a valid file is used instead of the synth cue and cached", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "message.wav"), makeWav({ ms: 90, sample: 1234 }));
    const { lib, warnings } = withWarnings(dir);
    const frames = lib.frames("message");
    expect(frames).toHaveLength(5);
    expect(sampleAt(frames[0]!, 0)).toBe(1234);
    expect(lib.frames("message")).toBe(frames);
    expect(lib.durationMs("message")).toBe(100);
    expect(warnings).toEqual([]);
  });
});

describe("cue library: preload", () => {
  test("preload reads the 12 files once, so the first play does not touch the disk", () => {
    const reads: string[] = [];
    const wav = makeWav({ ms: 60, sample: 100 });
    const lib = createCueLibrary({ dir: "/sounds", readFile: (path) => (reads.push(path), wav), warn: () => {} });
    lib.preload();
    expect(reads).toHaveLength(CUES.length);
    for (const cue of CUES) lib.frames(cue);
    expect(reads).toHaveLength(CUES.length);
  });

  test("a broken file during preload still falls back to the synth cue, logged once", () => {
    const warnings: string[] = [];
    const lib = createCueLibrary({ dir: join(tempDir(), "nope"), warn: (cue) => warnings.push(cue) });
    lib.preload();
    expect(lib.frames("join")).toEqual(renderCue("join"));
    expect(warnings).toEqual([...CUES]);
  });

  test("at startup the preload is deferred: scheduled, not run on the spot", () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    let ran = 0;
    preloadCuesLater({ schedule: (fn, ms) => void scheduled.push({ fn, ms }), preload: () => (ran += 1) });
    expect(ran).toBe(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBeGreaterThan(0);
    scheduled[0]!.fn();
    expect(ran).toBe(1);
  });
});

describe("cue library: where the sounds live", () => {
  test("from source (bun run dev, tests): next to the module, src/sounds/wav", () => {
    expect(defaultSoundsDir()).toBe(join(import.meta.dir, "..", "..", "src", "sounds", "wav"));
  });

  test("compiled (dist/src/main.js or dist/scripts/demo.js): the repo's src/sounds/wav", () => {
    const repo = tempDir();
    mkdirSync(join(repo, "src", "sounds", "wav"), { recursive: true });
    mkdirSync(join(repo, "dist", "src"), { recursive: true });
    expect(defaultSoundsDir(join(repo, "dist", "src"))).toBe(join(repo, "src", "sounds", "wav"));
    expect(defaultSoundsDir(join(repo, "dist", "scripts"))).toBe(join(repo, "src", "sounds", "wav"));
  });
});

/** Tope por evento: join/leave/disconnect pueden durar un poco más. */
const MAX_MS: Partial<Record<Cue, number>> = { join: 500, leave: 500, disconnect: 460 };

describe("shipped sounds (src/sounds/wav)", () => {
  const { lib, warnings } = withWarnings(defaultSoundsDir());

  for (const cue of CUES) {
    test(`${cue}: a real file (not the synth fallback), 20 ms frames, short, no clipping, soft edges`, () => {
      const frames = lib.frames(cue);
      expect(warnings.filter((w) => w.cue === cue)).toEqual([]);
      expect(frames).not.toEqual(renderCue(cue));
      for (const frame of frames) expect(frame.byteLength).toBe(3840);
      expect(lib.durationMs(cue)).toBeGreaterThanOrEqual(80);
      expect(lib.durationMs(cue)).toBeLessThanOrEqual(MAX_MS[cue] ?? 400);

      const s = samples(frames);
      const peak = Math.max(...s.map(Math.abs));
      expect(peak).toBeLessThanOrEqual(PEAK);
      expect(peak).toBeGreaterThan(32767 * 10 ** (-20 / 20));
      // Fundidos: arranca y termina en casi cero (estéreo intercalado → 2 muestras por instante).
      expect(Math.max(...s.slice(0, 4).map(Math.abs))).toBeLessThan(PEAK * 0.05);
      expect(Math.max(...s.slice(-96).map(Math.abs))).toBeLessThan(PEAK * 0.05);
      // Sin clicks: ningún salto brusco entre muestras seguidas del mismo canal.
      let maxStep = 0;
      for (let i = 2; i < s.length; i += 2) maxStep = Math.max(maxStep, Math.abs(s[i]! - s[i - 2]!));
      expect(maxStep).toBeLessThan(PEAK * 0.25);
    });
  }

  for (const cue of CUES) {
    const target = cue === "userJoin" || cue === "userLeave" ? TARGET_LUFS - 3 : TARGET_LUFS;
    test(`${cue}: at the loudness it was normalized to, ${target} LUFS ±1 dB`, () => {
      // Canal izquierdo (los dos son iguales), de −1 a 1.
      const left = samples(lib.frames(cue)).filter((_, i) => i % 2 === 0);
      const measured = loudness(Float64Array.from(left, (v) => v / 32767));
      expect(Math.abs(measured - target)).toBeLessThanOrEqual(1);
    });
  }

  test("the files themselves are 48 kHz stereo s16 PCM WAV", async () => {
    for (const cue of CUES) {
      const bytes = new Uint8Array(await Bun.file(join(defaultSoundsDir(), `${cue}.wav`)).arrayBuffer());
      expect(parseWav(bytes).durationMs).toBeGreaterThan(0);
    }
  });

  test("the default library (used by the player) loads the shipped files", () => {
    for (const cue of CUES) expect(cueFrames(cue)).toEqual(lib.frames(cue));
    expect(cueDurationMs("join")).toBe(lib.durationMs("join"));
  });
});
