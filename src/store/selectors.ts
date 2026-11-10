import { compareSnowflakes } from "../util/snowflake";
import { canViewChannel } from "./permissions";
import { toMessage } from "./reducers/messages";
import { privateChannelName } from "./reducers/ready";
import type { ApiMessage, AppState, ChannelState, Message } from "./types";

export interface ChannelRow {
  id: string;
  name: string;
  kind: "text" | "voice" | "category" | "dm" | "group_dm" | "thread" | "forum" | "media";
  unread: boolean;
  mentions: number;
  muted: boolean;
  /** 2: hilo de un canal que está dentro de una categoría. */
  depth: 0 | 1 | 2;
  /** DM 1 a 1: presencia del otro. */
  status?: string;
}

export interface GuildRow {
  id: string;
  name: string;
  unread: boolean;
  mentions: number;
}

const TEXT_TYPES = new Set([0, 5]);
const VOICE_TYPES = new Set([2]);
export const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
/** Foros (15) y canales de medios (16): no tienen mensajes propios, solo posts (hilos). */
export const FORUM_TYPES = new Set([15, 16]);

/** Canales donde se leen y escriben mensajes: texto, DMs, hilos y el chat de los canales de voz (como Discord). */
export function isMessageChannelType(type: number | undefined): boolean {
  return type !== undefined && type !== 4 && !FORUM_TYPES.has(type);
}

function kindOf(channel: ChannelState): ChannelRow["kind"] | null {
  if (TEXT_TYPES.has(channel.type)) return "text";
  if (VOICE_TYPES.has(channel.type)) return "voice";
  if (THREAD_CHANNEL_TYPES.has(channel.type)) return "thread";
  if (channel.type === 15) return "forum";
  if (channel.type === 16) return "media";
  if (channel.type === 4) return "category";
  if (channel.type === 1) return "dm";
  if (channel.type === 3) return "group_dm";
  return null;
}

export function isChannelUnread(state: AppState, channelId: string): boolean {
  const channel = state.channels[channelId];
  if (!channel || channel.lastMessageId === null) return false;
  const read = state.readState[channelId];
  // Hilos: como Discord, solo cuentan los que seguís (los que tienen read state).
  if (channel.thread !== undefined && !read) return false;
  if (!read?.lastAckedId) return true;
  return compareSnowflakes(channel.lastMessageId, read.lastAckedId) > 0;
}

export function isChannelMuted(state: AppState, guildId: string | null, channelId: string): boolean {
  if (state.guildSettings.mutedChannels.includes(channelId)) return true;
  const channel = state.channels[channelId];
  if (channel?.thread !== undefined && channel.parentId !== null && state.guildSettings.mutedChannels.includes(channel.parentId)) return true;
  return guildId !== null && state.guildSettings.mutedGuilds.includes(guildId);
}

function toRow(state: AppState, channel: ChannelState, depth: ChannelRow["depth"]): ChannelRow {
  const kind = kindOf(channel);
  const isPrivate = channel.guildId === null && channel.recipientIds !== undefined;
  const other = channel.type === 1 ? channel.recipientIds?.[0] : undefined;
  return {
    id: channel.id,
    name: isPrivate ? privateChannelName(state.users, channel.recipientIds ?? [], channel.type, channel.ownName ?? null) : channel.name,
    ...(other !== undefined ? { status: state.presences[other]?.status ?? "offline" } : {}),
    kind: kind ?? "text",
    unread: isChannelUnread(state, channel.id),
    mentions: state.readState[channel.id]?.mentionCount ?? 0,
    muted: isChannelMuted(state, channel.guildId, channel.id),
    depth,
  };
}

function byPosition(a: ChannelState, b: ChannelState): number {
  return a.position - b.position || compareSnowflakes(a.id, b.id);
}

/** Actividad más reciente primero (último mensaje, o la creación si no tiene). */
function byActivity(a: ChannelState, b: ChannelState): number {
  return compareSnowflakes(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id);
}

export function isThread(channel: ChannelState | undefined): boolean {
  return channel !== undefined && channel.thread !== undefined && THREAD_CHANNEL_TYPES.has(channel.type);
}

/** Hilos activos (no archivados) de un canal, el de actividad más reciente primero. */
export function selectActiveThreads(state: AppState, parentId: string): ChannelState[] {
  return Object.values(state.channels)
    .filter((channel) => isThread(channel) && channel.parentId === parentId && !channel.thread!.archived)
    .sort(byActivity);
}

export interface ForumPostRow {
  id: string;
  name: string;
  archived: boolean;
  locked: boolean;
  messageCount: number | null;
  unread: boolean;
}

