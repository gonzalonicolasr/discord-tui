import type { APIAttachment, APIEmbed, APIMessage } from "discord-api-types/v9";

import type { GatewayStatus } from "../gateway/connection";
import type { Settings } from "../settings/settings";

export type ApiMessage = APIMessage;
export type ApiAttachment = APIAttachment;
export type ApiEmbed = APIEmbed;

/** `message.poll` (docs.discord.food, Messages → Poll Object). Todo opcional: viene de la red. */
export interface ApiPoll {
  question?: { text?: string };
  answers?: { answer_id?: number; poll_media?: { text?: string; emoji?: { id?: string | null; name?: string | null } } }[];
  expiry?: string | null;
  allow_multiselect?: boolean;
  results?: { is_finalized?: boolean; answer_counts?: { id: number; count: number; me_voted: boolean }[] };
}

/** `message.sticker_items[]`: format_type 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
export interface StickerItem {
  id: string;
  name: string;
  formatType: number;
}

export interface UserState {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  bot: boolean;
  /** Solo si no es "0" (sistema viejo de nombres, sobre todo bots): elige el avatar por defecto. */
  discriminator?: string;
}

export interface RoleState {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
}

export interface OverwriteState {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface ChannelState {
  id: string;
  guildId: string | null;
  name: string;
  type: number;
  position: number;
  parentId: string | null;
  permissionOverwrites: OverwriteState[];
  lastMessageId: string | null;
  /** DMs y grupos: quiénes están (sin uno mismo). */
  recipientIds?: string[];
  /** Grupos: nombre puesto a mano (si no, se arma con los participantes). */
  ownName?: string | null;
  /** Hilos (tipos 10, 11, 12): `parentId` es el canal de texto o foro donde está. */
  thread?: ThreadInfo;
}

export interface ThreadInfo {
  archived: boolean;
  locked: boolean;
  ownerId: string | null;
  messageCount: number | null;
  memberCount: number | null;
}

export interface GuildState {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  roles: RoleState[];
  emojis: { id: string; name: string; animated: boolean }[];
}

export interface MemberState {
  userId: string;
  guildId: string;
  roles: string[];
  nick: string | null;
  /** Avatar propio del server (`member.avatar`), si lo tiene. */
  avatar?: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  attachments: ApiAttachment[];
  embeds: ApiEmbed[];
  mentionIds: string[];
  mentionsMe: boolean;
  referenced: { id: string; authorId: string; content: string } | null;
  reactions: { emoji: { id: string | null; name: string; animated?: boolean }; count: number; me: boolean }[];
  nonce: string | null;
  poll?: ApiPoll | null;
  stickers?: StickerItem[];
}

export interface MessageSlice {
  ids: string[];
  byId: Record<string, ApiMessage>;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  /** No refleja el historial del servidor (sesión nueva o creado por un MESSAGE_CREATE): openChannel lo vuelve a pedir. */
  stale: boolean;
}

export interface ReadState {
  lastAckedId: string | null;
  mentionCount: number;
}

/** Dónde iba la lectura del canal abierto al abrirlo: el divisor "mensajes nuevos" va después de afterId. */
export interface UnreadMarker {
  channelId: string;
  afterId: string;
}

export interface PresenceState {
  status: string;
  activities: unknown[];
}

export type Focus = "guilds" | "channels" | "messages" | "members" | "composer";

export interface Notice {
  id: string;
  key: string;
  level: "info" | "warn" | "error";
  text: string;
  count: number;
  at: number;
}

export interface PendingAttachment {
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface OutboxItem {
  nonce: string;
  channelId: string;
  content: string;
  replyTo: string | null;
  attachments: PendingAttachment[];
  state: "pending" | "sent" | "failed";
  error: string | null;
  createdAt: number;
}

export type MemberListRow = { kind: "group"; id: string; count: number } | { kind: "member"; userId: string };

export type VoiceStatus = "idle" | "joining" | "connected" | "reconnecting" | "error";

export interface VoiceMemberState {
  channelId: string;
  mute: boolean;
  deaf: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo: boolean;
  selfStream: boolean;
}

export type StreamStatus = "idle" | "starting" | "live" | "error";

/** Go Live propio (una transmisión a la vez). */
export interface StreamState {
  status: StreamStatus;
  /** Monitor que se transmite (null = el predeterminado). */
  monitor: string | null;
  error: string | null;
  /** Cuántos miran (de STREAM_CREATE/STREAM_UPDATE `viewer_ids`), si Discord lo mandó. */
  viewers?: number;
  /** Quiénes miran (los `viewer_ids`, sin uno mismo). */
  viewerIds?: string[];
}

export type WatchStatus = "idle" | "connecting" | "watching" | "error";

/** Transmisión de otro que estás mirando (una a la vez; solo estando en su canal de voz). */
export interface WatchState {
  status: WatchStatus;
  /** Quién transmite. */
  userId: string | null;
  error: string | null;
}

export interface VoiceSlice {
  guildId: string | null;
  channelId: string | null;
  status: VoiceStatus;
  error: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  muteBeforeDeaf: boolean;
  selfSpeaking: boolean;
  speaking: Record<string, true>;
  /** guildId → userId → estado de voz (quién está en cada canal). */
  states: Record<string, Record<string, VoiceMemberState>>;
  privacyCode: string | null;
  /** Por dónde sale el audio de la llamada (descripción del dispositivo de PipeWire). */
  outputLabel?: string | null;
  pttWarning: string | null;
  micError: string | null;
  stream: StreamState;
  watch: WatchState;
}

export interface AppState {
  me: { id: string; username: string } | null;
  connection: GatewayStatus;
  guilds: Record<string, GuildState>;
  guildOrder: string[];
  channels: Record<string, ChannelState>;
  privateChannelIds: string[];
  users: Record<string, UserState>;
  members: Record<string, Record<string, MemberState>>;
  messages: Record<string, MessageSlice>;
  readState: Record<string, ReadState>;
  guildSettings: { mutedGuilds: string[]; mutedChannels: string[] };
  presences: Record<string, PresenceState>;
  /** channelId → userId → vence (ms epoch). */
  typing: Record<string, Record<string, number>>;
  /**
   * Lista de miembros por guild, como la manda GUILD_MEMBER_LIST_UPDATE (grupos y miembros en orden).
   * Los índices son las posiciones absolutas de Discord; `null` = posición sin cargar o invalidada.
   */
  memberLists: Record<string, (MemberListRow | null)[]>;
  /** `member_count` y `online_count` del último GUILD_MEMBER_LIST_UPDATE, por guild. */
  memberCounts: Record<string, { members: number; online: number; groups?: Record<string, number> }>;
  /** Último canal para el que se mandó op 37, por guild. */
  subscribedChannels: Record<string, string>;
  /** Rangos de la lista de miembros que se pidieron en el último op 37, por guild. */
  subscribedRanges: Record<string, [number, number][]>;
  voice: VoiceSlice;
  outbox: Record<string, OutboxItem>;
  ui: {
    selectedGuildId: string | "@dms" | null;
    selectedChannelId: string | null;
    focus: Focus;
    membersVisible: boolean;
    collapsedCategories: string[];
    unreadMarker: UnreadMarker | null;
  };
  settings: Settings;
  notices: Record<string, Notice>;
}

export type Action =
  | { type: "gw"; t: string; d: any }
  | { type: "connection"; status: GatewayStatus }
  | { type: "threads/loaded"; guildId: string; threads: unknown[] }
  /** `around`: la página alrededor de un mensaje (saltar a una mención); reemplaza el slice. */
  | { type: "messages/page"; channelId: string; messages: ApiMessage[]; mode: "older" | "latest" | "around" }
  | { type: "messages/loading"; channelId: string; loading: boolean }
  | { type: "messages/staleAll" }
  | { type: "ui/selectGuild"; id: string | "@dms" }
  | { type: "ui/selectChannel"; id: string }
  | { type: "ui/focus"; focus: Focus }
  | { type: "ui/toggleMembers" }
  | { type: "ui/toggleCategory"; id: string }
  | { type: "outbox/enqueue"; item: OutboxItem }
  | { type: "outbox/sent"; nonce: string; messageId: string }
  | { type: "outbox/failed"; nonce: string; error: string }
  | { type: "outbox/retry"; nonce: string }
  | { type: "settings/set"; patch: Partial<Settings> }
  | { type: "settings/loaded"; settings: Settings }
  | { type: "notice/push"; key: string; level: Notice["level"]; text: string }
  | { type: "notice/dismiss"; id: string }
  | { type: "notice/sweep"; now: number }
  | { type: "typing/sweep"; now: number }
  | { type: "members/subscribed"; guildId: string; channelId: string; ranges?: [number, number][] }
  /** Sesión nueva del gateway: las suscripciones de la anterior ya no existen. */
  | { type: "members/resetSubscriptions" }
  | { type: "voice/joining"; guildId: string; channelId: string }
  | { type: "voice/status"; status: VoiceStatus; error?: string | null }
  | { type: "voice/left"; error?: string | null }
  | { type: "voice/moved"; guildId: string; channelId: string }
  | { type: "voice/flags"; selfMute: boolean; selfDeaf: boolean; muteBeforeDeaf: boolean }
  | { type: "voice/selfSpeaking"; on: boolean }
  | { type: "voice/speaking"; userId: string; on: boolean }
  | { type: "voice/privacyCode"; code: string | null }
  | { type: "voice/pttWarning"; warning: string | null }
  | { type: "voice/micError"; error: string | null }
  | { type: "voice/outputLabel"; label: string | null }
  | { type: "voice/stream"; patch: Partial<StreamState> }
  | { type: "voice/watch"; patch: Partial<WatchState> };
