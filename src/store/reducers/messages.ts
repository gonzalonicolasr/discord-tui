import type { ApiMessage, ApiPoll, AppState, Message, MessageSlice } from "../types";
import { compareSnowflakes } from "../../util/snowflake";
import { toStickers } from "./polls";
import { legacyDiscriminator } from "./ready";

const RING_SIZE = 500;


function rememberAuthor(state: AppState, raw: any): AppState {
  const author = raw?.author;
  if (!author || typeof author.id !== "string") return state;
  const previous = state.users[author.id];
  // Solo se pisan los campos que vienen: un autor sin `global_name` no borra el nombre que ya teníamos.
  const next = {
    id: author.id,
    username: author.username ?? previous?.username ?? author.id,
    globalName: author.global_name !== undefined ? author.global_name : previous?.globalName ?? null,
    avatar: author.avatar !== undefined ? author.avatar : previous?.avatar ?? null,
    bot: author.bot !== undefined ? author.bot === true : previous?.bot ?? false,
    ...legacyDiscriminator(author.discriminator !== undefined ? author : previous),
  };
  if (
    previous &&
    previous.username === next.username &&
    previous.globalName === next.globalName &&
    previous.avatar === next.avatar &&
    previous.bot === next.bot &&
    previous.discriminator === next.discriminator
  ) {
    return state;
  }
  return { ...state, users: { ...state.users, [author.id]: next } };
}

function emptySlice(): MessageSlice {
  return { ids: [], byId: {}, hasMoreBefore: true, loadingOlder: false, stale: false };
}

function withLastMessage(state: AppState, channelId: string, messageId: string): AppState {
  const channel = state.channels[channelId];
  if (!channel) return state;
  if (channel.lastMessageId !== null && compareSnowflakes(messageId, channel.lastMessageId) <= 0) return state;
  return { ...state, channels: { ...state.channels, [channelId]: { ...channel, lastMessageId: messageId } } };
}

function appendMessage(state: AppState, raw: ApiMessage): AppState {
  const channelId = raw.channel_id;
  // Un canal que nunca abriste: el slice tiene solo lo que llegó en vivo, sin historial. Queda `stale` para que
  // openChannel lo pida igual.
  const slice = state.messages[channelId] ?? { ...emptySlice(), stale: true };
  if (slice.byId[raw.id]) return state;

  const ids = [...slice.ids, raw.id].sort(compareSnowflakes);
  const byId = { ...slice.byId, [raw.id]: raw };
  const trimmedIds = ids.length > RING_SIZE ? ids.slice(ids.length - RING_SIZE) : ids;
  const trimmedById: Record<string, ApiMessage> = {};
  for (const id of trimmedIds) trimmedById[id] = byId[id]!;

  const next = {
    ...state,
    messages: { ...state.messages, [channelId]: { ...slice, ids: trimmedIds, byId: trimmedById } },
  };
  return withLastMessage(next, channelId, raw.id);
}

function updateMessage(state: AppState, raw: Partial<ApiMessage>): AppState {
  if (typeof raw.id !== "string") return state;
  const channelId = raw.channel_id;
  if (typeof channelId !== "string") return state;
  const slice = state.messages[channelId];
  const previous = slice?.byId[raw.id];
  if (!slice || !previous) return state;

  const merged = { ...previous, ...raw } as ApiMessage;
  // Un MESSAGE_UPDATE con la encuesta sin `results` no borra los votos que ya contamos.
  const prevPoll = (previous as any).poll;
  const nextPoll = (raw as any).poll;
  if (prevPoll && nextPoll && typeof nextPoll === "object" && nextPoll.results === undefined && prevPoll.results !== undefined) {
    (merged as any).poll = { ...nextPoll, results: prevPoll.results };
  }
  return {
    ...rememberAuthor(state, raw),
    messages: { ...state.messages, [channelId]: { ...slice, byId: { ...slice.byId, [raw.id!]: merged } } },
  };
}

function removeMessages(state: AppState, channelId: string, ids: string[]): AppState {
  const slice = state.messages[channelId];
  if (!slice) return state;
  const removing = new Set(ids);
  const keptIds = slice.ids.filter((id) => !removing.has(id));
  if (keptIds.length === slice.ids.length) return state;
  const byId = { ...slice.byId };
  for (const id of ids) delete byId[id];
  return { ...state, messages: { ...state.messages, [channelId]: { ...slice, ids: keptIds, byId } } };
}

export function applyMessageCreate(state: AppState, d: any): AppState {
  if (!d || typeof d.id !== "string" || typeof d.channel_id !== "string") return state;
  return appendMessage(rememberAuthor(state, d), d as ApiMessage);
}

export function applyMessageUpdate(state: AppState, d: any): AppState {
  if (!d || typeof d.id !== "string") return state;
  return updateMessage(state, d as Partial<ApiMessage>);
}

export function applyMessageDelete(state: AppState, d: any): AppState {
  if (!d || typeof d.id !== "string" || typeof d.channel_id !== "string") return state;
  return removeMessages(state, d.channel_id, [d.id]);
}