/** Posts de un foro: los activos y después los archivados que se pidieron, cada grupo por actividad. */
export function selectForumPosts(state: AppState, forumId: string): ForumPostRow[] {
  const posts = Object.values(state.channels).filter((channel) => isThread(channel) && channel.parentId === forumId);
  const active = posts.filter((post) => !post.thread!.archived).sort(byActivity);
  const archived = posts.filter((post) => post.thread!.archived).sort(byActivity);
  return [...active, ...archived].map((post) => ({
    id: post.id,
    name: post.name,
    archived: post.thread!.archived,
    locked: post.thread!.locked,
    messageCount: post.thread!.messageCount,
    unread: isChannelUnread(state, post.id),
  }));
}

export function selectChannelList(state: AppState, guildId: string | "@dms"): ChannelRow[] {
  if (guildId === "@dms") {
    // Como Discord: el que tuvo actividad más reciente arriba.
    const activity = (channel: ChannelState): string => channel.lastMessageId ?? channel.id;
    return state.privateChannelIds
      .map((id) => state.channels[id])
      .filter((channel): channel is ChannelState => channel !== undefined)
      .sort((a, b) => compareSnowflakes(activity(b), activity(a)))
      .map((channel) => toRow(state, channel, 0));
  }

  const visible = Object.values(state.channels).filter(
    (channel) =>
      channel.guildId === guildId &&
      !isThread(channel) &&
      canViewChannel(state, guildId, channel.id) &&
      kindOf(channel) !== null,
  );
  // Los hilos activos van debajo de su canal de texto (los de un foro se ven al abrir el foro).
  const withThreads = (channel: ChannelState, depth: 0 | 1): void => {
    if (!TEXT_TYPES.has(channel.type)) return;
    for (const thread of selectActiveThreads(state, channel.id)) rows.push(toRow(state, thread, depth === 0 ? 1 : 2));
  };

  const categories = visible.filter((channel) => channel.type === 4).sort(byPosition);
  const rows: ChannelRow[] = [];
  const placed = new Set<string>();

  for (const category of categories) {
    rows.push(toRow(state, category, 0));
    placed.add(category.id);
    const children = visible.filter((channel) => channel.type !== 4 && channel.parentId === category.id).sort(byPosition);
    for (const child of children) {
      rows.push(toRow(state, child, 1));
      placed.add(child.id);
      withThreads(child, 1);
    }
  }

  for (const channel of visible.filter((candidate) => candidate.type !== 4 && !placed.has(candidate.id)).sort(byPosition)) {
    rows.push(toRow(state, channel, 0));
    withThreads(channel, 0);
  }

  return rows;
}

/** Lista de canales sin los hijos de las categorías colapsadas (la categoría queda visible). */
export function selectVisibleChannelList(state: AppState, guildId: string | "@dms"): ChannelRow[] {
  const collapsed = new Set(state.ui.collapsedCategories);
  if (collapsed.size === 0) return selectChannelList(state, guildId);
  return selectChannelList(state, guildId).filter((row) => {
    if (row.kind === "category" || row.depth === 0) return true;
    let parent = state.channels[row.id]?.parentId;
    // Un hilo se colapsa con la categoría de su canal.
    if (row.kind === "thread" && parent != null) parent = state.channels[parent]?.parentId;
    return parent == null || !collapsed.has(parent);
  });
}

export function selectGuildList(state: AppState): GuildRow[] {
  return state.guildOrder.map((id) => {
    const guild = state.guilds[id];
    const rows = selectChannelList(state, id);
    return {
      id,
      name: guild?.name ?? id,
      unread: rows.some((row) => row.unread),
      mentions: rows.reduce((total, row) => total + row.mentions, 0),
    };
  });
}

export function selectNextUnread(state: AppState, fromChannelId: string | null): string | null {
  const groups: Array<string | "@dms"> = [...state.guildOrder, "@dms"];
  const rows = groups.flatMap((guildId) => selectChannelList(state, guildId));
  if (rows.length === 0) return null;

  const start = fromChannelId === null ? -1 : rows.findIndex((row) => row.id === fromChannelId);
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const row = rows[(start + offset + rows.length) % rows.length]!;
    if (row.unread && !row.muted) return row.id;
  }
  return null;
}

export function selectMessages(state: AppState, channelId: string): Message[] {
  const slice = state.messages[channelId];
  if (!slice) return [];
  return slice.ids
    .map((id) => slice.byId[id])
    .filter((message): message is ApiMessage => message !== undefined)
    .map((message) => toMessage(state, message));
}

