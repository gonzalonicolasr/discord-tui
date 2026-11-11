import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";

import { toMessage } from "../../store/reducers/messages";
import { privateChannelName } from "../../store/reducers/ready";
import { FORUM_TYPES, isMessageChannelType, selectOutbox, selectTyping, selectWatchableStreamers } from "../../store/selectors";
import type { Store } from "../../store/store";
import type { AppState, Message, OutboxItem } from "../../store/types";
import { selectUnreadView, unreadSince } from "../../store/unread";
import { compareSnowflakes } from "../../util/snowflake";
import { dayLabel, displayName, sameDay, truncate, typingText } from "../format";
import { jsonEqual, shallowEqual, useSelector } from "../store-bridge";
import type { Theme } from "../theme";
import { Button } from "./Button";
import { ForumView } from "./ForumView";
import { MessageItem, type MessageAction } from "./MessageItem";

const GROUP_WINDOW_MS = 7 * 60_000;

export function channelTitle(state: AppState): string {
  const id = state.ui.selectedChannelId;
  const channel = id ? state.channels[id] : undefined;
  if (!channel) return "Mensajes";
  if (channel.guildId === null) {
    const name = privateChannelName(state.users, channel.recipientIds ?? [], channel.type, channel.ownName ?? null);
    if (channel.type === 3) return `👥 ${name} · ${(channel.recipientIds?.length ?? 0) + 1} personas`;
    return `@ ${name}`;
  }
  const guild = state.guilds[channel.guildId]?.name;
  if (channel.thread !== undefined) {
    const parent = channel.parentId ? state.channels[channel.parentId] : undefined;
    const where = parent ? `${FORUM_TYPES.has(parent.type) ? "💬" : "#"}${parent.name}` : "hilo";
    const flags = `${channel.thread.locked ? " 🔒" : ""}${channel.thread.archived ? " (archivado)" : ""}`;
    return `🧵 ${channel.name}${flags} · ${where}`;
  }
  const icon = channel.type === 2 ? "🔊" : channel.type === 15 ? "💬" : channel.type === 16 ? "🖼" : "#";
  return `${icon} ${channel.name}${guild ? `  ·  ${guild}` : ""}`;
}

