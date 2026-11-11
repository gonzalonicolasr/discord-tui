import type { APIMessage } from "discord-api-types/v9";

import type { RestClient } from "./client";

export async function getMessages(
  rest: RestClient,
  channelId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<APIMessage[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.before) params.set("before", opts.before);
  return rest.request<APIMessage[]>("GET", `/channels/${channelId}/messages?${params.toString()}`);
}

export async function postMessage(
  rest: RestClient,
  channelId: string,
  body: {
    content: string;
    nonce: string;
    tts: false;
    flags: number;
    message_reference?: { message_id: string; channel_id: string; guild_id?: string };
    allowed_mentions?: { parse: string[]; replied_user: boolean };
    attachments?: unknown[];
  },
): Promise<APIMessage> {
  return rest.request<APIMessage>("POST", `/channels/${channelId}/messages`, body);
}

export async function postTyping(rest: RestClient, channelId: string): Promise<void> {
  await rest.request("POST", `/channels/${channelId}/typing`);
}

const DISCORD_EPOCH_MS = 1420070400000;
const DAY_MS = 86_400_000;

/** Días desde la época de Discord (2015-01-01): es el `last_viewed` del ack. */
export function lastViewedDays(now: number = Date.now()): number {
  return Math.floor((now - DISCORD_EPOCH_MS) / DAY_MS);
}

export interface AckRequest {
  /** Token de ack del canal; `null` la primera vez (docs.discord.food, "Ack Tokens"). */
  token?: string | null;
  /** Días desde la época de Discord; si falta, se calcula con `Date.now()`. */
  last_viewed?: number;
}

export async function postAck(
  rest: RestClient,
  channelId: string,
  messageId: string,
  body: AckRequest = {},
): Promise<{ token: string | null }> {
  const payload = {
    token: body.token ?? null,
    last_viewed: body.last_viewed ?? lastViewedDays(),
  };
  const data = await rest.request<{ token?: string | null } | null>(
    "POST",
    `/channels/${channelId}/messages/${messageId}/ack`,
    payload,
  );
  return { token: typeof data?.token === "string" ? data.token : null };
}

export async function patchMessage(
  rest: RestClient,
  channelId: string,
  messageId: string,
  body: { content: string; attachments?: { id: string }[] },
): Promise<APIMessage> {
  return rest.request<APIMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, body);
}

export async function deleteMessage(rest: RestClient, channelId: string, messageId: string): Promise<void> {
  await rest.request("DELETE", `/channels/${channelId}/messages/${messageId}`);
}

export async function putReaction(
  rest: RestClient,
  channelId: string,
  messageId: string,
  emoji: { id: string | null; name: string },
): Promise<void> {
  const path = encodeURIComponent(emoji.id !== null ? `${emoji.name}:${emoji.id}` : emoji.name);
  await rest.request("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${path}/@me`);
}

/** Quiénes pusieron una reacción (hasta `limit`, máx. 100). */
export async function getReactionUsers(
  rest: RestClient,
  channelId: string,
  messageId: string,
  emoji: { id: string | null; name: string },
  limit = 25,
): Promise<Array<{ id: string; username?: string; global_name?: string | null }>> {
  const path = encodeURIComponent(emoji.id !== null ? `${emoji.name}:${emoji.id}` : emoji.name);
  const users = await rest.request<unknown>("GET", `/channels/${channelId}/messages/${messageId}/reactions/${path}?limit=${limit}&type=0`);
  return Array.isArray(users) ? users.filter((u): u is { id: string } => typeof u?.id === "string") : [];
}

/** Vota en una encuesta (docs.discord.food, "Create Poll Vote"): `answer_ids` vacío saca el voto. 204 sin cuerpo. */
export async function putPollVote(rest: RestClient, channelId: string, messageId: string, answerIds: number[]): Promise<void> {
  await rest.request("PUT", `/channels/${channelId}/polls/${messageId}/answers/@me`, { answer_ids: answerIds });
}

export async function deleteOwnReaction(
  rest: RestClient,
  channelId: string,
  messageId: string,
  emoji: { id: string | null; name: string },
): Promise<void> {
  const path = encodeURIComponent(emoji.id !== null ? `${emoji.name}:${emoji.id}` : emoji.name);
  await rest.request("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${path}/@me`);
}

export interface ThreadSearchResult {
  threads?: unknown[];
  has_more?: boolean;
  /** 202 "Index not yet available": viene `code` 110000 y `retry_after` en vez de `threads`. */
  code?: number;
}

/** Posts archivados de un foro, los de actividad más reciente primero (25 por página). */
export async function searchArchivedThreads(
  rest: RestClient,
  channelId: string,
  opts: { offset?: number } = {},
): Promise<ThreadSearchResult> {
  const params = new URLSearchParams({
    archived: "true",
    sort_by: "last_message_time",
    sort_order: "desc",
    limit: "25",
    offset: String(opts.offset ?? 0),
  });
  return rest.request<ThreadSearchResult>("GET", `/channels/${channelId}/threads/search?${params.toString()}`);
}

/**
 * Cambia parte de los settings protobuf (docs.discord.food, "Modify User Settings Proto"):
 * `settings` = el protobuf parcial en base64; la respuesta trae los settings en base64.
 */
export async function patchSettingsProto(
  rest: RestClient,
  type: number,
  settings: string,
): Promise<{ settings?: string; out_of_date?: boolean }> {
  return rest.request("PATCH", `/users/@me/settings-proto/${type}`, { settings });
}
