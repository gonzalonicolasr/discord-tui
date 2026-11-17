/**
 * RTP → access units H264 (Annex-B) para ver transmisiones. libdatachannel no expone depacketizer en
 * @lng2004/node-datachannel: el Track sin handler de empaquetado entrega los paquetes RTP ya sin SRTP y los
 * armamos acá (RFC 6184: NAL simple, STAP-A y FU-A).
 *
 * Las access units salen con start codes de 4 bytes (00 00 00 01) como las arma WebRTC: el cifrado DAVE de video
 * se calcula sobre ese formato (davey normaliza a 4 bytes al cifrar, verificado en scripts/spike-watch/dave-video.ts),
 * así que hay que reconstruir los mismos bytes para descifrar.
 *
 * Pérdidas: no mandamos NACK (libdatachannel no trae un NACK requester en esta versión). Si falta un paquete, el
 * cuadro se descarta, se avisa (`onLoss`, para pedir un keyframe con PLI) y se espera el próximo cuadro con IDR.
 * Los clientes de Discord casi no mandan keyframes solos: mientras se espera se repite el PLI y, si igual no llega
 * (`KEYFRAME_PATIENCE` cuadros, ~1,5 s), se sigue con los cuadros P. El decodificador tapa la pérdida y la imagen
 * se va arreglando sola, en vez de quedar congelada para siempre.
 */

/** Cuadros sin IDR que se tiran después de una pérdida antes de seguir igual. */
export const KEYFRAME_PATIENCE = 45;
/** Cada cuántos cuadros tirados se vuelve a pedir el keyframe. */
export const KEYFRAME_RETRY = 15;

export interface RtpPacket {
  marker: boolean;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

/** Parsea un paquete RTP (v2). null si es RTCP, está truncado o no es RTP. */
export function parseRtp(buf: Uint8Array): RtpPacket | null {
  if (buf.length < 12 || buf[0]! >> 6 !== 2) return null;
  const pt = buf[1]! & 0x7f;
  // RTCP comparte el puerto (rtcp-mux): tipos 200–206 → segundo byte 192–223 con el bit de marker.
  if (buf[1]! >= 192 && buf[1]! <= 223) return null;
  const cc = buf[0]! & 0x0f;
  let offset = 12 + cc * 4;
  if (buf[0]! & 0x10) {
    if (buf.length < offset + 4) return null;
    const words = (buf[offset + 2]! << 8) | buf[offset + 3]!;
    offset += 4 + words * 4;
  }
  let end = buf.length;
  if (buf[0]! & 0x20) end -= buf[buf.length - 1]!;
  if (end < offset) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    marker: (buf[1]! & 0x80) !== 0,
    payloadType: pt,
    sequence: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: buf.subarray(offset, end),
  };
}

/** Separa un stream Annex-B en NAL units (sin start codes). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && data[end - 1] === 0) end--; // start code de 4 bytes
        out.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < data.length) out.push(data.subarray(start));
  return out;
}

const START = new Uint8Array([0, 0, 0, 1]);

/** NAL units (sin start code) de un payload RTP H264. null si el paquete es un FU-A del medio/fin. */
function payloadNals(p: Uint8Array): { nals: Uint8Array[]; fu?: { start: boolean; end: boolean; header: number; data: Uint8Array } } {
  const type = p[0]! & 0x1f;
  if (type >= 1 && type <= 23) return { nals: [p] };
  if (type === 24) {
    const nals: Uint8Array[] = [];
    let o = 1;
    while (o + 2 <= p.length) {
      const size = (p[o]! << 8) | p[o + 1]!;
      o += 2;
      if (size === 0 || o + size > p.length) break;
      nals.push(p.subarray(o, o + size));
      o += size;
    }
    return { nals };
  }
  if (type === 28 && p.length >= 2) {
    const fuHeader = p[1]!;
    return {
      nals: [],
      fu: { start: (fuHeader & 0x80) !== 0, end: (fuHeader & 0x40) !== 0, header: (p[0]! & 0xe0) | (fuHeader & 0x1f), data: p.subarray(2) },
    };
  }
  return { nals: [] };
}

