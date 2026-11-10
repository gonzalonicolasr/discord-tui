import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";

import type { Actions } from "../../actions";
import { AVATAR_COLS, userAvatarUrl } from "../../images/avatar";
import { selectVisibleChannelList, selectVoiceParticipants, type ChannelRow } from "../../store/selectors";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/types";
import { cellWidth, displayName, truncate } from "../format";
import { jsonEqual, useSelector } from "../store-bridge";
import { presenceColor, type Theme } from "../theme";
import { Avatar } from "./Avatar";
import { Button } from "./Button";

export const CHANNEL_WIDTH = 32;
const DOUBLE_CLICK_MS = 400;

function icon(kind: ChannelRow["kind"]): string {
  if (kind === "voice") return "🔊";
  if (kind === "dm") return "@";
  if (kind === "group_dm") return "👥";
  if (kind === "forum") return "💬";
  if (kind === "media") return "🖼";
  return "#";
}

/** Sangría e ícono: un hilo cuelga con └ debajo del # de su canal. */
function leadOf(row: ChannelRow): string {
  if (row.kind === "thread") return `${"  ".repeat(Math.max(0, row.depth - 1))}└ `;
  return `${"  ".repeat(row.depth)}${row.kind === "dm" ? "" : `${icon(row.kind)} `}`;
}

interface ParticipantView {
  userId: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  me: boolean;
  streaming: boolean;
  /** Está mirando tu transmisión. */
  watchingMe: boolean;
  volume: number;
  /** null = avatares apagados (setting `showAvatars`). */
  avatar: string | null;
}

interface ListView {
  collapsed: string[];
  title: string;
  rows: ChannelRow[];
  participants: Record<string, ParticipantView[]>;
  voiceChannelId: string | null;
  /** DM 1 a 1 → el otro (para el avatar), solo con `showAvatars`. */
  dmUsers: Record<string, { userId: string; avatar: string }>;
  /** A quién estás mirando (Go Live de otro), si mirás a alguien. */
  watching: string | null;
  /** El canal de voz donde estás conectado del todo (para mirar transmisiones hay que estar adentro). */
  connectedChannelId: string | null;
}

function listView(s: AppState): ListView {
  const selectedGuild = s.ui.selectedGuildId;
  const guildId = selectedGuild === null || selectedGuild === "@dms" ? null : selectedGuild;
  const rows = selectedGuild === null ? [] : selectVisibleChannelList(s, selectedGuild);
  const participants: Record<string, ParticipantView[]> = {};
  const avatars = s.settings.showAvatars;
  const animate = s.settings.animateImages;
  const dmUsers: ListView["dmUsers"] = {};
  if (avatars) {
    for (const row of rows) {
      const other = row.kind === "dm" ? s.channels[row.id]?.recipientIds?.[0] : undefined;
      if (other !== undefined) dmUsers[row.id] = { userId: other, avatar: userAvatarUrl(s, other, null, animate) };
    }
  }
  if (guildId !== null) {
    for (const row of rows) {
      if (row.kind !== "voice") continue;
      participants[row.id] = selectVoiceParticipants(s, guildId, row.id).map((p) => ({
        ...p,
        name: displayName(s, p.userId, guildId),
        volume: s.settings.userVolumes[p.userId] ?? 100,
        avatar: avatars ? userAvatarUrl(s, p.userId, guildId, animate) : null,
      }));
    }
  }
  const title =
    selectedGuild === "@dms"
      ? " Mensajes directos "
      : ` ${truncate((guildId ? s.guilds[guildId]?.name : null) ?? "Canales", CHANNEL_WIDTH - 6)} `;
  const connected = s.voice.status === "connected" ? s.voice.channelId : null;
  const watching = s.voice.watch.status === "idle" ? null : s.voice.watch.userId;
  return { title, rows, participants, voiceChannelId: s.voice.channelId, collapsed: s.ui.collapsedCategories, watching, connectedChannelId: connected, dmUsers };
}

