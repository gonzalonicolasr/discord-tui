import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../config/paths";
import { log } from "../log/logger";
import { spawnClean } from "../proc/spawn";

/** Archivo que deja la app cuando hay versión nueva; `bin/zcord` lo ve al abrir y actualiza antes de arrancar. */
export function updateFlagPath(): string {
  return join(stateDir(), "update-available");
}

type Run = (cmd: string[]) => Promise<{ code: number; out: string }>;

const defaultRun: Run = async (cmd) => {
  const proc = spawnClean(cmd, { stdout: "pipe" });
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    return { code: await proc.exited, out };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * ¿Hay commits nuevos en GitHub? Solo si zcord corre desde un clon (install.sh o git clone: `ZCORD_HOME` con
 * .git); un paquete del sistema lo actualiza su gestor. Devuelve cuántos commits faltan, o null.
 */
export async function checkForUpdate(opts: { repoDir?: string; run?: Run; env?: Record<string, string | undefined> } = {}): Promise<number | null> {
  const env = opts.env ?? process.env;
  const repo = opts.repoDir ?? env.ZCORD_HOME;
  if (!repo || env.ZCORD_NO_AUTO_UPDATE === "1") return null;
  const run = opts.run ?? defaultRun;
  try {
    const inside = await run(["git", "-C", repo, "rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.out.trim() !== "true") return null;
    const fetched = await run(["git", "-C", repo, "fetch", "--quiet", "origin", "main"]);
    if (fetched.code !== 0) return null;
    const behind = await run(["git", "-C", repo, "rev-list", "--count", "HEAD..FETCH_HEAD"]);
    const n = Number(behind.out.trim());
    return behind.code === 0 && Number.isFinite(n) ? n : null;
  } catch (error) {
    log.warn("update.check-failed", { error_name: error instanceof Error ? error.name : "error" });
    return null;
  }
}

/**
 * Chequea en segundo plano; si hay versión nueva deja la marca para el próximo arranque y avisa con el SHA de
 * FETCH_HEAD (la versión que espera en GitHub; null si no se pudo leer): con eso se recarga solo una vez por versión.
 */
export async function scheduleUpdateCheck(
  onAvailable: (behind: number, sha: string | null) => void,
  deps: Parameters<typeof checkForUpdate>[0] & { writeFlag?: (text: string) => void } = {},
): Promise<void> {
  const behind = await checkForUpdate(deps);
  if (behind === null || behind <= 0) return;
  let sha: string | null = null;
  try {
    const head = await (deps.run ?? defaultRun)(["git", "-C", deps.repoDir ?? (deps.env ?? process.env).ZCORD_HOME ?? "", "rev-parse", "FETCH_HEAD"]);
    const out = head.out.trim();
    if (head.code === 0 && /^[0-9a-f]{40}$/.test(out)) sha = out;
  } catch {
    // sin SHA: se avisa, pero no se recarga solo
  }
  try {
    (deps.writeFlag ?? ((text: string) => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(updateFlagPath(), text);
    }))(`${behind}\n`);
  } catch {
    // sin marca: igual se avisa
  }
  log.info("update.available", { count: behind });
  onAvailable(behind, sha);
}

/** Primera búsqueda un rato después de arrancar (sin apurar la conexión) y después cada 30 min. Devuelve el stop. */
export function startUpdateChecks(check: () => void, firstMs = 15_000, everyMs = 30 * 60_000): () => void {
  let timer = setTimeout(function tick() {
    check();
    timer = setTimeout(tick, everyMs);
    (timer as { unref?: () => void }).unref?.();
  }, firstMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}