export function applyMessageDeleteBulk(state: AppState, d: any): AppState {
  if (!d || typeof d.channel_id !== "string" || !Array.isArray(d.ids)) return state;
  return removeMessages(state, d.channel_id, d.ids.filter((id: unknown) => typeof id === "string"));
}

export function applyPage(
  state: AppState,
  channelId: string,
  messages: ApiMessage[],
  mode: "older" | "latest" | "around",
): AppState {
  let nextState = state;
  for (const message of messages) nextState = rememberAuthor(nextState, message);
  state = nextState;
  const existing = state.messages[channelId] ?? emptySlice();
  // La última página sobre un slice viejo (sesión nueva) o un salto "around" reemplazan el slice: mezclarlos deja
  // mensajes ya borrados y un hueco sin marcar. De lo viejo solo se queda lo que llegó en vivo durante el GET.
  const replace = mode === "around" || (mode === "latest" && existing.stale);
  const newestInPage = messages.reduce<string | null>((max, m) => (max === null || compareSnowflakes(m.id, max) > 0 ? m.id : max), null);
  const keptIds = !replace
    ? existing.ids
    : mode === "latest" && newestInPage !== null
      ? existing.ids.filter((id) => compareSnowflakes(id, newestInPage) > 0)
      : [];
  const previous = replace ? { ...emptySlice(), byId: Object.fromEntries(keptIds.map((id) => [id, existing.byId[id]!])) } : existing;
  const byId = { ...previous.byId };
  const ids = new Set(keptIds);
  for (const message of messages) {
    byId[message.id] = message;
    ids.add(message.id);
  }
  const ordered = [...ids].sort(compareSnowflakes);
  // Una página vieja recorta por el lado nuevo (si no, se tira justo lo que se acaba de traer); el resto, por el viejo.
  const overflow = Math.max(0, ordered.length - RING_SIZE);
  const fromNewest = mode === "older" && overflow > 0;
  const trimmed = fromNewest ? ordered.slice(0, RING_SIZE) : ordered.slice(overflow);
  // Lo que quedó fuera del anillo se suelta también de byId (si no, una sesión larga acumula mensajes sin techo).
  for (const id of fromNewest ? ordered.slice(RING_SIZE) : ordered.slice(0, overflow)) delete byId[id];

  return {
    ...state,
    messages: {
      ...state.messages,
      [channelId]: {
        ...previous,
        ids: trimmed,
        byId,
        loadingOlder: false,
        hasMoreBefore: mode === "older" ? messages.length >= 50 : previous.hasMoreBefore,
        // Solo la última página deja el slice al día. Una página vieja no lo arregla (tras un "around" sigue siendo
        // una ventana vieja) y si soltó los más nuevos lo deja viejo: al volver a abrir el canal se pide de nuevo.
        stale: mode === "latest" ? false : mode === "around" || existing.stale || fromNewest,
      },
    },
  };
}

const messageCache = new WeakMap<ApiMessage, { me: string | null; message: Message }>();

/** Igual que `buildMessage`, pero devuelve el mismo objeto mientras el mensaje crudo no cambie (la UI lo usa de key). */
export function toMessage(state: AppState, raw: ApiMessage): Message {
  const me = state.me?.id ?? null;
  const hit = messageCache.get(raw);
  if (hit && hit.me === me) return hit.message;
  const message = buildMessage(me, raw);
  messageCache.set(raw, { me, message });
  return message;
}

function buildMessage(me: string | null, raw: ApiMessage): Message {
  const referencedRaw = (raw as any).referenced_message;
  const referenced =
    referencedRaw && typeof referencedRaw === "object"
      ? {
          id: String(referencedRaw.id ?? ""),
          authorId: String(referencedRaw.author?.id ?? ""),
          content: String(referencedRaw.content ?? ""),
        }
      : null;

  const mentionIds = Array.isArray(raw.mentions) ? raw.mentions.map((user: any) => String(user.id)) : [];
  const content = String(raw.content ?? "");
  const mentionsMe =
    (me !== null && (mentionIds.includes(me) || content.includes(`<@${me}>`) || content.includes(`<@!${me}>`))) ||
    (Boolean(raw.mention_everyone) && (content.includes("@everyone") || content.includes("@here"))) ||
    (me !== null && referenced?.authorId === me);

  return {
    id: raw.id,
    channelId: raw.channel_id,
    authorId: raw.author?.id ?? "",
    content,
    timestamp: raw.timestamp ?? "",
    editedTimestamp: raw.edited_timestamp ?? null,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    embeds: Array.isArray(raw.embeds) ? raw.embeds : [],
    mentionIds,
    mentionsMe,
    referenced,
    reactions: Array.isArray(raw.reactions)
      ? raw.reactions.map((reaction: any) => ({
          emoji: { id: reaction.emoji?.id ?? null, name: reaction.emoji?.name ?? "", ...(reaction.emoji?.animated === true ? { animated: true } : {}) },
          count: reaction.count ?? 0,
          me: reaction.me === true,
        }))
      : [],
    nonce: raw.nonce !== undefined && raw.nonce !== null ? String(raw.nonce) : null,
    poll: (raw as any).poll && typeof (raw as any).poll === "object" ? ((raw as any).poll as ApiPoll) : null,
    stickers: toStickers((raw as any).sticker_items),
  };
}
