/**
 * OpenTUI, por defecto, ante SIGINT/SIGTERM/SIGHUP o Ctrl+C solo destruye el renderer: el gateway (y la voz)
 * siguen vivos sin terminal. Se le sacan esas salidas y zcord las maneja con su propio quit().
 */
export const RENDERER_EXIT_OPTIONS = { exitSignals: [] as NodeJS.Signals[], exitOnCtrlC: false };

export const EXIT_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT", "SIGQUIT"] as const;

/** Lo mínimo de `process` que hace falta (inyectable en tests). */
export interface SignalTarget {
  on(signal: string, fn: () => void): unknown;
  off(signal: string, fn: () => void): unknown;
}

export function onExitSignals(fn: () => void, target: SignalTarget = process): () => void {
  for (const signal of EXIT_SIGNALS) target.on(signal, fn);
  return () => {
    for (const signal of EXIT_SIGNALS) target.off(signal, fn);
  };
}
