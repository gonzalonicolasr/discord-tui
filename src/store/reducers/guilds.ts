import type { AppState, ChannelState } from "../types";
import { absorbGuild, entriesOf, toRole, toUser } from "./ready";

/** GUILD_CREATE: un servidor al que te uniste (o que volvió a estar disponible). */
export function applyGuildCreate(state: AppState, d: any): AppState {
  if (typeof d?.id !== "string") return state;
  const users = { ...state.users };
  const guilds = { ...state.guilds };
  const channels = { ...state.channels };
  const members = { ...state.members };
  const presences = { ...state.presences };
  absorbGuild(d, {
    guilds,
    channels,
    members,
    presences,
    rememberUser: (raw) => {
      if (typeof raw?.id !== "string") return null;
      return (users[raw.id] = toUser(raw));
    },
  });
  // Un servidor que ya estaba (vuelve de una caída) puede traer pocos miembros o ninguno: se mezclan con los que
  // ya había (roles, apodos, avatares) en vez de pisarlos. Las presencias ya se escriben de a una.
  const known = state.members[d.id];
  if (known) members[d.id] = { ...known, ...members[d.id] };
  const guildOrder = state.guildOrder.includes(d.id) ? state.guildOrder : [...state.guildOrder, d.id];
  return { ...state, users, guilds, guildOrder, channels, members, presences };
}

/** GUILD_UPDATE: nombre, ícono, dueño y roles (solo lo que trae el payload). */
export function applyGuildUpdate(state: AppState, d: any): AppState {
  const guild = typeof d?.id === "string" ? state.guilds[d.id] : undefined;
  if (!guild) return state;
  const next = {
    ...guild,
    ...(typeof d.name === "string" ? { name: d.name } : {}),
    ...(d.icon !== undefined ? { icon: d.icon ?? null } : {}),
    ...(typeof d.owner_id === "string" ? { ownerId: d.owner_id } : {}),
    ...(Array.isArray(d.roles) ? { roles: d.roles.map(toRole) } : {}),
  };
  return { ...state, guilds: { ...state.guilds, [guild.id]: next } };
}

/** Te fuiste o te sacaron: se borra el servidor con sus canales y mensajes. */
export function removeGuild(state: AppState, guildId: string): AppState {
  if (!state.guilds[guildId]) return state;
  const guilds = { ...state.guilds };
  delete guilds[guildId];
  const channels: Record<string, ChannelState> = {};
  const messages = { ...state.messages };
  const readState = { ...state.readState };
  for (const [id, channel] of Object.entries(state.channels)) {
    if (channel.guildId === guildId) {
      delete messages[id];
      delete readState[id];
    } else channels[id] = channel;
  }
  // Todo lo que cuelga del servidor. La suscripción a la lista de miembros sobre todo: si quedara, al volver a
  // entrar al mismo servidor no se mandaría de nuevo el op 37.
  const without = <T>(record: Record<string, T>): Record<string, T> => {
    const next = { ...record };
    delete next[guildId];
    return next;
  };
  const ui = { ...state.ui };
  if (ui.selectedGuildId === guildId) ui.selectedGuildId = "@dms";
  if (ui.selectedChannelId !== null && !channels[ui.selectedChannelId]) {
    ui.selectedChannelId = null;
    // Sin canal abierto no hay mensajes, composer ni miembros donde quedarse: vuelve a la lista de canales.
    if (ui.focus === "messages" || ui.focus === "composer" || ui.focus === "members") ui.focus = "channels";
  }
  return {
    ...state,
    guilds,
    guildOrder: state.guildOrder.filter((id) => id !== guildId),
    channels,
    messages,
    readState,
    members: without(state.members),
    memberLists: without(state.memberLists),
    memberCounts: without(state.memberCounts),
    subscribedChannels: without(state.subscribedChannels),
    subscribedRanges: without(state.subscribedRanges),
    voice: { ...state.voice, states: without(state.voice.states) },
    ui,
  };
}

/** GUILD_DELETE con `unavailable: true` es una caída de Discord, no que te fuiste. */
export function applyGuildDelete(state: AppState, d: any): AppState {
  if (typeof d?.id !== "string" || d.unavailable === true) return state;
  return removeGuild(state, d.id);
}

export function applyGuildMemberRemove(state: AppState, d: any): AppState {
  if (typeof d?.guild_id !== "string" || state.me === null || d.user?.id !== state.me.id) return state;
  return removeGuild(state, d.guild_id);
}

export function applyGuildRole(state: AppState, t: "GUILD_ROLE_CREATE" | "GUILD_ROLE_UPDATE" | "GUILD_ROLE_DELETE", d: any): AppState {
  const guild = typeof d?.guild_id === "string" ? state.guilds[d.guild_id] : undefined;
  if (!guild) return state;
  let roles = guild.roles;
  if (t === "GUILD_ROLE_DELETE") {
    if (typeof d.role_id !== "string") return state;
    roles = roles.filter((role) => role.id !== d.role_id);
  } else {
    if (typeof d.role?.id !== "string") return state;
    const role = toRole(d.role);
    roles = roles.some((r) => r.id === role.id) ? roles.map((r) => (r.id === role.id ? role : r)) : [...roles, role];
  }
  return { ...state, guilds: { ...state.guilds, [guild.id]: { ...guild, roles } } };
}

/**
 * USER_GUILD_SETTINGS_UPDATE: los ajustes completos de un servidor (o de los DMs, con `guild_id` null). Los
 * canales de ese servidor que no vienen en `channel_overrides` quedan sin silenciar.
 */
export function applyUserGuildSettingsUpdate(state: AppState, d: any): AppState {
  if (d === null || typeof d !== "object") return state;
  const guildId: string | null = typeof d.guild_id === "string" ? d.guild_id : null;
  const mutedGuilds = state.guildSettings.mutedGuilds.filter((id) => id !== guildId);
  if (guildId !== null && d.muted === true) mutedGuilds.push(guildId);
  const overrides = entriesOf(d.channel_overrides, "channel_id").filter((o) => typeof o?.channel_id === "string");
  const listed = new Set(overrides.map((o) => o.channel_id as string));
  const mutedChannels = state.guildSettings.mutedChannels.filter((id) => {
    if (listed.has(id)) return false;
    const channel = state.channels[id];
    return channel === undefined || channel.guildId !== guildId;
  });
  for (const override of overrides) if (override.muted === true) mutedChannels.push(override.channel_id);
  return { ...state, guildSettings: { mutedGuilds, mutedChannels } };
}
