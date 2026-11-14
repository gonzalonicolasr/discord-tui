import { isThreadPayload, toThread } from "./threads";
import type { AppState, ChannelState, GuildState, MemberState, OverwriteState, PresenceState, RoleState, UserState } from "../types";


function asList(value: unknown, idKey: string): any[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        return { [idKey]: key, ...(entry as Record<string, unknown>) };
      }
      return { [idKey]: key };
    });
  }
  return [];
}

/**
 * Desenvuelve una `versioned structure` (`{ entries, partial, version }`) que Discord manda cuando las
 * capabilities `VERSIONED_READ_STATES`/`VERSIONED_USER_GUILD_SETTINGS` están prendidas. Cae a `asList`
 * para los mapas viejos (`{ id: {...} }`) y devuelve los arrays tal cual.
 */
export function entriesOf(value: unknown, idKey = "id"): any[] {
  if (Array.isArray(value)) return value;
  const record = value as { entries?: unknown } | null;
  if (record !== null && typeof record === "object" && Array.isArray(record.entries)) return record.entries;
  return asList(value, idKey);
}

/** `discriminator` solo cuando es del sistema viejo de nombres (no "0"). */
export function legacyDiscriminator(raw: any): { discriminator?: string } {
  const disc = raw?.discriminator;
  return typeof disc === "string" && disc !== "0" && disc !== "" ? { discriminator: disc } : {};
}

/** `member.avatar` (avatar propio del server) solo si vino en el payload. */
export function memberAvatar(raw: any, previous?: string | null): { avatar?: string | null } {
  if (typeof raw?.avatar === "string") return { avatar: raw.avatar };
  if (raw?.avatar === null) return { avatar: null };
  return previous !== undefined ? { avatar: previous } : {};
}

export function toUser(raw: any): UserState {
  return {
    id: raw.id,
    username: raw.username ?? raw.id,
    globalName: raw.global_name ?? null,
    avatar: raw.avatar ?? null,
    bot: raw.bot === true,
    ...legacyDiscriminator(raw),
  };
}

export function toRole(raw: any): RoleState {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    color: typeof raw.color === "number" ? raw.color : 0,
    position: typeof raw.position === "number" ? raw.position : 0,
    permissions: typeof raw.permissions === "string" ? raw.permissions : "0",
  };
}

function toOverwrite(raw: any): OverwriteState {
  return {
    id: raw.id,
    type: typeof raw.type === "number" ? raw.type : 0,
    allow: typeof raw.allow === "string" ? raw.allow : "0",
    deny: typeof raw.deny === "string" ? raw.deny : "0",
  };
}

export function toChannel(raw: any, guildId: string | null): ChannelState {
  return {
    id: raw.id,
    guildId,
    name: raw.name ?? raw.id,
    type: typeof raw.type === "number" ? raw.type : 0,
    position: typeof raw.position === "number" ? raw.position : 0,
    parentId: raw.parent_id ?? null,
    permissionOverwrites: Array.isArray(raw.permission_overwrites) ? raw.permission_overwrites.map(toOverwrite) : [],
    lastMessageId: raw.last_message_id ?? null,
  };
}

/** Nombre de un DM o grupo: el puesto a mano, o los participantes (global name antes que username). */
export function privateChannelName(users: Record<string, UserState>, recipientIds: string[], type: number, ownName: string | null): string {
  if (ownName) return ownName;
  const names = recipientIds.map((id) => users[id]?.globalName ?? users[id]?.username ?? "alguien");
  if (type === 3) return names.join(", ") || "grupo sin nadie";
  return names[0] ?? "DM";
}

/** DM o grupo desde READY, READY_SUPPLEMENTAL o CHANNEL_CREATE (con `recipients` o con `recipient_ids`). */
export function toPrivateChannel(raw: any, users: Record<string, UserState>): ChannelState {
  const recipientIds: string[] = Array.isArray(raw.recipient_ids)
    ? raw.recipient_ids.filter((id: unknown): id is string => typeof id === "string")
    : asList(raw.recipients, "id").map((recipient) => recipient.id).filter((id): id is string => typeof id === "string");
  const ownName = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null;
  const type = typeof raw.type === "number" ? raw.type : 1;
  return {
    ...toChannel(raw, null),
    type,
    recipientIds,
    ownName,
    name: privateChannelName(users, recipientIds, type, ownName),
  };
}

