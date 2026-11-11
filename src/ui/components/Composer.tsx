import { TextAttributes, type TextRenderable } from "@opentui/core";
import { For, Show, type JSX } from "solid-js";

import { formatBytes } from "../../uploads/file";
import type { PendingAttachment } from "../../store/types";
import type { MentionCandidate } from "../mentions";
import { nextGrapheme, offsetAt } from "../text-edit";
import type { Theme } from "../theme";
import { Avatar } from "./Avatar";
import { Button, type Click } from "./Button";

export function MentionPopup(props: {
  candidates: MentionCandidate[];
  index: number;
  theme: Theme;
  onPick?(index: number): void;
  onMove?(index: number): void;
  /** Con avatares (setting `showAvatars`): la URL de cada uno, o null si las imágenes están apagadas. */
  avatar?(userId: string): string | null;
}): JSX.Element {
  return (
    <box
      onMouseScroll={(e: { scroll?: { direction: string; delta?: number }; stopPropagation(): void }) => {
        e.stopPropagation();
        // OpenTUI junta las vueltas rápidas de la rueda en un evento con `delta` > 1.
        const steps = Math.max(1, Math.round(Math.abs(e.scroll?.delta ?? 1)));
        const delta = e.scroll?.direction === "down" ? steps : e.scroll?.direction === "up" ? -steps : 0;
        if (delta !== 0) props.onMove?.(Math.max(0, Math.min(props.candidates.length - 1, props.index + delta)));
      }}
      border
      borderStyle="rounded"
      borderColor={props.theme.accent}
      title=" @ mencionar · ↑↓ rueda · Tab elige "
      titleColor={props.theme.accent}
      flexDirection="column"
      width={44}
      flexShrink={0}
    >
      <For each={props.candidates}>
        {(candidate, i) => (
          <box
            flexDirection="row"
            backgroundColor={i() === props.index ? props.theme.selection : undefined}
            onMouseDown={(e: Click) => {
              e.stopPropagation();
              props.onPick?.(i());
            }}
          >
            <Show when={props.avatar}>
              <text width={1}> </text>
              <Avatar userId={candidate.userId} name={candidate.label} url={props.avatar!(candidate.userId)} theme={props.theme} />
            </Show>
            <text fg={i() === props.index ? props.theme.selectionFg : props.theme.fg} wrapMode="none">
              {` ${candidate.label}`}
            </text>
            <text fg={props.theme.dim} wrapMode="none">{candidate.secondary ? `  ${candidate.secondary}` : ""}</text>
          </box>
        )}
      </For>
    </box>
  );
}

const PROMPT = "❯ ";

export function Composer(props: {
  text: string;
  cursor?: number;
  insert: boolean;
  replyTo: string | null;
  editing: string | null;
  theme: Theme;
  placeholder?: string;
  context?: string | null;
  /** Lo que se muestra con ✕: adjuntos nuevos o, al editar, los que ya tiene el mensaje. */
  attachments?: Array<{ filename: string; bytes: { byteLength: number } }>;
  prompt?: string | null;
  onClick?(): void;
  /** Click dentro del texto: offset del texto donde poner el cursor. */
  onCursor?(offset: number): void;
  onAttach?(): void;
  onPaste?(): void;
  onRemoveAttachment?(index: number): void;
}): JSX.Element {
  const over = (): boolean => props.text.length > 2000;
  const counter = (): string => (over() ? ` ${props.text.length}/2000 · muy largo ` : ` ${props.text.length}/2000 `);
  const border = (): string => (props.insert ? props.theme.modeInsert : props.theme.border);
  const cursor = (): number => Math.max(0, Math.min(props.text.length, props.cursor ?? props.text.length));
  /** El grafema bajo el cursor ("" al final del texto o "\n" al final de una línea). */
  const under = (): string => props.text.slice(cursor(), nextGrapheme(props.text, cursor()));
  const onLineEnd = (): boolean => under() === "" || under() === "\n";

  let textEl: TextRenderable | undefined;
  function clickAt(e: { x: number; y: number }): void {
    const el = textEl;
    if (!el || !props.onCursor) return;
    const info = el.lineInfo;
    const row = Math.max(0, Math.min(info.lineSources.length - 1, e.y - el.y + el.scrollY));
    const logical = info.lineSources[row] ?? 0;
    // lineStartCols cuenta desde el principio del texto: la columna dentro de la línea lógica
    // es lo que va desde la primera fila visual de esa línea.
    const first = info.lineSources.indexOf(logical);
    const wrapped = (info.lineStartCols[row] ?? 0) - (info.lineStartCols[first] ?? 0);
    const col = wrapped + (e.x - el.x) - (logical === 0 ? PROMPT.length : 0);
    props.onCursor(offsetAt(props.text, logical, col));
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={border()}
      title={props.prompt ? " adjuntar archivo " : props.editing ? " editando " : props.replyTo ? " respondiendo " : undefined}
      titleColor={props.theme.accent}
      bottomTitle={counter()}
      bottomTitleAlignment="right"
      width="100%"
      flexDirection="column"
      flexShrink={0}
      onMouseDown={() => props.onClick?.()}
    >
      <Show when={props.context}>
        <text fg={props.theme.accent} wrapMode="none">{`↪ ${props.context} · Esc cancela`}</text>
      </Show>
      <For each={props.attachments ?? []}>
        {(file, i) => (
          <box flexDirection="row" columnGap={1}>
            <text fg={props.theme.link} wrapMode="none">{`📎 ${file.filename} (${formatBytes(file.bytes.byteLength)}) · x quita`}</text>
            <Button label="✕" theme={props.theme} danger onPress={() => props.onRemoveAttachment?.(i())} />
          </box>
        )}
      </For>
      <box flexDirection="row" width="100%">
      <box flexGrow={1}>
      <Show
        when={props.prompt == null}
        fallback={
          <text wrapMode="char" fg={props.theme.fg}>
            <span style={{ fg: props.theme.accent }}>{"path ❯ "}</span>
            {props.prompt}
            <span style={{ fg: props.theme.modeInsert }}>█</span>
          </text>
        }
      >
        <Show
          when={props.text.length > 0 || props.insert}
          fallback={<text fg={props.theme.faint}>{`· ${props.placeholder ?? "i para escribir"}`}</text>}
        >
          <text
            ref={(el: TextRenderable) => (textEl = el)}
            wrapMode="char"
            fg={over() ? props.theme.error : props.theme.fg}
            onMouseDown={(e: { x: number; y: number }) => clickAt(e)}
          >
            <span style={{ fg: props.insert ? props.theme.modeInsert : props.theme.dim, attributes: TextAttributes.BOLD }}>
              {props.insert ? PROMPT : "· "}
            </span>
            <Show when={props.insert} fallback={props.text}>
              {props.text.slice(0, cursor())}
              <Show
                when={onLineEnd()}
                fallback={<span style={{ fg: props.theme.bg, bg: props.theme.modeInsert }}>{under()}</span>}
              >
                <span style={{ fg: props.theme.modeInsert }}>█</span>
              </Show>
              {props.text.slice(onLineEnd() ? cursor() : cursor() + under().length)}
            </Show>
          </text>
        </Show>
      </Show>
      </box>
      <Show when={props.onAttach || props.onPaste}>
        <box flexDirection="row" columnGap={1} flexShrink={0}>
          <Button label="📎 adjuntar" theme={props.theme} onPress={() => props.onAttach?.()} />
          <Button label="📋 pegar" theme={props.theme} onPress={() => props.onPaste?.()} />
        </box>
      </Show>
      </box>
    </box>
  );
}
