/**
 * Conexión de ESPECTADOR al servidor de stream de Discord (ver la transmisión de otro). @dank074/discord-video-stream
 * 7.0.0 solo transmite: su SDP remota es `a=inactive` y nunca lee los tracks. Reusamos su `StreamConnection`
 * (WS, heartbeat, resume y todo el MLS/DAVE) y le cambiamos tres cosas (spike 2026-11-08, docs/protocol-notes.md
 * "Ver transmisiones"):
 *   - setProtocols: la PeerConnection propia (audio mid 0 + video mid 1, como la librería) y un solo op 1; las
 *     renegociaciones locales no se le mandan a Discord.
 *   - handleProtocolAck: guarda ICE/DTLS del server y arma la SDP remota `a=sendonly`.
 *   - op 12 VIDEO del server (SSRCs de quien transmite): renegocia SOLO localmente con `a=ssrc:` (libdatachannel
 *     tira el RTP de un SSRC que no está en la SDP cuando hay más de un m-line) y manda op 15 MEDIA_SINK_WANTS.
 * Ata la versión exacta de la librería (usa campos privados: `_webRtcWrapper`, `_daveProtocolVersion`).
 */
import { randomUUID } from "node:crypto";

import { H264Depacketizer, parseRtp } from "./h264";

/** El payload type H264 que ofrece la librería (CodecPayloadType.H264). */
export const H264_PT = 101;
const DAVE_MAGIC = 0xfafa;

export interface ViewerParams {
  guildId: string | null;
  channelId: string;
  meId: string;
  streamerId: string;
  sessionId: string;
  rtcServerId: string;
  streamKey: string;
  endpoint: string;
  token: string;
}

export interface ViewerEvents {
  /** Access unit H264 (Annex-B) ya descifrada. */
  onFrame(au: Uint8Array): void;
  /** WS del stream cerrado por Discord (código de cierre). */
  onClose(code: number): void;
  /** El que transmite usa un códec que no decodificamos. */
  onUnsupportedCodec(codec: string): void;
}

export interface ViewerConnection {
  /** Pide un keyframe (PLI): al empezar a mirar de nuevo o después de una pérdida. */
  requestKeyframe(): void;
  stats(): { packets: number; frames: number; dropped: number; daveFailures: number };
  /** Diagnóstico (solo números y estados, nada de contenido) para el log mientras se mira. */
  diag?(): Record<string, unknown>;
  stop(): void;
}

/** Lo que usamos de la librería: su StreamConnection (se carga a pedido, como el shim de Go Live). */
export interface ViewerLib {
  StreamConnection: new (...args: any[]) => any;
  nodeDataChannel: { PeerConnection: new (...args: any[]) => any; Audio: new (...args: any[]) => any; Video: new (...args: any[]) => any; RtcpReceivingSession: new () => any };
  davey: { MediaType: { VIDEO: number } };
}

export async function loadViewerLib(): Promise<ViewerLib> {
  process.env.DEBUG_LEVEL = "OFF"; // como loadGoLiveLib: el logger de la librería ensucia la TUI
  const mod: any = await import("@dank074/discord-video-stream");
  const ndc: any = await import("@lng2004/node-datachannel");
  const davey: any = await import("@snazzah/davey");
  return {
    StreamConnection: mod.StreamConnection,
    nodeDataChannel: { PeerConnection: ndc.PeerConnection, Audio: ndc.Audio, Video: ndc.Video, RtcpReceivingSession: ndc.RtcpReceivingSession },
    davey: { MediaType: { VIDEO: davey.MediaType?.VIDEO ?? 1 } },
  };
}

interface RemoteInfo {
  ip: string;
  port: string;
  ufrag: string;
  pwd: string;
  fingerprint: string;
  candidate: string;
}

/** SDP remota "del server" hecha a mano (como la librería), pero mandando hacia nosotros y con los SSRC conocidos. */
/** RTCP PLI (RFC 4585, PT 206 FMT 1): pide un keyframe del SSRC `media`. */
export function pliPacket(sender: number, media: number): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0x81;
  b[1] = 206;
  b.writeUInt16BE(2, 2);
  b.writeUInt32BE(sender >>> 0, 4);
  b.writeUInt32BE(media >>> 0, 8);
  return b;
}