function setMember(set: Set<string>, id: string, on: boolean): void {
  if (on) set.add(id);
  else set.delete(id);
}

export interface GuildTarget {
  guilds: Record<string, GuildState>;
  channels: Record<string, ChannelState>;
  members: Record<string, Record<string, MemberState>>;
  presences: Record<string, PresenceState>;
  rememberUser: (raw: any) => UserState | null;
}

/** Un guild completo (de READY o GUILD_CREATE): el guild, sus miembros, presencias, canales e hilos. */
export function absorbGuild(rawGuild: any, target: GuildTarget): void {
  const { guilds, channels, members, presences, rememberUser } = target;
  const properties = rawGuild.properties ?? {};
  guilds[rawGuild.id] = {
    id: rawGuild.id,
    name: typeof properties.name === "string" ? properties.name : rawGuild.name ?? rawGuild.id,
    icon: properties.icon ?? rawGuild.icon ?? null,
    ownerId: properties.owner_id ?? rawGuild.owner_id ?? "",
    roles: asList(rawGuild.roles, "id").map(toRole),
    emojis: asList(rawGuild.emojis, "id").map((emoji: any) => ({
      id: emoji.id ?? "",
      name: emoji.name ?? "",
      animated: emoji.animated === true,
    })),
  };

  const guildMembers: Record<string, MemberState> = {};
  for (const rawMember of asList(rawGuild.members, "user_id")) {
    // En READY viene `user_id`; en GUILD_CREATE, el objeto `user`.
    const userId = rawMember.user_id ?? rawMember.user?.id;
    if (typeof userId !== "string") continue;
    guildMembers[userId] = {
      userId,
      guildId: rawGuild.id,
      roles: Array.isArray(rawMember.roles) ? rawMember.roles : [],
      nick: rawMember.nick ?? null,
      ...memberAvatar(rawMember),
    };
    if (rawMember.user) rememberUser(rawMember.user);
  }
  members[rawGuild.id] = guildMembers;

  for (const rawPresence of asList(rawGuild.presences, "user_id")) {
    presences[rawPresence.user_id] = {
      status: rawPresence.status ?? "offline",
      activities: Array.isArray(rawPresence.activities) ? rawPresence.activities : [],
    };
  }

  for (const rawChannel of asList(rawGuild.channels, "id")) {
    if (typeof rawChannel.id !== "string") continue;
    const thread = isThreadPayload(rawChannel) ? toThread(rawChannel, rawGuild.id) : null;
    channels[rawChannel.id] = thread ?? toChannel(rawChannel, rawGuild.id);
  }
  // Hilos activos que el usuario ve (en cuentas de usuario: los que sigue; el resto llega en THREAD_LIST_SYNC).
  for (const rawThread of asList(rawGuild.threads, "id")) {
    const thread = toThread(rawThread, rawGuild.id);
    if (thread) channels[thread.id] = thread;
  }
}

