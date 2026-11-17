import { ImageRenderable, NativeImagePool, Renderable, RGBA, type BoxRenderable, type OptimizedBuffer } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, Show, type JSX } from "solid-js";

import type { VoiceActions } from "../../actions/voice";
import type { Store } from "../../store/store";
import type { DecodedFrame } from "../../watch/decode";
import type { FrameSubscription } from "../../watch/watch";
import { displayName, truncate } from "../format";
import { KittyVideo, probeZlib, visibleParts, type VideoView } from "../kitty-video";
import { jsonEqual, useSelector } from "../store-bridge";
import type { Theme } from "../theme";
import { Button } from "./Button";

/** Píxeles por celda para la caja del decodificador (como los GIFs) y tope de la caja (CPU y ancho de banda a la terminal). */
const CELL_W = 10;
const CELL_H = 20;
const MAX_W = 960;
const MAX_H = 540;

/** Estados del sondeo del archivo en los que ya se sabe que no anda: el video va por KittyVideo. */
const FILE_FAILED = new Set(["unsupported", "timeout", "io-error"]);

/** Renderers cuya terminal ya dijo que entiende zlib (`o=z`). Un "no" o el silencio se vuelven a preguntar al mirar otra vez. */
const zlibTerminals = new WeakSet<object>();

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
  // Sin transporte por archivo el `<image>` borra antes de colocar (parpadeo en herdr-core): el video va por KittyVideo.
  // Se decide una vez que el sondeo del archivo terminó; mientras sondea (y si anda) sigue el `<image>`, como siempre.
  let path: "image" | "own" | null = null;
  let video: KittyVideo | null = null;
  let frameSize = { width: 0, height: 0 };
  let videoView: VideoView | null = null;
  function decidePath(): "image" | "own" {
    if (path) return path;
    if (!renderer.capabilities) return "image";
    if (image!.effectiveProtocol !== "kitty") return (path = "image");
    const state = renderer.kittyImageTransportStatus.fileState;
    if (state === "probing") return "image";
    return (path = FILE_FAILED.has(state) ? "own" : "image");
  }
  /**
   * Dónde y qué partes de la imagen se ven: la caja como la coloca el `<image>` (centrada y ajustada), menos las celdas
   * que tapa algo con fondo pintado después (según los hits del último cuadro presentado), como recorta el nativo.
   */
  function computeView(): VideoView {
    const img = image!;
    const fit = img.getFittedSize(img.width, img.height, img.cellAspectRatio, frameSize.width, frameSize.height);
    const box = {
      col: img.screenX + Math.floor((img.width - fit.width) / 2),
      row: img.screenY + Math.floor((img.height - fit.height) / 2),
      cols: fit.width,
      rows: fit.height,
    };
    const mine = new Set<number>();
    for (let r: Renderable | null = img; r; r = r.parent) mine.add(r.num);
    const opaque = new Map<number, boolean>();
    const coveredBy = (num: number): boolean => {
      let hit = opaque.get(num);
      if (hit === undefined) {
        hit = false;
        for (let r = Renderable.renderablesByNumber.get(num) ?? null; r && !mine.has(r.num); r = r.parent) {
          const bg = (r as { backgroundColor?: { a: number } }).backgroundColor;
          if (bg && bg.a > 0) (hit = true), (r = null);
          if (!r) break;
        }
        opaque.set(num, hit);
      }
      return hit;
    };
    const parts = visibleParts(box.cols, box.rows, (x, y) => {
      const num = renderer.hitTest(box.col + x, box.row + y);
      return num !== 0 && !mine.has(num) && coveredBy(num);
    });
    return { box, parts };
  }
  const onPresented = (): void => {
    if (!video || !image || image.isDestroyed || !hasFrame()) return;
    videoView = computeView();
    video.move(videoView);
  };
  /**
   * Las celdas debajo del video con el fondo por defecto de la terminal, como las deja el `<image>` nativo: la app
   * Herdr dibuja las imágenes debajo del texto por debajo de los fondos de celda pintados, y con el fondo del tema
   * encima el recuadro mostraba solo el fondo. Solo las partes que se ven: lo que tapa el video se pinta después.
   */
  const holeBg = RGBA.defaultBackground();
  function paintHole(buffer: OptimizedBuffer): void {
    if (!video || !videoView || !hasFrame()) return;
    const { box, parts } = videoView;
    for (const p of parts) buffer.fillRect(box.col + p.x, box.row + p.y, p.w, p.h, holeBg);
  }
  function startOwnVideo(): KittyVideo {
    const v = new KittyVideo(renderer.nativeScene.driver);
    renderer.on("frame", onPresented); // después de cada cuadro: lo que tapa el video o dónde quedó la caja
    if (process.env.ZCORD_KITTY_HOLE !== "0") image!.renderAfter = paintHole;
    if (process.env.ZCORD_KITTY_ZLIB === "0") return v;
    if (zlibTerminals.has(renderer)) v.zlib = true;
    else
      void probeZlib(renderer.nativeScene.driver, renderer).then((ok) => {
        if (ok) (zlibTerminals.add(renderer), (v.zlib = true));
      });
    return v;
  }

  const fpsTimer = setInterval(() => {
    setFps(shownThisSecond + (video?.written ?? 0));
    shownThisSecond = 0;
    if (video) video.written = 0;
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
      if (decidePath() === "own") {
        if (image.source) image.source = undefined;
        video ??= startOwnVideo();
        if (!hasFrame()) return void setHasFrame(true); // la caja recién crece en la pintada siguiente
        if (frame.width !== frameSize.width || frame.height !== frameSize.height || !videoView) {
          frameSize = { width: frame.width, height: frame.height };
          videoView = computeView();
        }
        video.show(frame.rgba, frame.width, frame.height, videoView);
        return;
      }
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
    renderer.off("frame", onPresented);
    video?.dispose();
    video = null;
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
