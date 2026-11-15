import { ImageRenderable, NativeImagePool, type BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import type { VoiceActions } from "../../actions/voice";
import type { Store } from "../../store/store";
import type { DecodedFrame } from "../../watch/decode";
import type { FrameSubscription } from "../../watch/watch";
import { displayName, truncate } from "../format";
import { jsonEqual, useSelector } from "../store-bridge";
import type { Theme } from "../theme";
import { Button } from "./Button";

/** Píxeles por celda para la caja del decodificador (como los GIFs) y tope de la caja (CPU y ancho de banda a la terminal). */
const CELL_W = 10;
const CELL_H = 20;
const MAX_W = 960;
const MAX_H = 540;

export function videoBox(cols: number, rows: number): { width: number; height: number } {
  return { width: Math.max(32, Math.min(MAX_W, cols * CELL_W)), height: Math.max(18, Math.min(MAX_H, rows * CELL_H)) };
}

/**
 * La transmisión que estás mirando, en lugar del panel de mensajes. Los cuadros llegan del watcher (no pasan por
 * Solid): se suben con un `NativeImagePool` y se cambia el `source` del `<image>`, como los GIFs. Mientras la vista
 * está montada hay suscripción (y decodificación); al desmontarse se suelta y el watcher deja de decodificar.
 */
export function StreamViewer(props: { store: Store; theme: Theme; voice: VoiceActions | undefined; focused?: boolean; titleWidth?: number }): JSX.Element {
  const renderer = useRenderer();
  const view = useSelector(
    props.store,
    (s) => {
      const w = s.voice.watch;
      const guildId = s.voice.guildId;
      return { status: w.status, error: w.error, name: w.userId ? displayName(s, w.userId, guildId) : "" };
    },
    jsonEqual,
  );
  const [fps, setFps] = createSignal(0);
  const [hasFrame, setHasFrame] = createSignal(false);
  let area: BoxRenderable | undefined;
  let image: ImageRenderable | undefined;
  let pool: NativeImagePool | null = null;
  let sub: FrameSubscription | null = null;
  let shownThisSecond = 0;
  let lastBox = "";

  const fpsTimer = setInterval(() => {
    setFps(shownThisSecond);
    shownThisSecond = 0;
  }, 1000);

  function areaBox(): { width: number; height: number } {
    const cols = area && !area.isDestroyed ? area.width : 64;
    const rows = area && !area.isDestroyed ? area.height : 18;
    return videoBox(cols, rows);
  }

  function show(frame: DecodedFrame): void {
    if (!image || image.isDestroyed) return;
    const box = areaBox();
    const key = `${box.width}x${box.height}`;
    if (key !== lastBox) {
      lastBox = key;
      sub?.resize(box.width, box.height);
    }
    try {
      if (!pool || pool.width !== frame.width || pool.height !== frame.height) {
        pool?.dispose();
        pool = new NativeImagePool({ width: frame.width, height: frame.height, capacity: 3, owner: renderer.nativeScene.resourceContext });
      }
      const next = pool.publishRgba(frame.rgba);
      if (!next) return; // los 3 buffers ocupados: se saltea este cuadro
      image.source = next; // el renderable se queda con su propia referencia
      next.dispose();
      shownThisSecond++;
      if (!hasFrame()) setHasFrame(true);
    } catch {
      // renderer cerrándose o buffer inválido: queda el último cuadro
    }
  }

  const start = areaBox();
  lastBox = `${start.width}x${start.height}`;
  sub = props.voice?.watchFrames?.(start.width, start.height, show) ?? null;
  onCleanup(() => {
    clearInterval(fpsTimer);
    sub?.unsubscribe();
    sub = null;
    pool?.dispose();
    pool = null;
  });

  const close = (): void => void props.voice?.stopWatching?.();
  const header = (): string => {
    const v = view();
    if (v.status === "connecting") return `⏳ conectando con la transmisión de ${v.name}…`;
    if (v.status === "error") return `📺 ${v.name}`;
    return `📺 ${v.name} · en vivo${hasFrame() ? ` · ${fps()} fps` : ""}`;
  };

  return (
    <box
      title={` ${truncate(`📺 ${view().name}`, props.titleWidth ?? 60)} `}
      titleColor={props.focused ? props.theme.borderFocus : props.theme.header}
      border
      borderStyle="rounded"
      borderColor={props.focused ? props.theme.borderFocus : props.theme.border}
      flexGrow={1}
      height="100%"
      flexDirection="column"
    >
      <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={props.theme.panel} columnGap={1}>
        <text fg={view().status === "error" ? props.theme.error : props.theme.header} wrapMode="none" flexGrow={1}>
          {header()}
        </text>
        <Button label={view().status === "error" ? "✕ cerrar" : "✕ dejar de ver"} theme={props.theme} danger onPress={close} />
      </box>
      <box
        ref={(el: BoxRenderable) => (area = el)}
        flexGrow={1}
        width="100%"
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Show when={view().status === "error"}>
          <text fg={props.theme.error} wrapMode="word">{view().error ?? "se cortó la transmisión"}</text>
          <text fg={props.theme.faint}>Esc para cerrar</text>
        </Show>
        <Show when={view().status !== "error" && !hasFrame()}>
          <text fg={props.theme.dim}>{view().status === "connecting" ? "esperando el video…" : "esperando el primer cuadro…"}</text>
        </Show>
        <image
          ref={(node: ImageRenderable) => (image = node)}
          width="100%"
          flexGrow={hasFrame() ? 1 : 0}
          height={hasFrame() ? undefined : 0}
          fit="fit"
          protocol="auto"
        />
      </box>
      <box height={1} width="100%" paddingLeft={1} flexShrink={0}>
        <text fg={props.theme.faint} wrapMode="none">Esc o w: dejar de ver · sin audio de la transmisión (todavía)</text>
      </box>
    </box>
  );
}