export function applyReady(state: AppState, d: any): AppState {
  const users: Record<string, UserState> = { ...state.users };
  const rememberUser = (raw: any): UserState | null => {
    if (!raw || typeof raw.id !== "string") return null;
    const user = toUser(raw);
    users[user.id] = user;
    return user;
  };

  for (const raw of asList(d.users, "id")) rememberUser(raw);

  const guilds = { ...state.guilds };
  const guildOrder: string[] = [];
  const channels = { ...state.channels };
  const members = { ...state.members };
  const presences = { ...state.presences };

  for (const rawGuild of asList(d.guilds, "id")) {
    guildOrder.push(rawGuild.id);
    absorbGuild(rawGuild, { guilds, channels, members, presences, rememberUser });
  }

  // Con DEDUPE_USER_OBJECTS (1<<4) los miembros llegan colapsados en `merged_members[i]` por guild y
  // `guild.members` no viene; con PRIORITIZED_READY_PAYLOAD (1<<5) trae solo tu propio member. Se mezcla
  // encima de lo que ya haya en `guild.members`.
  const mergedMembers: any[] = Array.isArray(d.merged_members) ? d.merged_members : [];
  if (mergedMembers.length > 0) {
    asList(d.guilds, "id").forEach((rawGuild, index) => {
      const list = mergedMembers[index];
      if (typeof rawGuild?.id !== "string" || !Array.isArray(list)) return;
      const byUser = { ...(members[rawGuild.id] ?? {}) };
      for (const raw of list) {
        if (typeof raw?.user_id !== "string") continue;
        byUser[raw.user_id] = {
          userId: raw.user_id,
          guildId: rawGuild.id,
          roles: Array.isArray(raw.roles) ? raw.roles : byUser[raw.user_id]?.roles ?? [],
          nick: raw.nick ?? byUser[raw.user_id]?.nick ?? null,
          ...memberAvatar(raw, byUser[raw.user_id]?.avatar),
        };
        if (raw.user) rememberUser(raw.user);
      }
      members[rawGuild.id] = byUser;
    });
  }

  const privateChannelIds: string[] = [];
  for (const rawChannel of asList(d.private_channels, "id")) {
    for (const recipient of asList(rawChannel.recipients, "id")) rememberUser(recipient);
    channels[rawChannel.id] = toPrivateChannel(rawChannel, users);
    privateChannelIds.push(rawChannel.id);
  }

  const readState = { ...state.readState };
  for (const raw of entriesOf(d.read_state, "id")) {
    readState[raw.id] = {
      lastAckedId: raw.last_message_id ?? null,
      mentionCount: typeof raw.mention_count === "number" ? raw.mention_count : 0,
    };
  }

  // Un READY trae los silencios completos: reemplazan a los de la sesión anterior (si no, nunca se des-silencia
  // nada). Una estructura versionada `partial` trae solo lo que cambió; sin el campo, se queda lo que había.
  const keep = d.user_guild_settings === undefined || d.user_guild_settings?.partial === true;
  const mutedGuilds = new Set(keep ? state.guildSettings.mutedGuilds : []);
  const mutedChannels = new Set(keep ? state.guildSettings.mutedChannels : []);
  for (const raw of entriesOf(d.user_guild_settings, "guild_id")) {
    if (typeof raw.guild_id === "string") setMember(mutedGuilds, raw.guild_id, raw.muted === true);
    for (const override of entriesOf(raw.channel_overrides, "channel_id")) {
      if (typeof override.channel_id === "string") setMember(mutedChannels, override.channel_id, override.muted === true);
    }
  }

  const me = d.user ? { id: d.user.id, username: d.user.global_name ?? d.user.username ?? d.user.id } : state.me;

  return {
    ...state,
    me,
    guilds,
    guildOrder,
    channels,
    privateChannelIds,
    users,
    members,
    readState,
    guildSettings: { mutedGuilds: [...mutedGuilds], mutedChannels: [...mutedChannels] },
    presences,
  };
}

export function applyReadySupplemental(state: AppState, d: any): AppState {
  let next = state;
  const users = { ...state.users };
  for (const raw of asList(d.users, "id")) {
    if (raw?.id) users[raw.id] = toUser(raw);
  }
  const channels = { ...state.channels };
  const privateChannelIds = [...state.privateChannelIds];
  for (const raw of asList(d.lazy_private_channels, "id")) {
    for (const recipient of asList(raw.recipients, "id")) if (recipient?.id) users[recipient.id] = toUser(recipient);
    channels[raw.id] = toPrivateChannel(raw, users);
    if (!privateChannelIds.includes(raw.id)) privateChannelIds.push(raw.id);
  }

  const presences = { ...state.presences };
  const rawPresences = [
    ...asList(d.presences, "user_id"),
    // `merged_presences.friends`: la presencia de los amigos (los puntitos de los DMs).
    ...asList(d.merged_presences?.friends, "user_id"),
    ...(Array.isArray(d.merged_presences?.guilds) ? d.merged_presences.guilds.flat() : []),
  ];
  for (const raw of rawPresences) {
    const userId = raw?.user_id ?? raw?.user?.id;
    if (userId) presences[userId] = { status: raw.status ?? "offline", activities: raw.activities ?? [] };
  }

  return { ...next, users, channels, privateChannelIds, presences };
}
