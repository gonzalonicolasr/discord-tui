import { expect, test } from "bun:test";

import { createAudioPlayer, formatDuration, isAudioAttachment, waveformBars } from "../../src/media/audio-player";

const URL_OK = "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1&is=2&hm=3";

function fakeSpawn(opts: { decodeExit?: number; throws?: boolean } = {}) {
  const calls: string[][] = [];
  const killed: string[] = [];
  const finish: Array<(code: number) => void> = [];
  const spawn = (cmd: string[]) => {
    if (opts.throws) throw new Error("ENOENT ffmpeg");
    calls.push(cmd);
    let done!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (done = resolve));
    finish.push(done);
    return { stdout: new ReadableStream<Uint8Array>(), exited, kill: () => (killed.push(cmd[0]!), done(143)) };
  };
  return { spawn, calls, killed, finish };
}

test("plays through ffmpeg → pw-cat on the chosen output, and a second toggle stops it", async () => {
  const fake = fakeSpawn();
  const player = createAudioPlayer({ spawn: fake.spawn as never, target: () => "alsa_output.usb-AE01", now: () => 1000 });
  player.toggle("att-1", URL_OK);
  expect(fake.calls[0]).toEqual(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", URL_OK, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]);
  expect(fake.calls[1]).toEqual(["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", "--target", "alsa_output.usb-AE01", "-"]);
  expect(player.state()).toMatchObject({ key: "att-1", status: "playing", startedAt: 1000 });
  player.toggle("att-1", URL_OK);
  expect(fake.killed).toEqual(["ffmpeg", "pw-cat"]);
  expect(player.state().status).toBe("idle");
});

test("when it ends it goes back to idle; a decode failure says so", async () => {
  const fake = fakeSpawn();
  const player = createAudioPlayer({ spawn: fake.spawn as never });
  player.toggle("a", URL_OK);
  fake.finish[0]!(0);
  fake.finish[1]!(0);
  await Bun.sleep(1);
  expect(player.state().status).toBe("idle");
  player.toggle("b", URL_OK);
  fake.finish[2]!(1);
  fake.finish[3]!(0);
  await Bun.sleep(1);
  expect(player.state()).toMatchObject({ key: "b", status: "error", error: "no se pudo reproducir ese audio" });
});

test("only Discord's CDN, and without ffmpeg it says what is missing", () => {
  const fake = fakeSpawn();
  const player = createAudioPlayer({ spawn: fake.spawn as never });
  player.toggle("x", "https://evil.example.com/a.ogg");
  expect(fake.calls).toEqual([]);
  expect(player.state()).toMatchObject({ status: "error", error: "ese audio no viene del CDN de Discord" });
  const noFfmpeg = createAudioPlayer({ spawn: fakeSpawn({ throws: true }).spawn as never });
  noFfmpeg.toggle("y", URL_OK);
  expect(noFfmpeg.state().error).toContain("hace falta ffmpeg");
});

test("waveform bars, duration and what counts as audio", () => {
  const wave = btoa(String.fromCharCode(0, 64, 128, 255));
  expect(waveformBars(wave, 4)).toBe("▁▃▅█");
  expect(waveformBars(undefined, 3)).toBe("▃▃▃");
  expect(formatDuration(72.4)).toBe("1:12");
  expect(isAudioAttachment({ content_type: "audio/ogg", filename: "voice-message.ogg" })).toBe(true);
  expect(isAudioAttachment({ filename: "tema.MP3" })).toBe(true);
  expect(isAudioAttachment({ content_type: "image/png", filename: "a.png" })).toBe(false);
});

test("if pw-cat fails to start, the ffmpeg already running is killed", () => {
  const killed: string[] = [];
  let n = 0;
  const spawn = (cmd: string[]) => {
    if (++n === 2) throw new Error("ENOENT pw-cat");
    return { stdout: new ReadableStream<Uint8Array>(), exited: new Promise<number>(() => {}), kill: () => killed.push(cmd[0]!) };
  };
  const player = createAudioPlayer({ spawn: spawn as never });
  player.toggle("z", URL_OK);
  expect(killed).toEqual(["ffmpeg"]);
  expect(player.state().error).toContain("hace falta ffmpeg");
});
