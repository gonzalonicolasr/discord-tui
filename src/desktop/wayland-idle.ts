/**
 * Inactividad de TODO el sistema y bloqueo de pantalla, preguntándole al compositor por Wayland.
 *
 * Por qué así (medido en la PC de Gon, Hyprland 0.56.2 + shell de Omarchy, 2026-11-15):
 * - logind no sirve: con la pantalla bloqueada `loginctl show-session` decía LockedHint=no e IdleHint=no (el lock
 *   de Omarchy no se lo informa a logind y nadie marca IdleHint).
 * - No hay hypridle, swayidle ni wayland-info instalados, y el lock no es el proceso hyprlock (lo dibuja quickshell).
 * - Hyprland anuncia `ext_idle_notifier_v1` v2 (estándar de wayland-protocols) y `hyprland_lock_notifier_v1` v1 (lo
 *   que usa hypridle para enterarse del lock). Un cliente chico en el mismo proceso alcanza: no hay proceso auxiliar,
 *   así que muere con zcord sí o sí (stop, señal o caída cierran el socket y el compositor limpia).
 *
 * `get_input_idle_notification` (v2) cuenta solo teclado/mouse, en cualquier ventana, e ignora los inhibidores de
 * idle (un video en el navegador no lo frena). Con v1 se usa `get_idle_notification`, que sí los respeta.
 * Si algo falta, se avisa en el log y esa parte queda apagada: nunca se cae a "actividad dentro de zcord".
 */
import { isAbsolute, join } from "node:path";

import { log as defaultLog, type Logger } from "../log/logger";

export interface SystemIdleEvents {
  /** Pasaron `idleAfterMs` sin teclado ni mouse en todo el sistema (una vez por período de inactividad). */
  idle(): void;
  /** Se bloqueó (true) o desbloqueó (false) la pantalla. Si ya estaba bloqueada al conectar, llega enseguida. */
  lock(locked: boolean): void;
}

/** Empieza a mirar; devuelve cómo dejar de mirar. */
export type SystemIdleSource = (idleAfterMs: number, events: SystemIdleEvents) => () => void;

const EVENT = "voice.auto-mute";

const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const str = (s: string): Buffer => {
  const n = Buffer.byteLength(s) + 1;
  const b = Buffer.alloc(4 + Math.ceil(n / 4) * 4);
  b.writeUInt32LE(n);
  b.write(s, 4);
  return b;
};
function request(obj: number, op: number, args: Buffer[] = []): Buffer {
  const body = Buffer.concat(args);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(obj, 0);
  head.writeUInt32LE(((8 + body.length) << 16) | op, 4);
  return Buffer.concat([head, body]);
}

