import { useKeyboard } from "@opentui/solid";
import { createSignal, For, Show, type JSX } from "solid-js";

import type { Monitor } from "../../golive/capture";
import { cellWidth, truncate } from "../format";
import { listWindow, moveInList } from "../list-window";
import type { Theme } from "../theme";
import type { Click } from "./Button";

export const MONITOR_ROWS = 8;
const BOX_WIDTH = 46;
/** Celdas para el texto de una fila: el cuadro menos los bordes y ` 🖥 `. */
export const MONITOR_LABEL_WIDTH = BOX_WIDTH - 2 - 4;

/** `Legion 27-10 · HDMI-A-1`: el modelo (cortado a `modelWidth` celdas) y el conector; sin modelo, el conector. */
export function monitorTitle(m: Pick<Monitor, "name" | "model">, modelWidth = Infinity): string {
  const name = m.name || "pantalla predeterminada";
  const model = m.model && modelWidth >= 2 ? truncate(m.model, modelWidth) : "";
  return model ? `${model} · ${name}` : name;
}

/** Fila del selector: modelo · conector · resolución · activo, cortando solo el modelo para que entre. */
export function monitorLabel(m: Monitor): string {
  const size = m.width > 0 && m.height > 0 ? ` · ${m.width}×${m.height}` : "";
  const rest = `${size}${m.focused ? " · activo" : ""}`;
  const room = MONITOR_LABEL_WIDTH - cellWidth(`${m.name || "pantalla predeterminada"}${rest}`) - 3;
  return `${monitorTitle(m, room)}${rest}`;
}

/** Qué monitor transmitir: click, ↑↓/j/k + Enter, rueda; Esc o click afuera cierra. */
export function MonitorPicker(props: {
  monitors: Monitor[];
  current?: string | null;
  theme: Theme;
  onPick(name: string): void;
  onClose(): void;
}): JSX.Element {
  const start = Math.max(0, props.monitors.findIndex((m) => m.name === props.current));
  const [index, setIndex] = createSignal(start);
  const view = () => listWindow(index(), props.monitors.length, MONITOR_ROWS);
  const visible = () => props.monitors.slice(view().start, view().end).map((m, i) => ({ m, at: view().start + i }));
  const pick = (i: number): void => {
    const m = props.monitors[i];
    if (m) props.onPick(m.name);
  };

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape" || key.name === "q") return props.onClose();
    if (key.name === "return") return pick(index());
    const vim = key.name === "j" ? "down" : key.name === "k" ? "up" : key.name;
    const moved = moveInList({ ...key, name: vim }, index(), props.monitors.length, MONITOR_ROWS);
    if (moved !== null) setIndex(moved);
  });

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={60} onMouseDown={() => props.onClose()}>
      <box
        position="absolute"
        bottom={2}
        right={2}
        onMouseDown={(e: Click) => e.stopPropagation()}
        onMouseScroll={(e: { scroll?: { direction: string; delta?: number }; stopPropagation(): void }) => {
          e.stopPropagation();
          const steps = Math.max(1, Math.round(Math.abs(e.scroll?.delta ?? 1)));
          const delta = e.scroll?.direction === "down" ? steps : e.scroll?.direction === "up" ? -steps : 0;
          if (delta !== 0) setIndex((i) => Math.max(0, Math.min(props.monitors.length - 1, i + delta)));
        }}
        border
        borderStyle="rounded"
        borderColor={props.theme.accent}
        backgroundColor={props.theme.panel}
        title=" ¿Qué pantalla transmitir? "
        titleColor={props.theme.accent}
        bottomTitle=" ↑↓ rueda · Enter transmite · Esc cierra "
        bottomTitleAlignment="right"
        width={BOX_WIDTH}
        flexDirection="column"
      >
        <Show when={view().start > 0}>
          <text fg={props.theme.faint}>{`   ↑ ${view().start} más`}</text>
        </Show>
        <For each={visible()}>
          {(row) => (
            <box
              flexDirection="row"
              backgroundColor={row.at === index() ? props.theme.selection : undefined}
              onMouseDown={(e: Click) => {
                e.stopPropagation();
                pick(row.at);
              }}
            >
              <text fg={row.at === index() ? props.theme.selectionFg : props.theme.fg} wrapMode="none">
                {` 🖥 ${monitorLabel(row.m)}`}
              </text>
            </box>
          )}
        </For>
        <Show when={view().end < props.monitors.length}>
          <text fg={props.theme.faint}>{`   ↓ ${props.monitors.length - view().end} más`}</text>
        </Show>
      </box>
    </box>
  );
}