export function viewerRemoteSdp(r: RemoteInfo, ssrcs: { audio: number | null; video: number | null; rtx: number | null }): string {
  const common = [r.ip, "a=setup:passive", "%MID%", "a=sendonly", r.ufrag, r.pwd, r.fingerprint, r.candidate, "a=rtcp-mux"];
  const audio = [
    `m=audio ${r.port} UDP/TLS/RTP/SAVPF 120`,
    ...common.map((l) => (l === "%MID%" ? "a=mid:0" : l)),
    "a=rtpmap:120 opus/48000/2",
    "a=fmtp:120 minptime=10;useinbandfec=1;usedtx=1",
    ...(ssrcs.audio ? [`a=ssrc:${ssrcs.audio} cname:stream`] : []),
    "a=ice-lite",
  ];
  const video = [
    `m=video ${r.port} UDP/TLS/RTP/SAVPF ${H264_PT} ${H264_PT + 1}`,
    ...common.map((l) => (l === "%MID%" ? "a=mid:1" : l)),
    `a=rtpmap:${H264_PT} H264/90000`,
    `a=fmtp:${H264_PT} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`,
    `a=rtpmap:${H264_PT + 1} rtx/90000`,
    `a=fmtp:${H264_PT + 1} apt=${H264_PT}`,
    `a=rtcp-fb:${H264_PT} nack pli`,
    `a=rtcp-fb:${H264_PT} ccm fir`,
    ...(ssrcs.video ? [`a=ssrc:${ssrcs.video} cname:stream`] : []),
    ...(ssrcs.rtx ? [`a=ssrc:${ssrcs.rtx} cname:stream`] : []),
    "a=ice-lite",
  ];
  return [...audio, ...video].filter(Boolean).join("\n");
}

export function parseRemoteInfo(sdp: string): RemoteInfo {
  const r: RemoteInfo = { ip: "", port: "", ufrag: "", pwd: "", fingerprint: "", candidate: "" };
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("c=")) r.ip = line;
    else if (line.startsWith("a=rtcp:")) r.port = line.split(":")[1]!.trim();
    else if (line.startsWith("a=ice-ufrag")) r.ufrag = line;
    else if (line.startsWith("a=ice-pwd")) r.pwd = line;
    else if (line.startsWith("a=fingerprint")) r.fingerprint = line;
    else if (line.startsWith("a=candidate") && !r.candidate) r.candidate = line;
  }
  if (!r.port) r.port = r.candidate.split(" ")[5] ?? "9";
  return r;
}

/** Busca, en un op 12 VIDEO, los SSRC de quien transmite. */
export function streamerSsrcs(d: any, streamerId: string, meId: string): { audio: number | null; video: number | null; rtx: number | null } | null {
  if (!d || d.user_id === meId || (d.user_id !== undefined && d.user_id !== streamerId)) return null;
  const stream = Array.isArray(d.streams) ? d.streams.find((s: any) => s && s.ssrc && s.active !== false) ?? d.streams[0] : null;
  const video = Number(stream?.ssrc ?? d.video_ssrc) || null;
  if (!video) return null;
  const rtx = Number(stream?.rtx_ssrc) || video + 1;
  return { audio: Number(d.audio_ssrc) || null, video, rtx };
}