export function selectOutbox(state: AppState, channelId: string): import("./types").OutboxItem[] {
  return Object.values(state.outbox)
    .filter((item) => item.channelId === channelId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Quiénes están escribiendo en el canal (sin uno mismo ni vencidos). */
export function selectTyping(state: AppState, channelId: string, now: number): string[] {
  const entries = state.typing[channelId];
  if (!entries) return [];
  return Object.entries(entries)
    .filter(([userId, until]) => until > now && userId !== state.me?.id)
    .map(([userId]) => userId);
}

export interface VoiceParticipant {
  userId: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  me: boolean;
  /** Está transmitiendo pantalla (Go Live): `self_stream` de su VOICE_STATE_UPDATE, o el stream propio en vivo. */
  streaming: boolean;
  /** Está mirando tu transmisión. */
  watchingMe: boolean;
}

/** Participantes de un canal de voz, con quién habla (uno mismo incluido). */
export function selectVoiceParticipants(state: AppState, guildId: string, channelId: string): VoiceParticipant[] {
  const states = state.voice.states[guildId] ?? {};
  const meId = state.me?.id ?? null;
  const live = state.voice.stream.status === "live" && state.voice.channelId === channelId;
  const viewers = new Set(live ? state.voice.stream.viewerIds ?? [] : []);
  return Object.entries(states)
    .filter(([, voice]) => voice.channelId === channelId)
    .map(([userId, voice]) => {
      const me = userId === meId;
      return {
        userId,
        me,
        speaking: me ? state.voice.selfSpeaking && state.voice.channelId === channelId : state.voice.speaking[userId] === true,
        muted: voice.selfMute || voice.mute,
        deafened: voice.selfDeaf || voice.deaf,
        streaming: voice.selfStream || (me && state.voice.channelId === channelId && state.voice.stream.status === "live"),
        watchingMe: viewers.has(userId),
      };
    })
    .sort((a, b) => compareSnowflakes(a.userId, b.userId));
}

export type MemberRow =
  | { kind: "group"; label: string; count: number }
  | { kind: "member"; userId: string; status: string };

const GROUP_LABELS: Record<string, string> = { online: "En línea", offline: "Desconectados" };

/** Filas de la lista de miembros del guild: la que mandó op 37 o, si no llegó, los miembros conocidos. */
export function selectMemberRows(state: AppState, guildId: string): MemberRow[] {
  const list = state.memberLists[guildId];
  const statusOf = (userId: string): string => state.presences[userId]?.status ?? "offline";
  if (list && list.length > 0) {
    const roles = state.guilds[guildId]?.roles ?? [];
    // Solo lo cargado; una fila vieja de un rango que ya no está suscripto puede repetir a alguien.
    const seen = new Set<string>();
    const rows: MemberRow[] = [];
    for (const row of list) {
      if (row === null) continue;
      if (row.kind === "group") {
        const count = state.memberCounts[guildId]?.groups?.[row.id] ?? row.count;
        rows.push({ kind: "group", label: GROUP_LABELS[row.id] ?? roles.find((role) => role.id === row.id)?.name ?? row.id, count });
      } else if (!seen.has(row.userId)) {
        seen.add(row.userId);
        rows.push({ kind: "member", userId: row.userId, status: statusOf(row.userId) });
      }
    }
    return rows;
  }
  const members = Object.keys(state.members[guildId] ?? {});
  const online = members.filter((id) => statusOf(id) !== "offline");
  const offline = members.filter((id) => statusOf(id) === "offline");
  const rows: MemberRow[] = [];
  if (online.length > 0) rows.push({ kind: "group", label: "En línea", count: online.length });
  for (const id of online) rows.push({ kind: "member", userId: id, status: statusOf(id) });
  if (offline.length > 0) rows.push({ kind: "group", label: "Desconectados", count: offline.length });
  for (const id of offline) rows.push({ kind: "member", userId: id, status: "offline" });
  return rows;
}

/** Panel de miembros en un DM o grupo: los participantes y uno mismo, con presencia. */
export function selectDmMemberRows(state: AppState, channelId: string): MemberRow[] {
  const channel = state.channels[channelId];
  if (!channel || channel.guildId !== null) return [];
  const ids = [...(channel.recipientIds ?? []), ...(state.me ? [state.me.id] : [])];
  const statusOf = (id: string): string => state.presences[id]?.status ?? (id === state.me?.id ? "online" : "offline");
  return [
    { kind: "group", label: channel.type === 3 ? "Miembros" : "En este chat", count: ids.length },
    ...ids.map((userId) => ({ kind: "member" as const, userId, status: statusOf(userId) })),
  ];
}

/** Quiénes transmiten (📺) en TU canal de voz, sin vos: los que se pueden mirar. */
export function selectWatchableStreamers(state: AppState): string[] {
  const v = state.voice;
  if (v.guildId === null || v.channelId === null || v.status !== "connected") return [];
  const meId = state.me?.id ?? null;
  return Object.entries(v.states[v.guildId] ?? {})
    .filter(([userId, s]) => userId !== meId && s.channelId === v.channelId && s.selfStream)
    .map(([userId]) => userId)
    .sort(compareSnowflakes);
}
