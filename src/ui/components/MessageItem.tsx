import { TextAttributes } from "@opentui/core";
import { createResource, createSignal, For, Show, type JSX } from "solid-js";

export type MessageAction = "reply" | "edit" | "delete" | "react";

import { userAvatarUrl } from "../../images/avatar";
import { attachmentView, emojiUrl, sizedUrl, stickerView } from "../../images/cdn";
import { imageCache } from "../../images/cache";
import { frameCache } from "../../images/frames";
import { mayAnimate, type Animation } from "../../images/gif";
import { IMAGE_MODE } from "../../images/mode";
import { jumboEmoji, type JumboEmoji } from "../../markdown/jumbo";
import { parseMarkdown, plainText } from "../../markdown/parse";
import type { ApiEmbed, ApiPoll, AppState, Message } from "../../store/types";
import { clockTime, displayName, hashIndex, memberColor, truncate } from "../format";
import { roleHex, type Theme } from "../theme";
import { AnimatedImage } from "./AnimatedImage";
import { Avatar } from "./Avatar";
import { Button, type Click } from "./Button";
import { Markdown, type MdContext } from "./Markdown";
import { PollBox } from "./PollBox";

function authorColor(state: AppState, theme: Theme, userId: string, guildId: string | null): string {
  return roleHex(memberColor(state, userId, guildId)) ?? theme.names[hashIndex(userId, theme.names.length)]!;
}

function InlineImage(props: { url: string; cols: number; rows: number; label: string; theme: Theme; raw?: boolean; animate?: boolean }): JSX.Element {
  const url = (): string => (props.raw ? props.url : sizedUrl(props.url, props.cols, props.rows));
  const [bytes] = createResource(url, (u) => imageCache.get(u));
  // GIF/WebP con animaciones prendidas: se decodifican los cuadros. Mientras tanto, o si falla o es de
  // un solo cuadro, queda la imagen quieta de siempre (OpenTUI muestra el primer cuadro).
  const [animation] = createResource(
    () => {
      const data = bytes();
      return props.animate && data && mayAnimate(data) ? url() : false;
    },
    (u) => frameCache.get(u, props.cols, props.rows),
  );
  const still = (data: Uint8Array): JSX.Element => <image source={data} width={props.cols} height={props.rows} fit="fit" protocol="auto" />;
  return (
    <Show when={bytes()} fallback={<text fg={props.theme.dim}>{props.label}</text>}>
      {(data: () => Uint8Array) => (
        <Show when={props.animate ? animation() : null} fallback={still(data())}>
          {(anim: () => Animation) => <AnimatedImage animation={anim()} cols={props.cols} rows={props.rows} />}
        </Show>
      )}
    </Show>
  );
}

/** Mensaje de sólo emojis: los custom como imagen de 4x2 celdas, los unicode como texto en la misma fila. */
function JumboRow(props: { emoji: JumboEmoji[]; theme: Theme; edited: boolean; animate?: boolean }): JSX.Element {
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={1} width="100%">
      <For each={props.emoji}>
        {(emoji) =>
          emoji.kind === "custom" ? (
            <InlineImage url={emojiUrl(emoji.id, emoji.animated)} cols={4} rows={2} label={`:${emoji.name}:`} theme={props.theme} raw animate={props.animate} />
          ) : (
            <text fg={props.theme.fg} height={2}>{emoji.text}</text>
          )
        }
      </For>
      <Show when={props.edited}>
        <text fg={props.theme.dim}>(editado)</text>
      </Show>
    </box>
  );
}

type EmbedMedia = { url: string; proxy_url?: string; width?: number; height?: number };