export function createViewerConnection(lib: ViewerLib, p: ViewerParams, events: ViewerEvents): ViewerConnection {
  const { PeerConnection, Audio, Video, RtcpReceivingSession } = lib.nodeDataChannel;
  const stats = { packets: 0, frames: 0, dropped: 0, daveFailures: 0 };
  const diag = { ops: new Set<number>(), op12: 0, rtpVideo: 0, rtpOther: 0, rtpOtherSsrc: new Set<number>(), passthroughDrop: 0, notReadyDrop: 0, encrypted: 0, clear: 0, lastPt: -1, pli: 0, pliOk: 0, pliOwn: 0, wants: 0 };
  let ownSsrc = 0;
  // Referencias vivas: Bun junta con el GC los Track/PeerConnection sin referencia JS (spike de Go Live).
  let pc: any = null;
  let videoTrack: any = null;
  let audioTrack: any = null;
  let remote: RemoteInfo | null = null;
  let ssrcs = { audio: null as number | null, video: null as number | null, rtx: null as number | null };
  let stopped = false;
  let conn: any;

  const depack = new H264Depacketizer(() => keyframe());
  function keyframe(): void {
    try {
      // Con el track cerrado libdatachannel tira std::runtime_error desde su hilo y aborta el proceso entero.
      if (videoTrack?.isOpen()) {
        diag.pli++;
        if (videoTrack.requestKeyframe()) diag.pliOk++;
        // El PLI de libdatachannel sale con el SSRC del que transmite también como remitente; el SFU puede
        // descartarlo. Va otro con nuestro SSRC (op 2) como remitente. [sin verificar cuál de los dos sirve]
        if (ownSsrc && ssrcs.video && videoTrack.sendMessageBinary(pliPacket(ownSsrc, ssrcs.video))) diag.pliOwn++;
      }
    } catch {
      // track cerrado
    }
    refreshWants();
  }

  /**
   * Plan B para conseguir un keyframe: bajar a 0 y volver a 100 la calidad pedida de ese video (op 15). Cuando
   * vuelve a suscribirse, el SFU le pide un keyframe al que transmite (así arrancó bien la primera vez). Como mucho
   * cada 3 s. [sin verificar]
   */
  let lastWants = 0;
  /** Último keyframe recibido (al conectar cuenta como reciente: se espera el primero un rato). */
  let lastKeyframeAt = Date.now();
  const WANTS_AFTER_MS = 4000;
  function refreshWants(): void {
    const video = ssrcs.video;
    if (!conn || !video || stopped || Date.now() - lastWants < 3000) return;
    // Cortar y volver a pedir el video lo pausa un instante (se ve como un parpadeo): solo si el PLI no alcanzó,
    // o sea si hace rato que no llega ningún keyframe.
    if (Date.now() - lastKeyframeAt < WANTS_AFTER_MS) return;
    lastWants = Date.now();
    diag.wants++;
    try {
      conn.sendOpcode(15, { any: 100, [video]: 0 });
    } catch {
      return;
    }
    const t = setTimeout(() => {
      if (!stopped && ssrcs.video === video) {
        try {
          conn.sendOpcode(15, { any: 100, [video]: 100 });
        } catch {
          // ws cerrado
        }
      }
    }, 200);
    (t as { unref?: () => void }).unref?.();
  }

  function applyRemote(renegotiate: boolean): void {
    if (!pc || !remote) return;
    if (renegotiate) pc.setLocalDescription(); // oferta local nueva; no sale por el WS (ver setProtocols)
    pc.setRemoteDescription(viewerRemoteSdp(remote, ssrcs), "answer");
  }

  function onRtp(msg: Buffer): void {
    if (stopped) return;
    const pkt = parseRtp(msg);
    if (!pkt) return;
    stats.packets++;
    diag.lastPt = pkt.payloadType;
    if (pkt.payloadType !== H264_PT) return; // RTX y demás: sin NACK no sirven
    if (ssrcs.video && pkt.ssrc !== ssrcs.video) {
      diag.rtpOther++;
      if (diag.rtpOtherSsrc.size < 4) diag.rtpOtherSsrc.add(pkt.ssrc);
      return;
    }
    diag.rtpVideo++;
    const keyframesBefore = depack.keyframes;
    const aus = depack.push(pkt);
    if (depack.keyframes !== keyframesBefore) lastKeyframeAt = Date.now();
    for (const au of aus) {
      const plain = decrypt(au);
      if (!plain) continue;
      stats.frames++;
      events.onFrame(plain);
    }
    stats.dropped = depack.dropped;
  }

  function decrypt(au: Uint8Array): Uint8Array | null {
    const encrypted = au.length > 2 && ((au[au.length - 2]! << 8) | au[au.length - 1]!) === DAVE_MAGIC;
    const session = conn.daveSession;
    if (encrypted) diag.encrypted++;
    else diag.clear++;
    if (!encrypted) {
      // Sin DAVE (o en una transición) el cuadro viene en claro; con DAVE listo, solo si el decryptor lo permite.
      if (!conn.daveReady || !session) return au;
      try {
        if (session.canPassthrough(p.streamerId)) return au;
        diag.passthroughDrop++;
        return null;
      } catch {
        diag.passthroughDrop++;
        return null;
      }
    }
    if (!conn.daveReady || !session) {
      diag.notReadyDrop++;
      return null;
    }
    try {
      return session.decrypt(p.streamerId, lib.davey.MediaType.VIDEO, Buffer.from(au.buffer, au.byteOffset, au.byteLength));
    } catch {
      stats.daveFailures++;
      return null;
    }
  }

  class Viewer extends (lib.StreamConnection as new (...args: any[]) => any) {
    async setProtocols(): Promise<void> {
      pc = new PeerConnection("", { iceServers: ["stun:stun.l.google.com:19302"] });
      const a = new Audio("0", "SendRecv");
      a.addOpusCodec(120);
      const v = new Video("1", "SendRecv");
      v.addH264Codec(H264_PT);
      v.addRTXCodec(H264_PT + 1, H264_PT, 90_000);
      audioTrack = pc.addTrack(a);
      videoTrack = pc.addTrack(v);
      // RR y PLI (requestKeyframe) los arma libdatachannel; el RTP pasa igual al onMessage.
      videoTrack.setMediaHandler(new RtcpReceivingSession());
      videoTrack.onMessage(onRtp);
      audioTrack.onMessage(() => {}); // audio del stream: sin implementar (ver docs)
      (this as any)._webRtcWrapper = { webRtcConn: pc, initWebRtc: () => pc, close: () => pc?.close(), ready: false };
      let sent = false;
      pc.onLocalDescription((sdp: string) => {
        if (sent) return;
        sent = true;
        const codecs = [
          { name: "opus", type: "audio", priority: 1000, payload_type: 120 },
          { name: "H264", type: "video", priority: 1000, payload_type: H264_PT, rtx_payload_type: H264_PT + 1, encode: false, decode: true },
        ];
        this.sendOpcode(1, { protocol: "webrtc", codecs, data: sdp, sdp, rtc_connection_id: randomUUID() });
      });
      pc.setLocalDescription();
      return new Promise((resolve) => this.once("select_protocol_ack", () => resolve()));
    }

    async handleProtocolAck(d: any): Promise<void> {
      if (!d || !("sdp" in d)) throw new Error("Only WebRTC connections are allowed");
      (this as any)._daveProtocolVersion = d.dave_protocol_version;
      this.initDave();
      if (typeof d.video_codec === "string" && d.video_codec !== "H264") events.onUnsupportedCodec(d.video_codec);
      remote = parseRemoteInfo(d.sdp);
      applyRemote(false);
      this.emit("select_protocol_ack");
    }

    // Un espectador no transmite: nada de op 12 propio ni speaking.
    setVideoAttributes(): void {}

    setupEvents(): void {
      super.setupEvents();
      this.ws?.addEventListener("message", (e: MessageEvent) => {
        if (typeof e.data !== "string") return;
        let msg: any;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (typeof msg.op === "number") diag.ops.add(msg.op);
        if (msg.op === 2) {
          if (typeof msg.d?.ssrc === "number") ownSsrc = msg.d.ssrc;
          this.sendOpcode(15, { any: 100 });
        }
        if (msg.op !== 12) return;
        diag.op12++;
        const found = streamerSsrcs(msg.d, p.streamerId, p.meId);
        if (!found || found.video === ssrcs.video) return;
        ssrcs = found;
        applyRemote(true);
        this.sendOpcode(15, { any: 100, [found.video!]: 100 });
        keyframe();
      });
      this.ws?.addEventListener("close", (e: CloseEvent) => {
        if (!stopped) events.onClose(e.code);
      });
    }
  }

  conn = new Viewer(null, p.guildId, p.meId, p.channelId, () => {});
  conn.serverId = p.rtcServerId;
  conn.streamKey = p.streamKey;
  conn.setSession(p.sessionId);
  conn.setTokens(p.endpoint, p.token);

  return {
    requestKeyframe: keyframe,
    stats: () => ({ ...stats }),
    diag: () => {
      let pcState = "?";
      let trackOpen = false;
      try {
        pcState = pc ? `${pc.state()}/${pc.iceState?.() ?? "?"}/${pc.gatheringState?.() ?? "?"}` : "sin-pc";
        trackOpen = videoTrack?.isOpen() === true;
      } catch {
        // estado no disponible
      }
      return {
        ops: [...diag.ops].sort((a, b) => a - b).join(","),
        op12: diag.op12,
        pc: pcState,
        track: trackOpen,
        dave: `${conn?.daveReady ? "lista" : "no"}/v${(conn as any)?._daveProtocolVersion ?? "?"}`,
        ssrcVideo: ssrcs.video,
        rtp: stats.packets,
        rtpVideo: diag.rtpVideo,
        rtpOther: diag.rtpOther,
        otherSsrc: [...diag.rtpOtherSsrc].join(","),
        lastPt: diag.lastPt,
        frames: stats.frames,
        clear: diag.clear,
        encrypted: diag.encrypted,
        daveFail: stats.daveFailures,
        drop: `${diag.notReadyDrop}/${diag.passthroughDrop}/${stats.dropped}`,
        idr: depack.keyframes,
        conceal: depack.concealed,
        pli: `${diag.pliOk}/${diag.pli}/${diag.pliOwn}`,
        wants: diag.wants,
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        conn.stop();
      } catch {
        // ya cerrado
      }
      try {
        pc?.close();
      } catch {
        // ya cerrado
      }
    },
  };
}
