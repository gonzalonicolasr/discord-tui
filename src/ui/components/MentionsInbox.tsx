import { TextAttributes } from "@opentui/core";
import { For, Show, type JSX } from "solid-js";

import type { InboxMention } from "../../actions";
import { plainText, parseMarkdown } from "../../markdown/parse";
import { truncate } from "../format";
import { listWindow } from "../list-window";
import type { Theme } from "../theme";
import type { Click } from "./Button";

/** Menciones visibles a la vez (cada una ocupa 2 filas). */
export const INBOX_ROWS = 8;
const WIDTH = 88;

function when(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return hm;
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

/**
 * Bandeja de menciones (como la de Discord): dónde, quién y cuándo te mencionaron. Enter o click lleva al
 * mensaje; j/k o la rueda se mueven; Esc cierra.
 */
export function MentionsInbox(props: {
  items: InboxMention[] | null;
  error: string | null;
  index: number;
  theme: Theme;
  onPick?(index: number): void;
  onMove?(index: number): void;
  onClose?(): void;
}): JSX.Element {
  const items = (): InboxMention[] => props.items ?? [];
  const view = () => listWindow(props.index, items().length, INBOX_ROWS);
  const visible = () => items().slice(view().start, view().end).map((item, i) => ({ item, at: view().start + i }));
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" paddingTop={3} alignItems="center" zIndex={50} onMouseDown={() => props.onClose?.()}>
      <box
        onMouseDown={(e: Click) => e.stopPropagation()}
        onMouseScroll={(e: { scroll?: { direction: string; delta?: number }; stopPropagation(): void }) => {
          e.stopPropagation();
          const steps = Math.max(1, Math.round(Math.abs(e.scroll?.delta ?? 1)));
          const delta = e.scroll?.direction === "down" ? steps : e.scroll?.direction === "up" ? -steps : 0;
          if (delta !== 0 && items().length > 0) props.onMove?.(Math.max(0, Math.min(items().length - 1, props.index + delta)));
        }}
        border
        borderStyle="rounded"
        borderColor={props.theme.mention}
        backgroundColor={props.theme.panel}
        title=" 🔔 Menciones "
        titleColor={props.theme.mention}
        bottomTitle={` ${items().length > 0 ? `${props.index + 1}/${items().length} · ` : ""}j/k o rueda · Enter va al mensaje · Esc cierra `}
        bottomTitleAlignment="right"
        width={WIDTH}
        flexDirection="column"
      >
        <Show when={props.items === null && props.error === null}>
          <text fg={props.theme.dim}> buscando tus menciones…</text>
        </Show>
        <Show when={props.error}>
          <text fg={props.theme.error}>{` ${props.error}`}</text>
        </Show>
        <Show when={props.items !== null && items().length === 0}>
          <text fg={props.theme.dim}> nadie te mencionó últimamente</text>
        </Show>
        <Show when={view().start > 0}>
          <text fg={props.theme.faint}>{`   ↑ ${view().start} más`}</text>
        </Show>
        <For each={visible()}>
          {(row) => {
            const selected = (): boolean => row.at === props.index;
            const text = (): string => plainText(parseMarkdown(row.item.content)).replace(/\s+/g, " ").trim() || "(sin texto: adjunto o embed)";
            return (
              <box
                flexDirection="column"
                backgroundColor={selected() ? props.theme.selection : undefined}
                onMouseDown={(e: Click) => {
                  e.stopPropagation();
                  props.onPick?.(row.at);
                }}
              >
                <text fg={selected() ? props.theme.selectionFg : props.theme.dim} wrapMode="none">
                  <span style={{ fg: props.theme.mention, attributes: TextAttributes.BOLD }}>{` ${row.item.author}`}</span>
                  {` · ${truncate(row.item.where, WIDTH - row.item.author.length - 16)} · ${when(row.item.timestamp)}`}
                </text>
                <text fg={selected() ? props.theme.selectionFg : props.theme.fg} wrapMode="none">
                  {`   ${truncate(text(), WIDTH - 6)}`}
                </text>
              </box>
            );
          }}
        </For>
        <Show when={view().end < items().length}>
          <text fg={props.theme.faint}>{`   ↓ ${items().length - view().end} más`}</text>
        </Show>
      </box>
    </box>
  );
}