export function watchWaylandIdle(
  idleAfterMs: number,
  events: SystemIdleEvents,
  opts: { env?: Record<string, string | undefined>; log?: Pick<Logger, "info" | "warn"> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLog;
  const display = env.WAYLAND_DISPLAY;
  if (!display) {
    log.warn(EVENT, { state: "unavailable", msg: "sin WAYLAND_DISPLAY" });
    return () => {};
  }
  const path = isAbsolute(display) ? display : join(env.XDG_RUNTIME_DIR ?? "", display);

  const DISPLAY = 1;
  const REGISTRY = 2;
  const SYNC = 3;
  let nextId = 4;
  let idleNote = 0;
  let lockNote = 0;
  const globals: Array<{ name: number; iface: string; version: number }> = [];
  let buf = Buffer.alloc(0);
  let stopped = false;
  let socket: { write(data: Buffer): number; end(): void } | null = null;

  const close = (): void => {
    stopped = true;
    socket?.end();
    socket = null;
  };

  function setup(): void {
    const find = (iface: string) => globals.find((g) => g.iface === iface);
    const seat = find("wl_seat");
    const idle = seat ? find("ext_idle_notifier_v1") : undefined;
    const lock = find("hyprland_lock_notifier_v1");
    if (!idle && !lock) {
      log.warn(EVENT, { state: "unavailable", msg: "el compositor no avisa inactividad ni bloqueo" });
      close();
      return;
    }
    const out: Buffer[] = [];
    let mode = "no-idle";
    if (seat && idle) {
      const seatId = nextId++;
      const notifier = nextId++;
      idleNote = nextId++;
      const version = Math.min(2, idle.version);
      mode = version >= 2 ? "input-idle" : "idle-v1";
      out.push(request(REGISTRY, 0, [u32(seat.name), str("wl_seat"), u32(1), u32(seatId)]));
      out.push(request(REGISTRY, 0, [u32(idle.name), str("ext_idle_notifier_v1"), u32(version), u32(notifier)]));
      const timeout = Math.max(1, Math.min(0xffffffff, Math.round(idleAfterMs)));
      out.push(request(notifier, version >= 2 ? 2 : 1, [u32(idleNote), u32(timeout), u32(seatId)]));
    }
    if (lock) {
      const notifier = nextId++;
      lockNote = nextId++;
      out.push(request(REGISTRY, 0, [u32(lock.name), str("hyprland_lock_notifier_v1"), u32(1), u32(notifier)]));
      out.push(request(notifier, 1, [u32(lockNote)]));
    }
    socket?.write(Buffer.concat(out));
    if (!idleNote) log.warn(EVENT, { state: "unavailable", msg: "el compositor no avisa inactividad (solo bloqueo)" });
    if (!lockNote) log.warn(EVENT, { state: "no-lock", msg: "el compositor no avisa el bloqueo de pantalla" });
    log.info(EVENT, { state: "watching", mode, duration_ms: idleAfterMs });
  }

  function onMessage(obj: number, op: number, body: Buffer): void {
    if (obj === REGISTRY && op === 0) {
      const name = body.readUInt32LE(0);
      const len = body.readUInt32LE(4);
      const iface = body.subarray(8, 8 + Math.max(0, len - 1)).toString();
      const version = body.readUInt32LE(8 + Math.ceil(len / 4) * 4);
      globals.push({ name, iface, version });
    } else if (obj === SYNC && op === 0) {
      setup();
    } else if (obj === idleNote && idleNote !== 0) {
      if (op === 0) events.idle();
    } else if (obj === lockNote && lockNote !== 0) {
      events.lock(op === 0);
    } else if (obj === DISPLAY && op === 0) {
      log.warn(EVENT, { state: "lost", msg: "error de protocolo Wayland", code: body.readUInt32LE(4) });
      close();
    }
  }

  Bun.connect({
    unix: path,
    socket: {
      open(s) {
        if (stopped) return void s.end();
        socket = s as never;
        // get_registry + sync: cuando vuelve el callback ya llegaron todos los globals.
        s.write(Buffer.concat([request(DISPLAY, 1, [u32(REGISTRY)]), request(DISPLAY, 0, [u32(SYNC)])]));
      },
      data(_s, chunk) {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        while (!stopped && buf.length >= 8) {
          const obj = buf.readUInt32LE(0);
          const size = buf.readUInt32LE(4) >>> 16;
          if (size < 8) {
            log.warn(EVENT, { state: "lost", msg: "mensaje Wayland inválido" });
            return close();
          }
          if (buf.length < size) break;
          const op = buf.readUInt32LE(4) & 0xffff;
          const body = buf.subarray(8, size);
          buf = buf.subarray(size);
          try {
            onMessage(obj, op, body);
          } catch {
            log.warn(EVENT, { state: "lost", msg: "mensaje Wayland inválido" });
            return close();
          }
        }
      },
      close() {
        if (!stopped) log.warn(EVENT, { state: "lost", msg: "se cortó la conexión con el compositor" });
        stopped = true;
        socket = null;
      },
      error() {},
    },
  }).catch((error: unknown) => {
    if (!stopped) log.warn(EVENT, { state: "unavailable", error_name: error instanceof Error ? error.name : "unknown" });
    stopped = true;
  });

  return close;
}