/** Arma una access unit Annex-B desde los payloads de un cuadro (en orden). null si un FU-A quedó cortado. */
export function assembleAccessUnit(payloads: Uint8Array[]): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let fu: Uint8Array[] | null = null;
  for (const p of payloads) {
    if (p.length === 0) continue;
    const { nals, fu: frag } = payloadNals(p);
    if (frag) {
      if (frag.start) {
        if (fu) return null;
        fu = [new Uint8Array([frag.header]), frag.data];
      } else {
        if (!fu) return null;
        fu.push(frag.data);
      }
      if (frag.end) {
        parts.push(START, ...fu);
        fu = null;
      }
      continue;
    }
    if (fu) return null;
    for (const n of nals) parts.push(START, n);
  }
  if (fu || parts.length === 0) return null;
  return Buffer.concat(parts);
}

/** ¿La access unit trae un IDR (tipo 5)? Mira solo los encabezados de NAL (DAVE los deja sin cifrar). */
export function hasIdr(au: Uint8Array): boolean {
  return splitAnnexB(au).some((n) => (n[0]! & 0x1f) === 5);
}

const seqDiff = (a: number, b: number): number => ((a - b + 0x8000) & 0xffff) - 0x8000;

interface Pending {
  timestamp: number;
  packets: Map<number, RtpPacket>;
  markerSeq: number | null;
  firstSeq: number;
}

/**
 * Junta los paquetes RTP de un SSRC/payload type en access units. Reordena dentro de un cuadro (agrupa por
 * timestamp); un cuadro está completo cuando llegó el marker y no falta ningún número de secuencia desde el
 * final del cuadro anterior.
 */
export class H264Depacketizer {
  private pending: Pending[] = [];
  private lastEndSeq: number | null = null;
  private needKeyframe = true;
  /** Ya pasó un keyframe (con SPS/PPS): recién ahí se puede seguir sin esperar otro. */
  private hadKeyframe = false;
  private skipped = 0;
  /** Cuadros descartados por pérdida (para diagnóstico). */
  dropped = 0;
  /** Keyframes recibidos y veces que se siguió sin keyframe (para diagnóstico). */
  keyframes = 0;
  concealed = 0;

  constructor(private readonly onLoss: () => void = () => {}) {}

  /** Mete un paquete; devuelve las access units que quedaron completas, en orden. */
  push(pkt: RtpPacket): Uint8Array[] {
    if (this.lastEndSeq !== null && seqDiff(pkt.sequence, this.lastEndSeq) <= 0) return []; // vieja o duplicada
    let frame = this.pending.find((f) => f.timestamp === pkt.timestamp);
    if (!frame) {
      frame = { timestamp: pkt.timestamp, packets: new Map(), markerSeq: null, firstSeq: pkt.sequence };
      this.pending.push(frame);
      this.pending.sort((a, b) => seqDiff(a.firstSeq, b.firstSeq));
    }
    frame.packets.set(pkt.sequence, pkt);
    if (seqDiff(pkt.sequence, frame.firstSeq) < 0) frame.firstSeq = pkt.sequence;
    if (pkt.marker) frame.markerSeq = pkt.sequence;
    return this.drain();
  }

  private complete(f: Pending): boolean {
    if (f.markerSeq === null) return false;
    const start = this.lastEndSeq === null ? f.firstSeq : (this.lastEndSeq + 1) & 0xffff;
    const count = seqDiff(f.markerSeq, start) + 1;
    if (count <= 0 || count > 4096) return false;
    for (let i = 0; i < count; i++) if (!f.packets.has((start + i) & 0xffff)) return false;
    return true;
  }

  private drain(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (;;) {
      const head = this.pending[0];
      if (!head) break;
      if (this.complete(head)) {
        this.pending.shift();
        this.lastEndSeq = head.markerSeq!;
        const ordered = [...head.packets.values()].sort((a, b) => seqDiff(a.sequence, b.sequence)).map((p) => p.payload);
        const au = assembleAccessUnit(ordered);
        if (!au) {
          this.lose();
          continue;
        }
        const idr = hasIdr(au);
        if (idr) this.keyframes++;
        if (this.needKeyframe && !idr) {
          this.skipped++;
          if (this.hadKeyframe && this.skipped >= KEYFRAME_PATIENCE) {
            this.concealed++;
          } else {
            if (this.skipped % KEYFRAME_RETRY === 0) this.onLoss();
            continue;
          }
        }
        this.needKeyframe = false;
        this.skipped = 0;
        if (idr) this.hadKeyframe = true;
        out.push(au);
        continue;
      }
      // Un cuadro posterior ya está completo (o se juntaron muchos): el primero no va a llegar entero.
      const later = this.pending.slice(1).some((f) => f.markerSeq !== null);
      if (later || this.pending.length > 3) {
        this.pending.shift();
        const lastSeq = Math.max(...[...head.packets.keys()].map((s) => seqDiff(s, head.firstSeq))) + head.firstSeq;
        this.lastEndSeq = (head.markerSeq ?? lastSeq) & 0xffff;
        this.lose();
        // el siguiente arranca donde termine lo que haya; se resincroniza por su primer paquete
        const next = this.pending[0];
        if (next) this.lastEndSeq = (next.firstSeq - 1) & 0xffff;
        continue;
      }
      break;
    }
    return out;
  }

