import type { Subprocess } from "bun";

const ALLOWED = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "PIPEWIRE_RUNTIME_DIR",
  "PULSE_SERVER",
  // `hyprctl` lo necesita para hablar con Hyprland (lista de monitores para Go Live); no es secreto.
  "HYPRLAND_INSTANCE_SIGNATURE",
];

export function cleanEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALLOWED) {
    const value = src[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function spawnClean(
  cmd: string[],
  opts?: {
    /** Un ReadableStream (p. ej. el stdout de otro proceso) lo conecta directo, sin pasar por JS. */
    stdin?: "pipe" | "ignore" | ReadableStream<Uint8Array>;
    /** Un número es un fd abierto (p. ej. el `fd3` de otro proceso): el hijo escribe directo ahí. */
    stdout?: "pipe" | "ignore" | number;
    stderr?: "pipe" | "ignore" | "inherit";
    /** Un pipe extra como fd 3 del hijo; el extremo nuestro queda en `proc.stdio[3]` (un fd). */
    fd3?: "pipe";
    /** Igual, como fd 4 (`proc.stdio[4]`). Sin `fd3`, el hijo no tiene fd 3. */
    fd4?: "pipe";
  },
): Subprocess {
  const stdin = opts?.stdin ?? "ignore";
  const stdout = opts?.stdout ?? "pipe";
  // Por defecto los hijos no escriben en la terminal: un navegador abierto con xdg-open (o cualquier
  // otro) metía sus logs arriba de la TUI ("zygote boot message: Broken pipe").
  const stderr = opts?.stderr ?? "ignore";
  if (opts?.fd4) return Bun.spawn(cmd, { env: cleanEnv(), stdio: [stdin, stdout, stderr, opts.fd3 ?? "ignore", "pipe"] });
  if (opts?.fd3) return Bun.spawn(cmd, { env: cleanEnv(), stdio: [stdin, stdout, stderr, "pipe"] });
  return Bun.spawn(cmd, { env: cleanEnv(), stdin, stdout, stderr });
}