/** La imagen de un embed gifv que ya es un GIF (por la extensión o el content_type), si hay. */
function gifvGif(embed: ApiEmbed): EmbedMedia | undefined {
  const isGifUrl = (u: string | undefined): boolean => {
    try {
      return u !== undefined && new URL(u).pathname.toLowerCase().endsWith(".gif");
    } catch {
      return false;
    }
  };
  return [embed.image, embed.thumbnail].find(
    (m) => m && ((m as { content_type?: string }).content_type === "image/gif" || isGifUrl(m.proxy_url) || isGifUrl(m.url)),
  ) as EmbedMedia | undefined;
}

function EmbedView(props: { embed: ApiEmbed; ctx: MdContext; images: boolean; animate?: boolean; onOpen?(url: string): void }): JSX.Element {
  const theme = props.ctx.theme;
  const bar = (): string => roleHex(props.embed.color ?? 0) ?? theme.border;
  const description = (): string => {
    const lines = (props.embed.description ?? "").split("\n");
    return lines.length > 6 ? `${lines.slice(0, 6).join("\n")}\n…` : lines.join("\n");
  };
  // gifv (Tenor/Giphy): si alguna imagen del embed es un GIF se anima; si no, miniatura quieta + ▶ que abre el link.
  const gifv = (): boolean => props.embed.type === "gifv";
  const gifMedia = (): EmbedMedia | undefined => (gifv() ? gifvGif(props.embed) : undefined);
  const image = (): EmbedMedia | undefined => gifMedia() ?? ((props.embed.image ?? props.embed.thumbnail) as EmbedMedia | undefined);
  const playUrl = (): string | undefined => (gifv() && !gifMedia() ? (props.embed.url ?? props.embed.video?.url) : undefined);
  const open = (url: string | undefined) => (e: Click): void => {
    if (!url) return;
    e.stopPropagation();
    props.onOpen?.(url);
  };
  return (
    <box flexDirection="row" width="100%" marginTop={0}>
      <text fg={bar()}>▌</text>
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <Show when={props.embed.provider?.name}>
          <text fg={theme.dim}>{props.embed.provider?.name}</text>
        </Show>
        <Show when={props.embed.author?.name}>
          <text fg={theme.fg} attributes={TextAttributes.BOLD}>{props.embed.author?.name}</text>
        </Show>
        <Show when={props.embed.title}>
          <text
            fg={props.embed.url ? theme.link : theme.fg}
            attributes={TextAttributes.BOLD}
            wrapMode="word"
            onMouseDown={(e: Click) => {
              if (!props.embed.url) return;
              e.stopPropagation();
              props.onOpen?.(props.embed.url);
            }}
          >
            {props.embed.title}
          </text>
        </Show>
        <Show when={props.embed.description}>
          <Markdown nodes={parseMarkdown(description())} ctx={props.ctx} />
        </Show>
        <Show when={image()}>
          {(img: () => EmbedMedia) => {
            const view = attachmentView(
              {
                filename: "imagen",
                size: 0,
                url: img().url,
                proxy_url: (img() as { proxy_url?: string }).proxy_url ?? img().url,
                content_type: "image/png",
                width: img().width,
                height: img().height,
              },
              props.images ? IMAGE_MODE : "links",
            );
            return view.kind === "image" ? (
              <box onMouseDown={open(playUrl() ?? (gifMedia() ? props.embed.url : undefined))}>
                <InlineImage url={view.url} cols={Math.min(view.cols, 30)} rows={Math.min(view.rows, 8)} label="🖼 imagen" theme={theme} animate={props.animate} />
              </box>
            ) : null;
          }}
        </Show>
        <Show when={playUrl()}>
          <text fg={theme.link} wrapMode="none" onMouseDown={open(playUrl())}>
            ▶ GIF · click para verlo
          </text>
        </Show>
      </box>
    </box>
  );
}

