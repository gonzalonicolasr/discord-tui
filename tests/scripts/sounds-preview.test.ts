import { describe, expect, test } from "bun:test";

import { runPreview } from "../../scripts/sounds-preview";
import { cueFrames } from "../../src/sounds/library";
import { CUES, renderCue } from "../../src/sounds/synth";
import type { SpawnLike } from "../../src/voice/audio-io";

function fakeSpawn(opts: { failWith?: number } = {}) {
  const calls: { cmd: string[]; bytes: number; ended: boolean }[] = [];
  const spawn: SpawnLike = (cmd) => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (resolveExit = resolve));
    const call = { cmd, bytes: 0, ended: false };
    calls.push(call);
    if (opts.failWith !== undefined) resolveExit(opts.failWith);
    return {
      stdin: {
        write: (chunk: Uint8Array) => void (call.bytes += chunk.byteLength),
        flush() {},
        end() {
          call.ended = true;
          resolveExit(0);
        },
      },
      stdout: null,
      stderr: new Response("target not found").body,
      exited,
      killed: false,
      kill: () => resolveExit(0),
    };
  };
  return { spawn, calls };
}

async function run(args: string[], opts: { failWith?: number } = {}) {
  const fake = fakeSpawn(opts);
  const lines: string[] = [];
  const code = await runPreview(args, { spawn: fake.spawn, sleep: async () => {}, print: (line) => lines.push(line) });
  return { code, lines, calls: fake.calls };
}

describe("sounds-preview script", () => {
  test("with no cue, plays the 12 cues in order through the default output, each named on screen", async () => {
    const { code, lines, calls } = await run([]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(CUES.length);
    CUES.forEach((cue, i) => {
      expect(calls[i]!.cmd.slice(0, 2)).toEqual(["pw-cat", "--playback"]);
      expect(calls[i]!.cmd).not.toContain("--target");
      expect(calls[i]!.bytes).toBe(cueFrames(cue).length * 3840);
      expect(calls[i]!.ended).toBe(true);
      expect(lines.some((line) => line.includes(cue))).toBe(true);
    });
  });

  test("one cue plays only that cue", async () => {
    const { code, calls, lines } = await run(["message"]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bytes).toBe(cueFrames("message").length * 3840);
    expect(lines.join("\n")).toContain("message");
  });

  test("--compare plays the old synthesized cue first and then the new one", async () => {
    const { code, calls, lines } = await run(["join", "--compare"]);
    expect(code).toBe(0);
    expect(calls.map((c) => c.bytes)).toEqual([renderCue("join").length * 3840, cueFrames("join").length * 3840]);
    expect(lines.filter((line) => line.includes("join"))).toHaveLength(2);
  });

  test("--synth plays only the old synthesized cues", async () => {
    const { calls } = await run(["--synth"]);
    expect(calls.map((c) => c.bytes)).toEqual(CUES.map((cue) => renderCue(cue).length * 3840));
  });

  test("--alt plays the alternatives in alt/ and skips cues without one", async () => {
    const { code, calls, lines } = await run(["--alt"]);
    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(CUES.length);
    expect(lines.join("\n")).toContain("alt");
  });

  test("an unknown cue prints the usage and plays nothing", async () => {
    const { code, calls, lines } = await run(["bogus"]);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("Uso");
  });

  test("if pw-cat cannot open, it says so and stops", async () => {
    const { code, lines } = await run(["join"], { failWith: 1 });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("pw-cat");
  });
});
