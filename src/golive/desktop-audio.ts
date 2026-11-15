/**
 * Audio de la PC para Go Live, SIN el audio de zcord (si no, los que miran se escuchan a sí mismos).
 *
 * Cómo: un `pw-record` propio que PipeWire no enlaza a nada (`--target 0`, con `node.always-process` para que
 * igual corra y mande silencio), y un enlazador que cada segundo mira el grafo (`pw-dump`) y enlaza con
 * `pw-link` las salidas de las DEMÁS apps a sus entradas. PipeWire mezcla lo que entra a un mismo puerto.
 *
 * - No se mueve ningún stream ni se toca la config: las apps siguen sonando donde sonaban; el enlace es extra.
 * - Se deshace solo: los enlaces mueren con el nodo de pw-record, y pw-record muere con la transmisión (stop) o
 *   si zcord se cae (su stdout va a ffmpeg, que muere con zcord: EPIPE).
 * - Afuera: zcord y sus descendientes (el pw-cat de la voz y el de los audios), los nodos que mezclan todo lo
 *   que suena (EasyEffects, loopbacks del propio PipeWire), que traerían de vuelta la voz de la llamada, y todo
 *   lo que no se puede identificar (sin cliente o sin pid): ante la duda, no se enlaza.
 * - En cada vuelta se revisan los enlaces hechos y se deshacen (`pw-link -d`) los que ya no deberían estar.
 */
import { readFileSync } from "node:fs";

import { log } from "../log/logger";
import type { CaptureEnv, ProcLike } from "./capture";

/** Nombre del nodo de captura en PipeWire (lo ve Gon en pavucontrol / qpwgraph). */
export const AUDIO_NODE = "zcord-golive-audio";

/** Cada cuánto se miran las apps nuevas que empiezan a sonar. */
export const LINK_INTERVAL_MS = 1_000;

/** Apps cuyo audio es una mezcla de TODO lo que suena (zcord incluido): enlazarlas sería eco. */
const MIXERS = new Set(["pipewire", "pipewire-pulse", "wireplumber", "easyeffects"]);

/** Canal de una salida → canales de nuestra entrada. Lo que no es FL/FR/MONO (surround) se saltea. */
const CHANNEL_MAP: Record<string, string[]> = { FL: ["FL"], FR: ["FR"], MONO: ["FL", "FR"] };

export function desktopAudioCommand(): string[] {
  return [
    "pw-record",
    "--target",
    "0",
    "-P",
    `{ node.name = ${AUDIO_NODE} node.description = "zcord Go Live" application.name = zcord-golive media.name = "zcord Go Live" node.always-process = true }`,
    "--raw",
    "--format",
    "s16",
    "--rate",
    "48000",
    "--channels",
    "2",
    "--latency",
    "20ms",
    "-",
  ];
}

function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid …": comm puede tener espacios y paréntesis, se corta después del último ")".
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * El pid es zcord o un descendiente suyo (los pw-cat de src/voice/audio-io.ts y src/media/audio-player.ts, o uno
 * lanzado a través de `sh -c`/`nice`). Sube por los padres hasta 64 niveles.
 */
export function isZcordProcess(pid: number): boolean {
  let current: number | null = pid;
  for (let depth = 0; depth < 64 && current !== null && current > 1; depth += 1) {
    if (current === process.pid) return true;
    current = parentOf(current);
  }
  return false;
}

type Obj = { id: number; type: string; info: any };

function objects(dump: unknown): Obj[] {
  if (!Array.isArray(dump)) return [];
  return dump.filter((o): o is Obj => typeof o?.id === "number" && typeof o?.type === "string" && typeof o?.info === "object" && o.info !== null);
}

interface Graph {
  recorder: Obj;
  inputs: Map<string, number>;
  existing: Array<[number, number]>;
  nodeOfPort: Map<number, Obj>;
  /** Un nodo que se puede enlazar: una app identificada que no es zcord ni un mezclador. */
  isSource(node: Obj): boolean;
  outputs(node: Obj): Obj[];
}

