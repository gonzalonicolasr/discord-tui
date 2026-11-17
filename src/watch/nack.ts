/**
 * Pedido de reenvío de paquetes perdidos para el visor (RFC 4585 Generic NACK + RFC 4588 RTX), como el cliente
 * oficial. libdatachannel no trae un NACK requester en esta versión: anotamos los números de secuencia que faltan
 * del video y los pedimos agrupados cada tanto, con tope de intentos y de tiempo, para no inundar al SFU. El RTX
 * que vuelve lo desenvuelve libdatachannel (llega al track como el paquete original).
 * [sin verificar contra Discord: no se sabe si su SFU atiende nuestros NACK]
 */

/** Espera antes del primer pedido: un paquete apenas desordenado llega solo. */
export const NACK_REORDER_MS = 15;
/** Cada cuánto se vuelve a pedir un mismo paquete. */
export const NACK_INTERVAL_MS = 70;
/** Intentos por paquete y tiempo máximo desde que se notó que faltaba: después se lo da por perdido. */
export const NACK_MAX_TRIES = 4;
export const NACK_GIVE_UP_MS = 350;
/** Un salto mayor (o más faltantes juntos) no es pérdida a recuperar: se reinicia la cuenta. */
export const NACK_MAX_MISSING = 1000;

const seqDiff = (a: number, b: number): number => ((a - b + 0x8000) & 0xffff) - 0x8000;

/** RTCP Generic NACK (PT 205, FMT 1): pide los números de secuencia `seqs` (en orden) del SSRC `media`. */
export function nackPacket(sender: number, media: number, seqs: number[]): Buffer {
  const fci: Array<{ pid: number; blp: number }> = [];
  for (const seq of seqs) {
    const last = fci[fci.length - 1];
    const d = last ? seqDiff(seq, last.pid) : 0;
    if (last && d >= 1 && d <= 16) last.blp |= 1 << (d - 1);
    else fci.push({ pid: seq & 0xffff, blp: 0 });
  }
  const b = Buffer.alloc(12 + fci.length * 4);
  b[0] = 0x81;
  b[1] = 205;
  b.writeUInt16BE(2 + fci.length, 2);
  b.writeUInt32BE(sender >>> 0, 4);
  b.writeUInt32BE(media >>> 0, 8);
  fci.forEach((f, i) => {
    b.writeUInt16BE(f.pid, 12 + i * 4);
    b.writeUInt16BE(f.blp, 14 + i * 4);
  });
  return b;
}

/** Números de secuencia que faltan de un SSRC y cuándo pedirlos. */
export class NackTracker {
  private highest: number | null = null;
  private missing = new Map<number, { since: number; sentAt: number; tries: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Anota un paquete que llegó. Si era uno de los que faltaban: "resent" si ya lo habíamos pedido (la respuesta al
   * NACK, o uno que llegó muy tarde) o "late" si llegó desordenado antes de pedirlo. null si no faltaba.
   */
  received(seq: number): "resent" | "late" | null {
    const m = this.missing.get(seq);
    if (m) {
      this.missing.delete(seq);
      return m.tries > 0 ? "resent" : "late";
    }
    if (this.highest === null) {
      this.highest = seq;
      return null;
    }
    const d = seqDiff(seq, this.highest);
    if (d <= 0) return null;
    if (d > NACK_MAX_MISSING || this.missing.size + d > NACK_MAX_MISSING) this.missing.clear();
    else {
      const t = this.now();
      for (let i = 1; i < d; i++) this.missing.set((this.highest + i) & 0xffff, { since: t, sentAt: -Infinity, tries: 0 });
    }
    this.highest = seq;
    return null;
  }

  /** Los que hay que pedir ahora (en orden); olvida los que ya no vale la pena pedir. */
  due(): number[] {
    const t = this.now();
    const out: number[] = [];
    for (const [seq, m] of this.missing) {
      if (m.tries >= NACK_MAX_TRIES || t - m.since >= NACK_GIVE_UP_MS) {
        this.missing.delete(seq);
        continue;
      }
      if (t - m.since < NACK_REORDER_MS || t - m.sentAt < NACK_INTERVAL_MS) continue;
      m.sentAt = t;
      m.tries++;
      out.push(seq);
    }
    return out;
  }

  /** Cuántos faltan ahora (para tests y diagnóstico). */
  get pending(): number {
    return this.missing.size;
  }
}
