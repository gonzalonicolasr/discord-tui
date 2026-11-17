/**
 * Servidor de stream FALSO para Go Live (del spike de Go Live, antes scripts/spike-golive/shim-fake.ts): un WS TLS local que
 * contesta como el servidor de video de Discord (HELLO, READY con un stream de video, SELECT_PROTOCOL_ACK con
 * una SDP real de libdatachannel y DAVE v1). Más un gateway falso que anota lo que se le manda.
 * Sin Discord ni cuenta: todo en 127.0.0.1.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerConnection } from "@lng2004/node-datachannel";

export interface FakeStreamServer {
  endpoint: string;
  /** Conexiones WS que recibió (debe ser 1 por stream). */
  connections(): number;
  /** Ops que mandó el cliente (`bin<N>` para los binarios). */
  ops: Array<{ op: number; d?: any; binary?: number }>;
  /** Cierra el WS abierto con un código (para probar los cortes). */
  closeWith(code: number): void;
  /** Paquetes RTP de video que el relay le reenvió a los que miran. */
  relayed(): number;
  /** Manda un op de texto por el WS abierto (p. ej. un op 14 SESSION_UPDATE). */
  sendOp(op: number, d: unknown): void;
  /** Manda un paquete (RTCP: PLI, NACK, RR…) al que transmite por su track de video. false si todavía no hay track. */
  sendToStreamer(buf: Uint8Array): boolean;
  stop(): void;
}

/**
 * Con `relay`, hace de servidor de stream con espectadores: la 1.ª conexión que manda un op 12 con un stream activo
 * es la que transmite; su RTP de video se reenvía tal cual a las demás conexiones (los que miran), a las que se
 * les avisa con un op 12 VIDEO {user_id, audio_ssrc, video_ssrc, streams} como hace Discord. `dave` = versión DAVE
 * del op 4 (1 por defecto; 0 = sin E2EE).
 */