function graph(dump: unknown, opts: { recorderPid: number; isOwn: (pid: number) => boolean }): Graph | null {
  const all = objects(dump);
  const clients = new Map<number, { pid: number | null; bin: string }>();
  for (const o of all) {
    if (o.type !== "PipeWire:Interface:Client") continue;
    const pid = Number(o.info.props?.["application.process.id"]);
    clients.set(o.id, { pid: Number.isInteger(pid) ? pid : null, bin: String(o.info.props?.["application.process.binary"] ?? "") });
  }
  const clientOf = (node: Obj) => clients.get(Number(node.info.props?.["client.id"]));
  const nodes = all.filter((o) => o.type === "PipeWire:Interface:Node");
  const ports = all.filter((o) => o.type === "PipeWire:Interface:Port");
  const portsOf = (nodeId: number, direction: "input" | "output") =>
    ports.filter((p) => Number(p.info.props?.["node.id"]) === nodeId && p.info.direction === direction && p.info.props?.["port.monitor"] !== true);

  const recorder = nodes.find((n) => n.info.props?.["node.name"] === AUDIO_NODE && clientOf(n)?.pid === opts.recorderPid);
  if (!recorder) return null;
  const inputs = new Map<string, number>();
  for (const p of portsOf(recorder.id, "input")) inputs.set(String(p.info.props?.["audio.channel"]), p.id);

  const existing: Array<[number, number]> = [];
  for (const o of all) {
    if (o.type === "PipeWire:Interface:Link") existing.push([Number(o.info["output-port-id"]), Number(o.info["input-port-id"])]);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeOfPort = new Map<number, Obj>();
  for (const p of ports) {
    const n = nodeById.get(Number(p.info.props?.["node.id"]));
    if (n) nodeOfPort.set(p.id, n);
  }

  return {
    recorder,
    inputs,
    existing,
    nodeOfPort,
    isSource(n: Obj): boolean {
      if (n.id === recorder.id || n.info.props?.["media.class"] !== "Stream/Output/Audio") return false;
      const c = clientOf(n);
      // Sin cliente o sin pid no se sabe de quién es: podría ser la voz de la llamada.
      if (!c || c.pid === null) return false;
      return !MIXERS.has(c.bin) && !opts.isOwn(c.pid);
    },
    outputs: (n: Obj) => portsOf(n.id, "output"),
  };
}

/** Enlaces que faltan, como pares [puerto de salida de una app, puerto de entrada nuestro]. */
export function planLinks(dump: unknown, opts: { recorderPid: number; isOwn: (pid: number) => boolean }): Array<[number, number]> {
  const g = graph(dump, opts);
  if (!g) return [];
  const existing = new Set(g.existing.map(([out, input]) => `${out}:${input}`));
  const pairs: Array<[number, number]> = [];
  for (const n of new Set(g.nodeOfPort.values())) {
    if (!g.isSource(n)) continue;
    for (const p of g.outputs(n)) {
      for (const channel of CHANNEL_MAP[String(p.info.props?.["audio.channel"])] ?? []) {
        const input = g.inputs.get(channel);
        if (input !== undefined && !existing.has(`${p.id}:${input}`)) pairs.push([p.id, input]);
      }
    }
  }
  return pairs;
}

/** Enlaces a nuestra entrada que no deberían estar (zcord, un mezclador, algo sin identificar): a deshacer. */
export function planUnlinks(dump: unknown, opts: { recorderPid: number; isOwn: (pid: number) => boolean }): Array<[number, number]> {
  const g = graph(dump, opts);
  if (!g) return [];
  const ours = new Set(g.inputs.values());
  return g.existing.filter(([out, input]) => {
    if (!ours.has(input)) return false;
    const n = g.nodeOfPort.get(out);
    return !n || !g.isSource(n);
  });
}

async function runText(env: CaptureEnv, cmd: string[], timeoutMs: number): Promise<{ code: number; text: string }> {
  const proc: ProcLike = env.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const text = proc.stdout && typeof proc.stdout !== "number" ? await new Response(proc.stdout).text() : "";
    return { code: await proc.exited, text };
  } finally {
    clearTimeout(timer);
  }
}

async function readDump(env: CaptureEnv, timeoutMs: number): Promise<unknown[] | null> {
  try {
    const { code, text } = await runText(env, ["pw-dump"], timeoutMs);
    if (code !== 0) return null;
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** ¿Se puede capturar el audio de la PC? Hacen falta las herramientas de PipeWire y que PipeWire conteste. */
export async function probeDesktopAudio(env: CaptureEnv, timeoutMs = 2_000): Promise<boolean> {
  if (!["pw-record", "pw-link", "pw-dump"].every((bin) => env.which(bin))) return false;
  return (await readDump(env, timeoutMs)) !== null;
}

export interface AudioLinker {
  stop(): Promise<void>;
}

/** Enlaza, mientras dure, las apps que suenan al pw-record de `recorderPid`. */
export function startAudioLinker(opts: {
  env: CaptureEnv;
  recorderPid: number;
  isOwn?: (pid: number) => boolean;
  intervalMs?: number;
}): AudioLinker {
  const isOwn = opts.isOwn ?? isZcordProcess;
  const interval = opts.intervalMs ?? LINK_INTERVAL_MS;
  let stopped = false;
  let wake: (() => void) | null = null;
  let warned = false;

  const loop = (async () => {
    while (!stopped) {
      const dump = await readDump(opts.env, 2_000);
      if (stopped) break;
      if (dump === null && !warned) {
        warned = true;
        log.warn("golive.audio-dump-failed");
      }
      const plan = { recorderPid: opts.recorderPid, isOwn };
      for (const [out, input] of dump ? planUnlinks(dump, plan) : []) {
        if (stopped) break;
        await runText(opts.env, ["pw-link", "-d", String(out), String(input)], 2_000).catch(() => null);
      }
      for (const [out, input] of dump ? planLinks(dump, plan) : []) {
        if (stopped) break;
        // Sin `-L` igual queda (linger es el default de pw-link): muere con el nodo de pw-record.
        await runText(opts.env, ["pw-link", String(out), String(input)], 2_000).catch(() => null);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        wake = () => (clearTimeout(timer), resolve());
      });
      wake = null;
    }
  })();

  return {
    async stop(): Promise<void> {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
