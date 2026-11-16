// Prueba de oído de los sonidos de eventos: los reproduce uno por uno por la salida predeterminada (pw-cat),
// con su nombre en pantalla, al volumen del archivo (sin el ajuste de volumen de zcord).
//   bun scripts/sounds-preview.ts              los 12, en orden
//   bun scripts/sounds-preview.ts join         solo uno
//   bun scripts/sounds-preview.ts --compare    cada uno: primero el sintetizado viejo, después el nuevo
//   bun scripts/sounds-preview.ts --synth      solo los sintetizados viejos
//   bun scripts/sounds-preview.ts --alt        los alternativos de src/sounds/wav/alt/
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createCueLibrary, cueFrames, defaultSoundsDir } from "../src/sounds/library";
import { CUES, renderCue, type Cue } from "../src/sounds/synth";
import { startPlayback, type SpawnLike } from "../src/voice/audio-io";

const USAGE = `Uso: bun scripts/sounds-preview.ts [evento] [--compare | --synth | --alt]
Eventos: ${CUES.join(", ")}`;
/** Margen antes de cerrar pw-cat (cerrarlo antes de que suene lo corta) y pausa entre sonidos. */
const TAIL_MS = 150;
const GAP_MS = 500;

type Version = { label: string; frames: (cue: Cue) => Uint8Array[] | null };

export async function runPreview(
  args: string[],
  deps: { spawn?: SpawnLike; sleep?: (ms: number) => Promise<void>; print?: (line: string) => void } = {},
): Promise<number> {
  const sleep = deps.sleep ?? Bun.sleep;
  const print = deps.print ?? ((line: string): void => console.log(line));
  const flags = args.filter((a) => a.startsWith("--"));
  const names = args.filter((a) => !a.startsWith("--"));
  const known = new Set(["--compare", "--synth", "--alt"]);
  const badName = names.some((n) => !(CUES as readonly string[]).includes(n));
  if (names.length > 1 || flags.length > 1 || flags.some((f) => !known.has(f)) || badName) {
    print(USAGE);
    return 2;
  }
  const cues = names.length === 1 ? [names[0] as Cue] : [...CUES];

  const altDir = join(defaultSoundsDir(), "alt");
  const alt = createCueLibrary({ dir: altDir, warn: () => {} });
  const synth: Version = { label: "sintetizado viejo", frames: renderCue };
  const current: Version = { label: "nuevo", frames: cueFrames };
  const alternative: Version = {
    label: "alternativo (alt/)",
    frames: (cue) => (existsSync(join(altDir, `${cue}.wav`)) ? alt.frames(cue) : null),
  };
  const byFlag: Record<string, Version[]> = { "--compare": [synth, current], "--synth": [synth], "--alt": [alternative] };
  const versions = byFlag[flags[0] ?? ""] ?? [current];

  for (const cue of cues) {
    for (const version of versions) {
      const frames = version.frames(cue);
      if (!frames) {
        print(`  ${cue.padEnd(12)} (sin alternativo)`);
        continue;
      }
      const ms = frames.length * 20;
      print(`▶ ${cue.padEnd(12)} ${version.label}, ${ms} ms`);
      try {
        const out = await startPlayback({ spawn: deps.spawn });
        out.write(concat(frames));
        await sleep(ms + TAIL_MS);
        await out.stop();
      } catch (error) {
        print(`No pude reproducir con pw-cat: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      await sleep(GAP_MS);
    }
  }
  return 0;
}

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.length * (frames[0]?.byteLength ?? 0));
  frames.forEach((frame, i) => out.set(frame, i * frame.byteLength));
  return out;
}

if (import.meta.main) process.exit(await runPreview(process.argv.slice(2)));
