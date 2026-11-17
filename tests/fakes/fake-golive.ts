/**
 * Librería de Go Live FALSA (misma forma que @dank074/discord-video-stream para lo que usa src/golive) y una
 * captura falsa, para probar el controlador sin red, sin pantalla y sin procesos.
 */
import { Readable } from "node:stream";

import type { CaptureHandle } from "../../src/golive/capture";
import type { GoLiveLib } from "../../src/golive/shim";

export function fakeGoLiveLib() {
  const streamers: any[] = [];
  /** Resuelve el createStream pendiente (como el select_protocol_ack). */
  let pendingCreate: Array<(videoCodec: string) => void> = [];
  const wsListeners: Array<(e: { code: number }) => void> = [];

  class Streamer {
    _voiceConnection: any;
    created = false;
    constructor(public client: any) {
      streamers.push(this);
    }
    get voiceConnection() {
      return this._voiceConnection;
    }
    createStream(): Promise<unknown> {
      const vc = this._voiceConnection;
      if (!vc?.session_id) return Promise.reject(new Error("Session doesn't exist yet"));
      const key = `guild:${vc.guildId}:${vc.channelId}:${vc.botId}`;
      this.created = true;
      this.client.ws.broadcast({ op: 18, d: { type: "guild", guild_id: vc.guildId, channel_id: vc.channelId, preferred_region: null } });
      this.client.ws.broadcast({ op: 22, d: { stream_key: key, paused: false } });
      // Como la real: la StreamConnection existe desde createStream() y el op 4 pasa por su handleProtocolAck.
      const media: any = { handleProtocolAck(_d: unknown) {}, ws: { addEventListener: (_ev: string, fn: (e: { code: number }) => void) => wsListeners.push(fn) } };
      vc.streamConnection = media;
      return new Promise((resolve) => {
        pendingCreate.push((videoCodec) => {
          media.handleProtocolAck({ video_codec: videoCodec, audio_codec: "opus", dave_protocol_version: 1 });
          resolve({ mediaConnection: media });
        });
      });
    }
    stopStream(): void {
      if (!this.created) return;
      this.created = false;
      const vc = this._voiceConnection;
      this.client.ws.broadcast({ op: 19, d: { stream_key: `guild:${vc.guildId}:${vc.channelId}:${vc.botId}` } });
    }
  }

  class VoiceConnection {
    session_id: string | null = null;
    streamConnection: unknown;
    constructor(_s: unknown, public guildId: string | null, public botId: string, public channelId: string) {}
  }

  const plays: Array<{ input: unknown; options: unknown; finish(): void; fail(e: Error): void }> = [];
  const lib: GoLiveLib = {
    Streamer: Streamer as any,
    VoiceConnection: VoiceConnection as any,
    playStream(input, streamer, options, signal) {
      return new Promise<void>((resolve, reject) => {
        const entry = { input, options, finish: resolve, fail: reject };
        plays.push(entry);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        // como la real: después del demux pide el stream
        streamer.createStream().catch(reject);
      });
    },
  };

  return {
    lib,
    streamers,
    plays,
    /** Discord contestó (op 4 con ese `video_codec`): el WS del stream quedó listo. */
    ready: async (videoCodec = "H264") => {
      const fns = pendingCreate;
      pendingCreate = [];
      fns.forEach((fn) => fn(videoCodec));
      await Bun.sleep(1);
    },
    closeWs: (code: number) => wsListeners.forEach((fn) => fn({ code })),
  };
}

export function fakeCapture(opts: { failWithAudio?: boolean; audioReady?: Promise<boolean> | boolean } = {}) {
  const started: Array<{ backend: string; encoder: string; monitor: string; quality: unknown; audio: boolean; audioSource?: string }> = [];
  let stops = 0;
  let endFns: Array<() => void> = [];
  const start = (o: { backend: any; encoder: any; monitor: string; quality: any; audio?: boolean; audioSource?: string }): CaptureHandle => {
    const audio = o.audio ?? false;
    started.push({ backend: o.backend, encoder: o.encoder, monitor: o.monitor, quality: o.quality, audio, ...(o.audioSource ? { audioSource: o.audioSource } : {}) });
    if (audio && opts.failWithAudio) throw new Error("pw-record no arrancó");
    let alive = true;
    return {
      output: Readable.from([]),
      audioReady: audio ? Promise.resolve(opts.audioReady ?? true) : Promise.resolve(true),
      ended: new Promise<void>((resolve) => endFns.push(resolve)),
      pids: () => (alive ? [1] : []),
      stop: async () => {
        if (alive) stops += 1;
        alive = false;
      },
    };
  };
  return {
    start: start as any,
    started,
    stops: () => stops,
    /** La captura se murió sola. */
    die: async () => {
      endFns.forEach((fn) => fn());
      endFns = [];
      await Bun.sleep(1);
    },
  };
}
