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
/**
 * Ventana creíble de un reenvío: llega al menos RESEND_MIN_MS después del PRIMER pedido de ese número (y antes de que
 * se lo abandone, NACK_GIVE_UP_MS desde que se notó el hueco). Una respuesta tiene que hacer el viaje de ida y vuelta
 * al SFU por internet (Wi-Fi + ISP + Discord: bastante más de 5 ms); lo que llega antes ya venía en camino antes del
 * NACK, o sea es el original demorado, no una respuesta. Se mide desde el primer pedido y no desde el último porque
 * con un RTT mayor que NACK_INTERVAL_MS la respuesta al 1.er pedido llega después del 2.º.
 */
export const RESEND_MIN_MS = 5;
/** Tras pedir esta cantidad de números distintos, si respondió menos de 1 de cada 10, el SFU no atiende el NACK. */
export const NACK_USELESS_AFTER = 50;

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
  private missing = new Map<number, { since: number; sentAt: number; firstSentAt: number; tries: number }>();
  /** Números distintos pedidos al menos una vez, y cuántos de ellos llegaron en la ventana creíble de reenvío. */
  asked = 0;
  answered = 0;
  /** Demora desde el primer pedido de los que llegaron en la ventana (los últimos 32): un SFU que responde los agrupa cerca del RTT. */
  private delays: number[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Anota un paquete que llegó. Si era uno de los que faltaban:
   *   "resent"  ya lo habíamos pedido y llegó en la ventana creíble de reenvío (RESEND_MIN_MS o más después del 1.er pedido)
   *   "stray"   ya lo habíamos pedido pero llegó antes de esa ventana: el original demorado, no una respuesta
   *   "late"    llegó desordenado antes de pedirlo
   * null si no faltaba.
   */
  received(seq: number): "resent" | "stray" | "late" | null {
    const m = this.missing.get(seq);
    if (m) {
      this.missing.delete(seq);
      if (m.tries === 0) return "late";
      const dt = this.now() - m.firstSentAt;
      if (dt < RESEND_MIN_MS) return "stray";
      this.answered++;
      this.delays.push(dt);
      if (this.delays.length > 32) this.delays.shift();
      return "resent";
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
      for (let i = 1; i < d; i++) this.missing.set((this.highest + i) & 0xffff, { since: t, sentAt: -Infinity, firstSentAt: 0, tries: 0 });
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
      if (m.tries === 0) {
        m.firstSentAt = t;
        this.asked++;
      }
      m.sentAt = t;
      m.tries++;
      out.push(seq);
    }
    return out;
  }

  /** El SFU no atiende el NACK: ya se pidieron NACK_USELESS_AFTER números y respondió menos de 1 de cada 10. */
  get useless(): boolean {
    return this.asked >= NACK_USELESS_AFTER && this.answered * 10 < this.asked;
  }

  /** Demora de los reenvíos desde el primer pedido, "mín/mediana/máx" en ms ("-" sin ninguno). */
  delaySummary(): string {
    if (!this.delays.length) return "-";
    const d = [...this.delays].sort((a, b) => a - b);
    return `${Math.round(d[0]!)}/${Math.round(d[d.length >> 1]!)}/${Math.round(d[d.length - 1]!)}`;
  }

  /** Cuántos faltan ahora (para tests y diagnóstico). */
  get pending(): number {
    return this.missing.size;
  }
}