export function ChannelList(props: {
  store: Store;
  actions: Actions;
  theme: Theme;
  focused?: boolean;
  selectedParticipant?: string | null;
  /** Click en un participante de voz (para el control de volumen). */
  onParticipant?(channelId: string, userId: string): void;
  onVolume?(userId: string, delta: number): void;
  /** Imágenes inline prendidas: los avatares se bajan; si no, queda la inicial. */
  images?: boolean;
  /** `▶ ver` / `■ dejar de ver` de alguien que transmite en tu canal. */
  onWatch?(userId: string): void;
}): JSX.Element {
  const [hovered, setHovered] = createSignal<string | null>(null);
  let lastClick: { id: string; at: number } | null = null;
  const view = useSelector(props.store, listView, jsonEqual);
  const selected = useSelector(props.store, (s) => s.ui.selectedChannelId);
  const rows = (): ChannelRow[] => view().rows;
  const title = (): string => view().title;
  const inner = CHANNEL_WIDTH - 2;
  let scroll: ScrollBoxRenderable | undefined;

  createEffect(
    on(selected, (id) => {
      try {
        if (id) scroll?.scrollChildIntoView(`chan-${id}`);
      } catch {
        // fuera del layout
      }
    }),
  );

  /** Como Discord: texto/DM abre el canal; 🔊 entra a voz; la categoría se colapsa. */
  function open(row: ChannelRow): void {
    if (row.kind === "category") {
      props.store.dispatch({ type: "ui/toggleCategory", id: row.id });
      return;
    }
    props.store.dispatch({ type: "ui/selectChannel", id: row.id });
    props.actions.focus("channels");
    if (row.kind === "voice") {
      // Click abre el chat del canal de voz sin entrar a la llamada; doble click (o 🎧) entra.
      const now = Date.now();
      const isDouble = lastClick?.id === row.id && now - lastClick.at < DOUBLE_CLICK_MS;
      lastClick = { id: row.id, at: now };
      if (isDouble) joinVoice(row.id);
      void props.actions.openChannel(row.id).catch(() => {});
      props.actions.focus("messages");
      return;
    }
    void props.actions.openChannel(row.id).catch(() => {});
    props.actions.focus("messages");
  }

  function joinVoice(id: string): void {
    if (view().voiceChannelId !== id) void props.actions.voice?.toggleVoice(id);
  }

  return (
    <box
      title={title()}
      titleColor={props.focused ? props.theme.borderFocus : props.theme.header}
      border
      borderStyle="rounded"
      borderColor={props.focused ? props.theme.borderFocus : props.theme.border}
      width={CHANNEL_WIDTH}
      height="100%"
      flexDirection="column"
    >
      <Show when={rows().length === 0}>
        <text fg={props.theme.dim}> (sin canales)</text>
      </Show>
      <scrollbox ref={(el: ScrollBoxRenderable) => (scroll = el)} width="100%" flexGrow={1}>
        <For each={rows()}>
          {(row) => {
            if (row.kind === "category") {
              const closed = (): boolean => view().collapsed.includes(row.id);
              return (
                <box
                  id={`chan-${row.id}`}
                  width="100%"
                  marginTop={1}
                  onMouseDown={() => open(row)}
                  onMouseOver={() => setHovered(row.id)}
                  onMouseOut={() => setHovered((h) => (h === row.id ? null : h))}
                >
                  <text
                    fg={hovered() === row.id ? props.theme.fg : props.theme.dim}
                    attributes={TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    {`${closed() ? "›" : "⌄"} ${truncate(row.name.toUpperCase(), inner - 2)}`}
                  </text>
                </box>
              );
            }
            const isSel = (): boolean => selected() === row.id;
            const badge = row.mentions > 0 ? ` ${row.mentions > 99 ? "99+" : row.mentions} ` : "";
            const lead = leadOf(row);
            const dmUser = view().dmUsers[row.id];
            // DM: "● " de presencia y, con avatares, el avatar y un espacio.
            const dmLead = row.kind === "dm" ? 2 + (dmUser ? AVATAR_COLS + 1 : 0) : 0;
            const name = truncate(row.name, inner - 1 - dmLead - cellWidth(lead) - cellWidth(badge));
            const bright = row.unread && !row.muted;
            const participants = (): ParticipantView[] => view().participants[row.id] ?? [];
            const connectedHere = (): boolean => view().voiceChannelId === row.id;
            return (
              <box flexDirection="column" width="100%">
                <box
                  id={`chan-${row.id}`}
                  flexDirection="row"
                  width="100%"
                  backgroundColor={isSel() ? props.theme.selection : hovered() === row.id ? props.theme.panel : undefined}
                  onMouseDown={() => open(row)}
                  onMouseOver={() => setHovered(row.id)}
                  onMouseOut={() => setHovered((h) => (h === row.id ? null : h))}
                >
                  <text fg={props.theme.accent}>{isSel() ? "▌" : " "}</text>
                  <Show when={row.kind === "dm"}>
                    <text fg={presenceColor(props.theme, row.status)}>{row.status === "offline" || !row.status ? "○ " : "● "}</text>
                  </Show>
                  <Show when={dmUser}>
                    <Avatar userId={dmUser!.userId} name={row.name} url={props.images ? dmUser!.avatar : null} theme={props.theme} />
                    <text width={1}> </text>
                  </Show>
                  <text
                    flexGrow={1}
                    wrapMode="none"
                    fg={
                      connectedHere()
                        ? props.theme.speaking
                        : isSel()
                          ? props.theme.selectionFg
                          : bright
                            ? props.theme.unread
                            : row.muted
                              ? props.theme.faint
                              : props.theme.dim
                    }
                    attributes={bright || isSel() ? TextAttributes.BOLD : 0}
                  >
                    {`${lead}${name}`}
                  </text>
                  <Show when={badge}>
                    <text fg={props.theme.modeFg} bg={props.theme.error} attributes={TextAttributes.BOLD}>
                      {badge}
                    </text>
                  </Show>
                  <Show when={row.kind === "voice" && !connectedHere() && (isSel() || hovered() === row.id)}>
                    <Button label="🎧" theme={props.theme} active onPress={() => joinVoice(row.id)} />
                  </Show>
                </box>
                <For each={participants()}>
                  {(p) => {
                    const chosen = (): boolean => props.selectedParticipant === p.userId && isSel();
                    return (
                      <box flexDirection="column" width="100%">
                        <box
                          flexDirection="row"
                          width="100%"
                          paddingLeft={row.depth * 2 + 3}
                          backgroundColor={chosen() ? props.theme.selection : hovered() === `p-${p.userId}` ? props.theme.panel : undefined}
                          onMouseDown={() => {
                            props.store.dispatch({ type: "ui/selectChannel", id: row.id });
                            props.actions.focus("channels");
                            props.onParticipant?.(row.id, p.userId);
                          }}
                          onMouseOver={() => setHovered(`p-${p.userId}`)}
                          onMouseOut={() => setHovered((h) => (h === `p-${p.userId}` ? null : h))}
                        >
                          <text fg={p.speaking ? props.theme.speaking : props.theme.faint}>{p.speaking ? "●" : "○"}</text>
                          <Show when={p.avatar !== null}>
                            <text width={1}> </text>
                            <Avatar userId={p.userId} name={p.name} url={props.images ? p.avatar : null} theme={props.theme} />
                          </Show>
                          {(() => {
                            // Íconos compactos como Discord: 🔇 mic apagado, 🙉 ensordecido, 📺 transmitiendo.
                            const badges = (): string =>
                              `${p.volume !== 100 ? ` ${p.volume}%` : ""}${p.watchingMe ? " 👁" : ""}${p.streaming ? " 📺" : ""}${p.deafened ? " 🙉" : p.muted ? " 🔇" : ""}`;
                            const room = (): number =>
                              Math.max(4, inner - row.depth * 2 - 5 - (p.avatar !== null ? AVATAR_COLS + 1 : 0) - cellWidth(badges()));
                            return (
                              <>
                                <text
                                  flexGrow={1}
                                  wrapMode="none"
                                  fg={p.speaking ? props.theme.speaking : p.me ? props.theme.fg : props.theme.dim}
                                >
                                  {` ${truncate(p.name, room())}`}
                                </text>
                                {/* Un <text> vacío igual ocupa una celda: solo se montan los que tienen algo. */}
                                <Show when={p.volume !== 100}>
                                  <text fg={props.theme.accent} wrapMode="none" flexShrink={0}>{` ${p.volume}%`}</text>
                                </Show>
                                <Show when={p.watchingMe}>
                                  <text fg={props.theme.accent} wrapMode="none" flexShrink={0}>{" 👁"}</text>
                                </Show>
                                <Show when={p.streaming}>
                                  <text fg={props.theme.error} wrapMode="none" flexShrink={0}>{" 📺"}</text>
                                </Show>
                                <Show when={p.deafened || p.muted}>
                                  <text fg={p.deafened ? props.theme.error : props.theme.warn} wrapMode="none" flexShrink={0}>
                                    {p.deafened ? " 🙉" : " 🔇"}
                                  </text>
                                </Show>
                              </>
                            );
                          })()}
                        </box>
                        <Show when={p.streaming && !p.me && view().connectedChannelId === row.id && props.onWatch}>
                          <box flexDirection="row" width="100%" paddingLeft={row.depth * 2 + 5}>
                            <Button
                              label={view().watching === p.userId ? "■ dejar de ver" : "▶ ver"}
                              theme={props.theme}
                              active={view().watching !== p.userId}
                              danger={view().watching === p.userId}
                              onPress={() => props.onWatch?.(p.userId)}
                            />
                          </box>
                        </Show>
                        <Show when={chosen() && !p.me}>
                          <box flexDirection="row" width="100%" paddingLeft={row.depth * 2 + 5}>
                            <text fg={props.theme.dim}>vol </text>
                            <text
                              fg={props.theme.modeFg}
                              bg={props.theme.accent}
                              onMouseDown={(e: { stopPropagation(): void }) => {
                                e.stopPropagation();
                                props.onVolume?.(p.userId, -10);
                              }}
                            >
                              {" − "}
                            </text>
                            <text fg={props.theme.fg}>{` ${String(p.volume).padStart(3)} % `}</text>
                            <text
                              fg={props.theme.modeFg}
                              bg={props.theme.accent}
                              onMouseDown={(e: { stopPropagation(): void }) => {
                                e.stopPropagation();
                                props.onVolume?.(p.userId, 10);
                              }}
                            >
                              {" + "}
                            </text>
                          </box>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </box>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}