export function MessageView(props: {
  store: Store;
  theme: Theme;
  selectedId?: string | null;
  focused?: boolean;
  images?: boolean;
  /** Animar GIFs y emojis animados (setting `animateImages`). */
  animate?: boolean;
  /** Avatares en los encabezados (setting `showAvatars`). */
  avatars?: boolean;
  onSelect?(messageId: string): void;
  onAction?(action: MessageAction, messageId: string): void;
  onReact?(messageId: string, emoji: { id: string | null; name: string }): void;
  onReactionHover?(messageId: string, emoji: { id: string | null; name: string; label: string; count: number } | null): void;
  onOpen?(url: string): void;
  onVote?(messageId: string, answerId: number): void;
  onLoadOlder?(): void;
  onFocus?(): void;
  onVoiceToggle?(channelId: string): void;
  /** `▶ ver <nombre>`: mirar la transmisión de alguien de tu canal de voz. */
  onWatch?(userId: string): void;
  /** Barra "↑ N+ mensajes nuevos": cargar hasta el primero sin leer y saltar ahí. */
  onJumpUnread?(): void;
  /** Chip "↓ ir al final": soltar la selección (la vista baja sola). */
  onJumpBottom?(): void;
  /** Cada vez que cambia, la vista baja al final (Esc, G). */
  bottomTick?: number;
  onOpenPost?(postId: string): void;
  onLoadArchived?(forumId: string): void;
  /** Ancho que entra en el borde de arriba (si el título no entra, OpenTUI no lo muestra). */
  titleWidth?: number;
}): JSX.Element {
  const voiceHere = useSelector(props.store, (s) => s.voice.channelId !== null && s.voice.channelId === s.ui.selectedChannelId);
  const voiceCount = useSelector(props.store, (s) => {
    const id = s.ui.selectedChannelId;
    const channel = id ? s.channels[id] : undefined;
    if (!channel || channel.type !== 2 || !channel.guildId) return 0;
    return Object.values(s.voice.states[channel.guildId] ?? {}).filter((v) => v.channelId === id).length;
  });
  // Quiénes transmiten en este canal de voz, si estás adentro (para `▶ ver`).
  const streamers = useSelector(
    props.store,
    (s) =>
      s.voice.channelId !== null && s.voice.channelId === s.ui.selectedChannelId
        ? selectWatchableStreamers(s).slice(0, 3).map((id) => ({ id, name: displayName(s, id, s.voice.guildId) }))
        : [],
    jsonEqual,
  );
  const watchButtons = (): JSX.Element => (
    <For each={props.onWatch ? streamers() : []}>
      {(st) => <Button label={`▶ ver ${truncate(st.name, 16)}`} theme={props.theme} active onPress={() => props.onWatch?.(st.id)} />}
    </For>
  );
  // Solo lo que la vista usa: las ráfagas de presencia, typing o voz no re-renderizan los mensajes.
  const view = useSelector(
    props.store,
    (s) => {
      const id = s.ui.selectedChannelId;
      return { channelId: id, slice: id ? s.messages[id] : undefined, channels: s.channels, outbox: s.outbox, me: s.me };
    },
    shallowEqual,
  );
  // Nombres, roles y canales para resolver menciones: cambian poco, y un mensaje nuevo no los toca.
  const names = useSelector(
    props.store,
    (s) => ({ users: s.users, members: s.members, guilds: s.guilds, channels: s.channels, me: s.me }),
    shallowEqual,
  );
  const state = (): AppState => names() as unknown as AppState;
  const channelId = (): string | null => view().channelId;
  const slice = () => view().slice;
  const messages = createMemo((): Message[] => {
    const current = slice();
    if (!current) return [];
    const me = { me: view().me } as AppState;
    return current.ids
      .map((id) => current.byId[id])
      .filter((raw) => raw !== undefined)
      .map((raw) => toMessage(me, raw!));
  });
  const outbox = (): OutboxItem[] =>
    channelId() === null ? [] : selectOutbox(view() as unknown as AppState, channelId()!);
  const guildId = (): string | null => (channelId() ? view().channels[channelId()!]?.guildId ?? null : null);
  const typing = useSelector(
    props.store,
    (s) => {
      const id = s.ui.selectedChannelId;
      if (id === null) return null;
      const guild = s.channels[id]?.guildId ?? null;
      return typingText(selectTyping(s, id, Date.now()).map((userId) => displayName(s, userId, guild)));
    },
    jsonEqual,
  );

  const title = useSelector(props.store, channelTitle);
  // Dónde iba la lectura al abrir el canal (spec: divisor "mensajes nuevos", como Discord).
  const unread = useSelector(props.store, (s) => selectUnreadView(s, s.ui.selectedChannelId), jsonEqual);
  let scroll: ScrollBoxRenderable | undefined;
  const live = (): ScrollBoxRenderable | undefined => (scroll && !scroll.isDestroyed ? scroll : undefined);

  // "↓ ir al final": aparece si estás lejos del final y llegaron mensajes que no viste.
  const [atBottom, setAtBottom] = createSignal(true);
  const [seenNewest, setSeenNewest] = createSignal<string | null>(null);
  const newest = (): string | null => slice()?.ids.at(-1) ?? null;
  const away = (): boolean => (props.selectedId ?? null) !== null || !atBottom();
  createEffect(() => {
    const id = newest();
    if (!away()) setSeenNewest(id);
  });
  const showBottomChip = (): boolean => {
    const id = newest();
    const seen = seenNewest();
    return away() && id !== null && seen !== null && compareSnowflakes(id, seen) > 0;
  };

  function measureBottom(): void {
    const el = live();
    if (!el) return;
    const state = el._scrollState();
    const bottom = state.offset[1] >= state.max[1];
    setAtBottom(bottom);
    if (bottom && (props.selectedId ?? null) === null) el.stickyScroll = true;
  }

  function scrollToBottom(): void {
    const el = live();
    if (!el) return;
    el.stickyScroll = true;
    el.scrollTo(Infinity);
    setAtBottom(true);
  }

  createEffect(
    on(
      () => props.selectedId,
      (id) => {
        const el = live();
        if (!el) return;
        if (id) {
          el.stickyScroll = false;
          try {
            el.scrollChildIntoView(`msg-${id}`);
          } catch {
            // todavía no está en el layout
          }
        } else {
          scrollToBottom();
        }
      },
    ),
  );

  createEffect(on(() => props.bottomTick, () => scrollToBottom(), { defer: true }));

  // Al abrir un canal (y cuando llegan sus mensajes): al final, o al primer no leído si queda arriba.
  let positionedFor: string | null = null;
  createEffect(
    on([channelId, () => slice() !== undefined], ([id, loaded]) => {
      const el = live();
      if (!el || id === null || positionedFor === id) return;
      scrollToBottom();
      if (!loaded) return;
      positionedFor = id;
      // Del store y no de las señales: en este punto alguna puede no haberse enterado todavía.
      const state = props.store.getState();
      setSeenNewest(state.messages[id]?.ids.at(-1) ?? null);
      if (selectUnreadView(state, id).firstUnreadId === null) return;
      el.stickyScroll = false;
      // Después del layout: recién ahí el divisor existe y tiene posición.
      el.afterLayout(() => {
        if (el.isDestroyed || channelId() !== id) return;
        el.scrollChildIntoView("unread-divider", { align: "start" });
        el.afterLayout(measureBottom);
      });
    }),
  );

  const isGrouped = (message: Message, index: number): boolean => {
    if (index === 0 || message.id === unread().firstUnreadId) return false;
    const previous = messages()[index - 1];
    if (!previous || previous.authorId !== message.authorId || message.referenced !== null) return false;
    if (!sameDay(previous.timestamp, message.timestamp)) return false;
    return Math.abs(new Date(message.timestamp).getTime() - new Date(previous.timestamp).getTime()) < GROUP_WINDOW_MS;
  };

  const daySeparator = (message: Message, index: number): string | null => {
    const previous = index === 0 ? null : messages()[index - 1];
    if (previous && sameDay(previous.timestamp, message.timestamp)) return null;
    return dayLabel(message.timestamp);
  };

  const isText = (): boolean => {
    const type = channelId() ? view().channels[channelId()!]?.type : undefined;
    return type === undefined || isMessageChannelType(type);
  };
  const isVoiceChannel = (): boolean => (channelId() ? view().channels[channelId()!]?.type === 2 : false);
  const isForum = (): boolean => {
    const type = channelId() ? view().channels[channelId()!]?.type : undefined;
    return type !== undefined && FORUM_TYPES.has(type);
  };

  return (
    <box
      title={` ${truncate(title(), props.titleWidth ?? 60)} `}
      titleColor={props.focused ? props.theme.borderFocus : props.theme.header}
      border
      borderStyle="rounded"
      borderColor={props.focused ? props.theme.borderFocus : props.theme.border}
      flexGrow={1}
      height="100%"
      flexDirection="column"
      onMouseDown={() => props.onFocus?.()}
    >
      <Show
        when={channelId() !== null && isText()}
        fallback={
          <Show
            when={!isForum()}
            fallback={
              <ForumView
                store={props.store}
                theme={props.theme}
                forumId={channelId()!}
                selectedId={props.selectedId}
                onOpenPost={(id) => props.onOpenPost?.(id)}
                onLoadArchived={(id) => props.onLoadArchived?.(id)}
              />
            }
          >
          <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column" rowGap={1}>
            <Show
              when={channelId() !== null}
              fallback={<text fg={props.theme.dim}>Elegí un canal con el mouse, con j/k y l, o con Ctrl-k</text>}
            >
              <text fg={props.theme.header}>{`🔊 ${view().channels[channelId()!]?.name ?? "voz"}`}</text>
              <text fg={props.theme.dim}>
                {voiceCount() === 0 ? "no hay nadie todavía" : `${voiceCount()} ${voiceCount() === 1 ? "persona" : "personas"} en el canal`}
              </text>
              <Button
                label={voiceHere() ? "✕ Salir de la llamada" : "🔊 Entrar a voz"}
                theme={props.theme}
                danger={voiceHere()}
                active={!voiceHere()}
                onPress={() => props.onVoiceToggle?.(channelId()!)}
              />
              <text fg={props.theme.faint}>o apretá v</text>
              <box flexDirection="row" columnGap={1}>{watchButtons()}</box>
            </Show>
          </box>
          </Show>
        }
      >
        <Show when={isVoiceChannel()}>
          <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={props.theme.panel} columnGap={1}>
            <text fg={voiceHere() ? props.theme.speaking : props.theme.header} wrapMode="none" flexShrink={0}>
              {`🔊 ${voiceHere() ? "estás en la llamada" : "llamada de voz"}`}
            </text>
            <text fg={props.theme.dim} wrapMode="none" flexGrow={1}>
              {voiceCount() === 0 ? "· no hay nadie" : `· ${voiceCount()} ${voiceCount() === 1 ? "persona" : "personas"}`}
            </text>
            {watchButtons()}
            <Button
              label={voiceHere() ? "✕ Salir de la llamada" : "🔊 Entrar a voz"}
              theme={props.theme}
              danger={voiceHere()}
              active={!voiceHere()}
              onPress={() => props.onVoiceToggle?.(channelId()!)}
            />
          </box>
        </Show>
        <Show when={unread().missing}>
          <box width="100%" paddingLeft={1} flexShrink={0} onMouseDown={() => props.onJumpUnread?.()}>
            <text fg={props.theme.error} wrapMode="word">
              {`↑ ${unread().count}+ mensajes nuevos${unreadSince(unread().afterId ?? "0")} · click o gn para saltar`}
            </text>
          </box>
        </Show>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => {
            scroll = el;
            el.verticalScrollBar.on("change", measureBottom);
          }}
          width="100%"
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          onMouseScroll={(e: { scroll?: { direction: string } }) => {
            // Con la rueda arriba de todo, como Discord, se piden los mensajes anteriores.
            if (e.scroll?.direction === "up" && (scroll?.scrollTop ?? 1) <= 0) props.onLoadOlder?.();
          }}
        >
          <Show when={slice()?.loadingOlder}>
            <text fg={props.theme.dim}>  cargando mensajes anteriores…</text>
          </Show>
          <Show when={slice() && !slice()!.hasMoreBefore && messages().length > 0}>
            <text fg={props.theme.dim}>  ── principio del canal ──</text>
          </Show>
          <Show when={slice() === undefined}>
            <text fg={props.theme.dim}>  cargando…</text>
          </Show>
          <Show when={slice() !== undefined && messages().length === 0 && !slice()!.loadingOlder}>
            <text fg={props.theme.dim}>  todavía no hay mensajes acá · i para escribir el primero</text>
          </Show>
          <For each={messages()}>
            {(message, index) => (
              <>
                <Show when={daySeparator(message, index())}>
                  <box width="100%" justifyContent="center" flexDirection="row" marginTop={1}>
                    <text fg={props.theme.dim}>{`──── ${daySeparator(message, index())} ────`}</text>
                  </box>
                </Show>
                <Show when={unread().firstUnreadId === message.id}>
                  <box id="unread-divider" width="100%" justifyContent="center" flexDirection="row" marginTop={1}>
                    <text fg={props.theme.error}>──── mensajes nuevos ────</text>
                  </box>
                </Show>
                <MessageItem
                  message={message}
                  state={state()}
                  theme={props.theme}
                  guildId={guildId()}
                  grouped={isGrouped(message, index())}
                  selected={props.selectedId === message.id}
                  images={props.images}
                  animate={props.animate}
                  avatars={props.avatars}
                  onSelect={() => props.onSelect?.(message.id)}
                  onAction={props.onAction ? (action) => props.onAction?.(action, message.id) : undefined}
                  onReact={(emoji) => props.onReact?.(message.id, emoji)}
                  onReactionHover={(emoji) => props.onReactionHover?.(message.id, emoji)}
                  onOpen={(url) => props.onOpen?.(url)}
                  onVote={(answerId) => props.onVote?.(message.id, answerId)}
                />
              </>
            )}
          </For>
          <For each={outbox()}>
            {(item) => (
              <box flexDirection="row" paddingLeft={1} marginTop={1}>
                <text wrapMode="word" fg={item.state === "failed" ? props.theme.error : props.theme.dim}>
                  {item.state === "failed"
                    ? `✗ no se envió (${item.error ?? "error"}) · R reintenta: ${truncate(item.content, 60)}`
                    : `◌ enviando… ${truncate(item.content, 60)}`}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <Show when={showBottomChip()}>
          <box height={1} width="100%" flexShrink={0} flexDirection="row" justifyContent="flex-end" paddingRight={1}>
            <Button
              label="↓ ir al final"
              theme={props.theme}
              active
              onPress={() => {
                scrollToBottom();
                props.onJumpBottom?.();
              }}
            />
          </box>
        </Show>
      </Show>
      <box height={1} width="100%" paddingLeft={1}>
        <text fg={props.theme.dim} wrapMode="none">{typing() ?? ""}</text>
      </box>
    </box>
  );
}