export function MessageItem(props: {
  message: Message;
  state: AppState;
  theme: Theme;
  guildId: string | null;
  grouped: boolean;
  selected?: boolean;
  images?: boolean;
  /** GIFs y emojis animados se mueven (setting `animateImages`); sin esto, primer cuadro. */
  animate?: boolean;
  /** Avatar antes del nombre (setting `showAvatars`); con `images` apagado queda la inicial. */
  avatars?: boolean;
  onSelect?(): void;
  onAction?(action: MessageAction): void;
  onReact?(emoji: { id: string | null; name: string }): void;
  onOpen?(url: string): void;
  onVote?(answerId: number): void;
}): JSX.Element {
  const theme = (): Theme => props.theme;
  const animate = (): boolean => props.images === true && props.animate === true;
  const [hover, setHover] = createSignal(false);
  const mine = (): boolean => props.message.authorId === props.state.me?.id;
  const ctx = (): MdContext => ({ state: props.state, theme: props.theme, guildId: props.guildId, revealSpoilers: props.selected === true });
  const author = (): string => displayName(props.state, props.message.authorId, props.guildId);
  const nodes = () => parseMarkdown(props.message.content);
  const jumbo = (): JumboEmoji[] | null => {
    if (!props.images) return null;
    const emoji = jumboEmoji(nodes());
    return emoji?.some((e) => e.kind === "custom") ? emoji : null;
  };
  const bg = (): string | undefined => (props.selected ? props.theme.selection : hover() ? props.theme.panel : undefined);
  const gutter = (): string => (props.selected ? props.theme.accent : props.message.mentionsMe ? props.theme.mention : "");

  const referenced = (): string | null => {
    const ref = props.message.referenced;
    if (!ref) return null;
    const who = ref.authorId ? displayName(props.state, ref.authorId, props.guildId) : "mensaje";
    const text = plainText(parseMarkdown(ref.content), {
      user: (id) => displayName(props.state, id, props.guildId),
      channel: (id) => props.state.channels[id]?.name ?? "canal",
    });
    return `╭─ @${who} ${truncate(text || "(adjunto)", 60)}`;
  };

  return (
    <box
      id={`msg-${props.message.id}`}
      flexDirection="row"
      width="100%"
      backgroundColor={bg()}
      marginTop={props.grouped ? 0 : 1}
      onMouseDown={() => props.onSelect?.()}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text fg={gutter() || props.theme.bg} width={1}>{gutter() ? "▌" : " "}</text>
      <box flexDirection="column" flexGrow={1} paddingRight={1}>
        <Show when={referenced()}>
          <text fg={theme().dim} wrapMode="none">{referenced()}</text>
        </Show>
        <Show when={!props.grouped}>
          <box flexDirection="row" width="100%" height={1}>
          <Show when={props.avatars}>
            <Avatar
              userId={props.message.authorId}
              name={author()}
              url={props.images ? userAvatarUrl(props.state, props.message.authorId, props.guildId, animate()) : null}
              theme={props.theme}
            />
            <text width={1}> </text>
          </Show>
          <text wrapMode="none" flexGrow={1}>
            <b>
              <span style={{ fg: authorColor(props.state, props.theme, props.message.authorId, props.guildId) }}>{author()}</span>
            </b>
            <Show when={props.state.users[props.message.authorId]?.bot}>
              <span style={{ fg: props.theme.modeFg, bg: props.theme.accent }}>{" BOT "}</span>
            </Show>
            <span style={{ fg: theme().dim }}>{`  ${clockTime(props.message.timestamp)}`}</span>
          </text>
          </box>
        </Show>
        <Show
          when={jumbo()}
          fallback={
            <Markdown
              nodes={nodes()}
              ctx={ctx()}
              suffix={props.message.editedTimestamp ? <span style={{ fg: theme().dim }}> (editado)</span> : undefined}
            />
          }
        >
          {(emoji: () => JumboEmoji[]) => <JumboRow emoji={emoji()} theme={props.theme} edited={props.message.editedTimestamp !== null} animate={animate()} />}
        </Show>
        <For each={props.message.attachments}>
          {(attachment) => {
            const view = attachmentView(attachment, props.images ? IMAGE_MODE : "links");
            const openIt = (e: Click): void => {
              e.stopPropagation();
              props.onOpen?.(attachment.url);
            };
            // Sobre una imagen: el primer click selecciona el mensaje (aparece ✎ editar / 🗑 borrar); el segundo la abre.
            const imageClick = (e: Click): void => {
              e.stopPropagation();
              if (!props.selected && props.onSelect) props.onSelect();
              else props.onOpen?.(attachment.url);
            };
            return view.kind === "image" ? (
              <box onMouseDown={imageClick}>
                <InlineImage url={view.url} cols={view.cols} rows={view.rows} label={view.label} theme={props.theme} animate={animate()} />
              </box>
            ) : (
              <text wrapMode="none" onMouseDown={openIt}>
                <a href={view.url} style={{ fg: theme().link }}>
                  {view.label}
                </a>
              </text>
            );
          }}
        </For>
        <For each={props.message.stickers ?? []}>
          {(sticker) => {
            const view = stickerView(sticker, props.images ? IMAGE_MODE : "links");
            return view.kind === "image" ? (
              <InlineImage url={view.url} cols={view.cols} rows={view.rows} label={view.label} theme={props.theme} raw animate={animate()} />
            ) : (
              <text fg={theme().dim} wrapMode="none">{view.label}</text>
            );
          }}
        </For>
        <Show when={props.message.poll}>
          {(poll: () => ApiPoll) => <PollBox poll={poll()} theme={props.theme} onVote={props.onVote} />}
        </Show>
        <For each={props.message.embeds.filter((embed) => embed.title || embed.description || embed.image || embed.thumbnail)}>
          {(embed) => <EmbedView embed={embed} ctx={ctx()} images={props.images === true} animate={animate()} onOpen={props.onOpen} />}
        </For>
        <Show when={props.message.reactions.length > 0}>
          <box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <For each={props.message.reactions}>
              {(reaction) => {
                const fg = (): string => (reaction.me ? theme().mentionFg : theme().fg);
                const bg = (): string => (reaction.me ? theme().mentionBg : theme().selection);
                const toggle = (e: Click): void => {
                  e.stopPropagation();
                  props.onReact?.({ id: reaction.emoji.id, name: reaction.emoji.name });
                };
                const id = reaction.emoji.id;
                // Emoji custom con imágenes: chip = fila de renderables (texto, imagen de 2x1, texto).
                return (
                  <Show
                    when={id && props.images}
                    fallback={
                      <text fg={fg()} bg={bg()} onMouseDown={toggle}>
                        {` ${id ? `:${reaction.emoji.name}:` : reaction.emoji.name} ${reaction.count} `}
                      </text>
                    }
                  >
                    <box flexDirection="row" backgroundColor={bg()} onMouseDown={toggle}>
                      <text fg={fg()} bg={bg()}>{" "}</text>
                      <InlineImage url={emojiUrl(id!, reaction.emoji.animated === true)} cols={2} rows={1} label={`:${reaction.emoji.name}:`} theme={props.theme} raw animate={animate()} />
                      <text fg={fg()} bg={bg()}>{` ${reaction.count} `}</text>
                    </box>
                  </Show>
                );
              }}
            </For>
          </box>
        </Show>
        <Show when={props.selected && props.onAction}>
          <box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={0}>
            <Button label="↩ responder" theme={props.theme} onPress={() => props.onAction?.("reply")} />
            <Show when={mine()}>
              <Button label="✎ editar" theme={props.theme} onPress={() => props.onAction?.("edit")} />
              <Button label="🗑 borrar" theme={props.theme} danger onPress={() => props.onAction?.("delete")} />
            </Show>
            <Button label="😀 reaccionar" theme={props.theme} onPress={() => props.onAction?.("react")} />
          </box>
        </Show>
      </box>
    </box>
  );
}