export function startFakeStreamServer(
  opts: { relay?: boolean; dave?: number; streamerId?: string; /** video_codec del op 4 (H264 por defecto). */ videoCodec?: string; /** Cada paquete de video que llega del que transmite (con la hora). */ onStreamerPacket?: (msg: Buffer, at: number) => void; /** Cada paquete que llega por el track de video de uno que mira (su RTCP). */ onViewerPacket?: (msg: Buffer) => void } = {},
): FakeStreamServer {
  const dir = mkdtempSync(join(tmpdir(), "golive-tls-"));
  Bun.spawnSync(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const cert = readFileSync(join(dir, "c.pem"), "utf8");
  const key = readFileSync(join(dir, "k.pem"), "utf8");
  rmSync(dir, { recursive: true, force: true });

  let connections = 0;
  const ops: FakeStreamServer["ops"] = [];
  const peers: PeerConnection[] = [];
  let open: Bun.ServerWebSocket<unknown> | null = null;
  // Relay: SSRC que se le asigna a cada conexión (READY), el track de video del server por conexión y quién transmite.
  let nextSsrc = 1000;
  const conns = new Map<Bun.ServerWebSocket<unknown>, { ssrc: number; videoTrack: any; streaming: boolean; tracks: any[] }>();
  let relayed = 0;
  const tellViewers = () => {
    const streamer = [...conns.values()].find((c) => c.streaming);
    if (!streamer) return;
    for (const [ws, c] of conns) {
      if (c === streamer) continue;
      ws.send(JSON.stringify({ op: 12, d: { user_id: opts.streamerId ?? "999", audio_ssrc: streamer.ssrc, video_ssrc: streamer.ssrc + 1, streams: [{ type: "video", rid: "100", ssrc: streamer.ssrc + 1, rtx_ssrc: streamer.ssrc + 2, active: true, quality: 100 }] } }));
    }
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(ws) {
        connections++;
        open = ws;
        const ssrc = nextSsrc;
        nextSsrc += 10;
        conns.set(ws, { ssrc, videoTrack: null, streaming: false, tracks: [] });
      },
      message(ws, raw) {
        if (typeof raw !== "string") {
          ops.push({ op: -1, binary: Buffer.from(raw as Uint8Array)[0] });
          return;
        }
        const { op, d } = JSON.parse(raw);
        ops.push({ op, d });
        const me = conns.get(ws)!;
        if (op === 12 && opts.relay && Array.isArray(d?.streams) && d.streams.some((x: any) => x?.active)) {
          me.streaming = true;
          tellViewers();
        }
        if (op === 0) {
          ws.send(JSON.stringify({ op: 8, d: { heartbeat_interval: 13_750 } }));
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                ssrc: me.ssrc,
                ip: "127.0.0.1",
                port: 50000,
                modes: ["aead_aes256_gcm_rtpsize"],
                streams: [{ type: "video", rid: "100", ssrc: me.ssrc + 1, rtx_ssrc: me.ssrc + 2, active: false, quality: 100 }],
              },
            }),
          );
        } else if (op === 1) {
          // SDP real de libdatachannel: el cliente solo saca c=, a=rtcp, ice-ufrag/pwd, fingerprint y candidate.
          const peer = new PeerConnection("srv", { iceServers: [], bindAddress: "127.0.0.1" });
          peers.push(peer); // referencia viva: Bun junta con el GC lo que no se referencia
          const ack = (sdp: string) => {
            ws.send(JSON.stringify({ op: 4, d: { sdp: `${sdp}\na=rtcp:50000\n`, dave_protocol_version: opts.dave ?? 1, audio_codec: "opus", video_codec: opts.videoCodec ?? "H264" } }));
          };
          if (opts.relay) {
            // Que conecte de verdad: la respuesta con los candidatos ya juntados (el cliente toma el `a=candidate`).
            peer.onGatheringStateChange((state: string) => {
              if (state !== "complete") return;
              ack(peer.localDescription()!.sdp);
              setTimeout(tellViewers, 50);
            });
          } else {
            peer.onLocalDescription((sdp, type) => {
              if (type === "answer") ack(sdp);
            });
          }
          if (opts.relay) {
            peer.onTrack((t: any) => {
              me.tracks.push(t); // referencia viva (GC de Bun)
              if (t.mid() !== "1") return;
              me.videoTrack = t;
              t.onMessage((msg: Buffer) => {
                if (!me.streaming) return void opts.onViewerPacket?.(msg);
                opts.onStreamerPacket?.(msg, performance.now());
                for (const c of conns.values()) {
                  if (c === me || !c.videoTrack?.isOpen()) continue;
                  try {
                    if (c.videoTrack.sendMessageBinary(msg)) relayed++;
                  } catch {
                    // el que mira se fue
                  }
                }
              });
            });
          }
          // libdatachannel tira el RTP de un SSRC que no está en la SDP: se le agregan los que asignó el READY.
          // El cliente arma la SDP del server con `a=setup:passive` (Discord es el servidor DTLS): se fuerza el rol.
          const offer = opts.relay
            ? String(d.sdp).replace(/a=setup:actpass/g, "a=setup:active").replace(
                  /(a=mid:1\r?\n)/,
                  // + el video del primero que transmite (1001): así le llega al server el RTCP de los que miran sobre ese video.
                  `$1a=ssrc:${me.ssrc + 1} cname:fake\r\na=ssrc:${me.ssrc + 2} cname:fake\r\n${me.ssrc === 1000 ? "" : "a=ssrc:1001 cname:fake\r\n"}`,
                )
            : d.sdp;
          peer.setRemoteDescription(offer, "offer");
        }
      },
      close(ws) {
        open = null;
        conns.delete(ws);
      },
    },
  });

  return {
    endpoint: `127.0.0.1:${server.port}`,
    connections: () => connections,
    relayed: () => relayed,
    sendOp(op, d) {
      open?.send(JSON.stringify({ op, d }));
    },
    sendToStreamer(buf) {
      const streamer = [...conns.values()].find((c) => c.streaming);
      if (!streamer?.videoTrack?.isOpen()) return false;
      return streamer.videoTrack.sendMessageBinary(Buffer.from(buf));
    },
    ops,
    closeWith(code) {
      open?.close(code, "test");
    },
    stop() {
      for (const peer of peers) {
        try {
          peer.close();
        } catch {
          // ya cerrado
        }
      }
      server.stop(true);
    },
  };
}

/** Gateway falso con la forma de src/gateway/connection.ts: anota los `send` y deja emitir dispatches. */
export function fakeGateway() {
  const sent: Array<{ op: number; d: any }> = [];
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const on = (ev: string, fn: (...args: any[]) => void) => {
    const set = listeners.get(ev) ?? new Set();
    set.add(fn);
    listeners.set(ev, set);
    return () => set.delete(fn);
  };
  const emit = (ev: string, ...args: unknown[]) => listeners.get(ev)?.forEach((fn) => fn(...args));
  return {
    sent,
    send: (op: number, d: unknown) => void sent.push({ op, d: d as any }),
    on: on as any,
    dispatch: (t: string, d: unknown) => emit("dispatch", t, d),
    status: (s: string) => emit("status", s),
    session: (kind: "identified" | "resumed") => emit("session", kind),
    listenerCount: (ev: string) => listeners.get(ev)?.size ?? 0,
  };
}
