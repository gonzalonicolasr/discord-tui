// Compositor Wayland falso (socket unix en un dir temporal): anuncia los globals que le pidas, anota los requests
// del cliente y deja mandar los eventos de inactividad y bloqueo. Solo lo que usa src/desktop/wayland-idle.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Global = { iface: string; version: number };

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
function message(obj: number, op: number, args: Buffer[] = []): Buffer {
  const body = Buffer.concat(args);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(obj, 0);
  head.writeUInt32LE(((8 + body.length) << 16) | op, 4);
  return Buffer.concat([head, body]);
}
function readString(body: Buffer, at: number): { value: string; next: number } {
  const len = body.readUInt32LE(at);
  return { value: body.subarray(at + 4, at + 4 + len - 1).toString(), next: at + 4 + Math.ceil(len / 4) * 4 };
}

export interface FakeWayland {
  /** Ruta del socket: va como WAYLAND_DISPLAY (absoluta). */
  path: string;
  /** Requests del cliente, legibles: "bind ext_idle_notifier_v1 v2", "get_input_idle_notification 600000"… */
  requests: string[];
  /** Cuántos clientes están conectados ahora. */
  clients(): number;
  idled(): void;
  resumed(): void;
  locked(): void;
  unlocked(): void;
  /** Cierra la conexión del cliente (el compositor se cayó). */
  drop(): void;
  stop(): void;
}

export function startFakeWayland(opts: { globals: Global[]; lockedAtStart?: boolean }): FakeWayland {
  const path = join(mkdtempSync(join(tmpdir(), "zcord-wayland-")), "wayland-0");
  const requests: string[] = [];
  const sockets = new Set<any>();
  // Por conexión: id de objeto → interfaz.
  let idleNote: { socket: any; id: number } | null = null;
  let lockNote: { socket: any; id: number } | null = null;

  const server = Bun.listen<{ objects: Map<number, string>; buf: Buffer }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { objects: new Map([[1, "wl_display"]]), buf: Buffer.alloc(0) };
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buf = Buffer.concat([state.buf, Buffer.from(chunk)]);
        while (state.buf.length >= 8) {
          const obj = state.buf.readUInt32LE(0);
          const word = state.buf.readUInt32LE(4);
          const size = word >>> 16;
          const op = word & 0xffff;
          if (state.buf.length < size) break;
          const body = state.buf.subarray(8, size);
          state.buf = state.buf.subarray(size);
          const iface = state.objects.get(obj);
          if (iface === "wl_display" && op === 1) {
            const registry = body.readUInt32LE(0);
            state.objects.set(registry, "wl_registry");
            requests.push("get_registry");
            opts.globals.forEach((g, i) => socket.write(message(registry, 0, [u32(i + 1), str(g.iface), u32(g.version)])));
          } else if (iface === "wl_display" && op === 0) {
            const callback = body.readUInt32LE(0);
            requests.push("sync");
            socket.write(message(callback, 0, [u32(0)]));
          } else if (iface === "wl_registry" && op === 0) {
            const name = body.readUInt32LE(0);
            const s = readString(body, 4);
            const version = body.readUInt32LE(s.next);
            const id = body.readUInt32LE(s.next + 4);
            const global = opts.globals[name - 1];
            requests.push(`bind ${s.value} v${version}`);
            if (global?.iface === s.value) state.objects.set(id, s.value);
          } else if (iface === "ext_idle_notifier_v1" && (op === 1 || op === 2)) {
            const id = body.readUInt32LE(0);
            const timeout = body.readUInt32LE(4);
            const seat = state.objects.get(body.readUInt32LE(8));
            requests.push(`${op === 2 ? "get_input_idle_notification" : "get_idle_notification"} ${timeout}${seat === "wl_seat" ? "" : " (sin seat)"}`);
            state.objects.set(id, "ext_idle_notification_v1");
            idleNote = { socket, id };
          } else if (iface === "hyprland_lock_notifier_v1" && op === 1) {
            const id = body.readUInt32LE(0);
            requests.push("get_lock_notification");
            state.objects.set(id, "hyprland_lock_notification_v1");
            lockNote = { socket, id };
            if (opts.lockedAtStart) socket.write(message(id, 0));
          } else {
            requests.push(`${iface ?? "?"}#${op}`);
          }
        }
      },
    },
  });

  const send = (note: { socket: any; id: number } | null, op: number): void => {
    note?.socket.write(message(note.id, op));
  };
  return {
    path,
    requests,
    clients: () => sockets.size,
    idled: () => send(idleNote, 0),
    resumed: () => send(idleNote, 1),
    locked: () => send(lockNote, 0),
    unlocked: () => send(lockNote, 1),
    drop: () => sockets.forEach((s) => s.end()),
    stop: () => {
      sockets.forEach((s) => s.end());
      server.stop(true);
    },
  };
}