  private lose(): void {
    this.dropped++;
    if (!this.needKeyframe) {
      this.needKeyframe = true;
      this.skipped = 0;
      this.onLoss();
    }
  }
}

/** "tipo:cantidad" ordenado por tipo (para el log). */
function histogram(h: Map<number, number>): string {
  return [...h.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

const bump = (h: Map<number, number>, k: number): void => void h.set(k, (h.get(k) ?? 0) + 1);

/**
 * Números del RTP H264 que llega, para watch.diag (nunca bytes ni contenido): sirve para ver si lo que llega es H264
 * con IDR que no reconocemos, H264 sin IDR, u otra cosa (otro códec o NAL cifrados).
 *   n / mk   paquetes / paquetes con marker
 *   pay      tamaño del payload min/medio/máx (bytes, sin encabezado RTP ni padding); "-" sin paquetes
 *   pad      paquetes sin payload (solo padding: sondeo de ancho de banda)
 *   fbit     paquetes cuyo primer byte tiene el bit F en 1 (no parece H264)
 *   jumps    veces que el número de secuencia no fue el anterior + 1; gap = números que faltaron yendo hacia adelante
 *   ts       cambios de timestamp (≈ cuadros)
 *   nal      tipos de NAL simple; stap = tipos dentro de STAP-A; fu = tipo del NAL original de cada FU-A; fuS = FU-A con
 *            bit de inicio
 */
export class RtpH264Stats {
  private n = 0;
  private marker = 0;
  private pad = 0;
  private fbit = 0;
  private jumps = 0;
  private gap = 0;
  private tsChanges = 0;
  private sizeMin = Infinity;
  private sizeMax = 0;
  private sizeSum = 0;
  private lastSeq: number | null = null;
  private lastTs: number | null = null;
  private single = new Map<number, number>();
  private stap = new Map<number, number>();
  private fu = new Map<number, number>();
  private fuStart = 0;

  observe(pkt: RtpPacket): void {
    this.n++;
    if (pkt.marker) this.marker++;
    if (this.lastSeq !== null) {
      const d = seqDiff(pkt.sequence, this.lastSeq);
      if (d !== 1) {
        this.jumps++;
        if (d > 1 && d < 1000) this.gap += d - 1;
      }
    }
    this.lastSeq = pkt.sequence;
    if (this.lastTs !== null && pkt.timestamp !== this.lastTs) this.tsChanges++;
    this.lastTs = pkt.timestamp;
    const p = pkt.payload;
    this.sizeMin = Math.min(this.sizeMin, p.length);
    this.sizeMax = Math.max(this.sizeMax, p.length);
    this.sizeSum += p.length;
    if (p.length === 0) {
      this.pad++;
      return;
    }
    if (p[0]! & 0x80) {
      this.fbit++;
      return;
    }
    const type = p[0]! & 0x1f;
    if (type === 24) {
      let o = 1;
      while (o + 2 <= p.length) {
        const size = (p[o]! << 8) | p[o + 1]!;
        o += 2;
        if (size === 0 || o + size > p.length) break;
        bump(this.stap, p[o]! & 0x1f);
        o += size;
      }
    } else if (type === 28 && p.length >= 2) {
      bump(this.fu, p[1]! & 0x1f);
      if (p[1]! & 0x80) this.fuStart++;
    } else bump(this.single, type);
  }

  summary() {
    return {
      n: this.n,
      mk: this.marker,
      pay: this.n ? `${this.sizeMin}/${Math.round(this.sizeSum / this.n)}/${this.sizeMax}` : "-",
      pad: this.pad,
      fbit: this.fbit,
      jumps: this.jumps,
      gap: this.gap,
      ts: this.tsChanges,
      nal: histogram(this.single),
      stap: histogram(this.stap),
      fu: histogram(this.fu),
      fuS: this.fuStart,
    };
  }
}
