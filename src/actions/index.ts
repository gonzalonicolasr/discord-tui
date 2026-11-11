import type { Gateway } from "../gateway/connection";
import type { RestClient } from "../rest/client";
import { getMessages, getReactionUsers, postAck, postTyping, searchArchivedThreads } from "../rest/routes";
import { buildGuildSubscription, nextMemberRanges } from "../gateway/subscriptions";
import { uploadAttachments } from "../uploads/upload";
import { createAckScheduler } from "./ack";
import { createTypingNotifier } from "./typing";
import type { VoiceActions } from "./voice";
import { openUrl } from "../proc/open-url";
import { createEditActions } from "./edit";
import { createReactActions } from "./react";
import { createPollActions } from "./poll";
import { createSendActions } from "./send";
import { FORUM_TYPES, selectChannelList } from "../store/selectors";
import type { Store } from "../store/store";
import type { Focus, PendingAttachment } from "../store/types";
import { HttpError } from "../rest/errors";
import type { OwnStatus } from "../settings/settings";
import type { IdlePresence } from "./presence";
import type { StatusSync } from "./status-sync";

export interface Actions {
  selectGuild(id: string | "@dms"): void;
  openChannel(id: string): Promise<void>;
  loadOlder(id: string): Promise<void>;
  /** Posts archivados de un foro: solo con un click o tecla del usuario, nunca solo. */
  loadArchivedPosts?(forumId: string): Promise<void>;
  focus(focus: Focus): void;
  toggleMembers(): void;
  send(channelId: string, content: string, opts?: { replyTo?: string; attachments?: PendingAttachment[] }): Promise<void>;
  retry(nonce: string): Promise<void>;
  edit(channelId: string, messageId: string, content: string, keepAttachments?: string[]): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  toggleReaction(channelId: string, messageId: string, emoji: { id: string | null; name: string }): Promise<void>;
  /** Nombres de quiénes pusieron la reacción (para mostrarlos al pasar el mouse). */
  reactionUsers?(channelId: string, messageId: string, emoji: { id: string | null; name: string }): Promise<string[]>;
  /** Vota (o saca el voto) en una respuesta de encuesta; no pide nada si la encuesta terminó. */
  votePoll?(channelId: string, messageId: string, answerId: number): Promise<void>;
  /** Cada tecla escrita en el composer: manda typing como máximo cada 8 s. */
  keystroke?(channelId: string, textAfter: string): void;
  /** El canal que se está mirando y su mensaje más nuevo: ack con debounce. */
  viewing?(channelId: string | null, newestId: string | null): void;
  voice?: VoiceActions;
  /** Abre un link o adjunto en el navegador (solo https). */
  openUrl?(url: string): void;
  /**
   * El usuario scrolleó la lista de miembros hasta el final de lo cargado: pide la ventana
   * siguiente con op 37 (solo para el canal abierto, a lo sumo uno cada 500 ms).
   */
  loadMoreMembers?(channelId: string): void;
  /** Estado propio elegido a mano: se guarda en settings, se manda por op 3 y se copia a los settings de la cuenta. */
  setStatus?(status: OwnStatus): void;
}

export interface ActionsDeps {
  store: Store;
  rest: RestClient;
  gateway: Pick<Gateway, "send">;
  fetch?: typeof fetch;
  voice?: VoiceActions;
  now?: () => number;
  openUrl?: (url: string) => boolean;
  presence?: Pick<IdlePresence, "statusChanged">;
  /** Copia el estado elegido a PreloadedUserSettings (los otros dispositivos). */
  statusSync?: Pick<StatusSync, "push">;
  setTimer?: typeof setTimeout;
}

/** Mínimo entre dos op 37 por scroll de la lista de miembros. */
export const MEMBER_SCROLL_THROTTLE_MS = 500;

function noticeText(action: string, error: unknown): string {
  const status = error instanceof HttpError ? error.status : null;
  return status !== null ? `no se pudo ${action}: ${status}` : `no se pudo ${action}`;
}

/** Cuánto esperar quieto en un servidor antes de abrir su primer canal (j/k rápidos no piden historial). */
const GUILD_OPEN_DEBOUNCE_MS = 250;

export function createActions(deps: ActionsDeps): Actions {
  function reportError(key: string, action: string, error: unknown): void {
    deps.store.dispatch({ type: "notice/push", key, level: "warn", text: noticeText(action, error) });
  }

  function subscribeGuild(id: string): void {
    const state = deps.store.getState();
    const opened = state.channels[id];
    // Un hilo usa la lista de miembros de su canal; los posts de un foro no cambian la suscripción.
    const channelId = opened?.thread !== undefined ? opened.parentId : id;
    const type = channelId === null ? undefined : state.channels[channelId]?.type;
    if (channelId === null || type === undefined || FORUM_TYPES.has(type)) return;
    const guildId = state.channels[channelId]?.guildId;
    if (!guildId || state.subscribedChannels[guildId] === channelId) return;
    const payload = buildGuildSubscription(guildId, channelId);
    deps.gateway.send(payload.op, payload.d);
    deps.store.dispatch({ type: "members/subscribed", guildId, channelId });
  }

  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  let pendingGuildOpen: ReturnType<typeof setTimeout> | null = null;
  let guildOpenSeq = 0;
  let lastMembersOp = -Infinity;
  let pendingMembers: string | null = null;

  function sendMoreMembers(channelId: string): void {
    const state = deps.store.getState();
    if (state.ui.selectedChannelId !== channelId) return;
    const guildId = state.channels[channelId]?.guildId;
    if (!guildId || state.subscribedChannels[guildId] !== channelId) return;
    const subscribed = state.subscribedRanges[guildId] ?? [[0, 99]];
    const ranges = nextMemberRanges(subscribed, state.memberLists[guildId]?.length ?? 0);
    if (ranges === null || JSON.stringify(ranges) === JSON.stringify(subscribed)) return;
    lastMembersOp = now();
    const payload = buildGuildSubscription(guildId, channelId, ranges);
    deps.gateway.send(payload.op, payload.d);
    deps.store.dispatch({ type: "members/subscribed", guildId, channelId, ranges });
  }

  function loadMoreMembers(channelId: string): void {
    const wait = lastMembersOp + MEMBER_SCROLL_THROTTLE_MS - now();
    if (wait <= 0) return sendMoreMembers(channelId);
    // Dentro de la ventana: un solo envío al final de los 500 ms, con el último canal pedido.
    const scheduled = pendingMembers !== null;
    pendingMembers = channelId;
    if (scheduled) return;
    setTimer(() => {
      const id = pendingMembers;
      pendingMembers = null;
      if (id !== null) sendMoreMembers(id);
    }, wait);
  }

  async function openChannel(id: string): Promise<void> {
    deps.store.dispatch({ type: "ui/selectChannel", id });
    const kind = deps.store.getState().channels[id]?.type;
    // Voz, categorías y foros no tienen mensajes: el foro muestra sus posts (hilos que ya están en el store).
    if (kind === 4 || (kind !== undefined && FORUM_TYPES.has(kind))) return;
    subscribeGuild(id);
    const slice = deps.store.getState().messages[id];
    if (slice !== undefined && !slice.stale) return;

    try {
      const messages = await getMessages(deps.rest, id, { limit: 50 });
      deps.store.dispatch({ type: "messages/page", channelId: id, messages, mode: "latest" });
    } catch (error) {
      reportError("open-channel", "abrir el canal", error);
      throw error;
    }
  }

  async function loadOlder(id: string): Promise<void> {
    const slice = deps.store.getState().messages[id];
    if (!slice || slice.loadingOlder || !slice.hasMoreBefore) return;
    const oldest = slice.ids[0];
    if (oldest === undefined) return;

    deps.store.dispatch({ type: "messages/loading", channelId: id, loading: true });
    try {
      const messages = await getMessages(deps.rest, id, { before: oldest, limit: 50 });
      deps.store.dispatch({ type: "messages/page", channelId: id, messages, mode: "older" });
    } finally {
      deps.store.dispatch({ type: "messages/loading", channelId: id, loading: false });
    }
  }

  const archivedOffset: Record<string, number> = {};
  const loadingArchived = new Set<string>();

  async function loadArchivedPosts(forumId: string): Promise<void> {
    const forum = deps.store.getState().channels[forumId];
    if (!forum?.guildId || loadingArchived.has(forumId)) return;
    const guildId = forum.guildId;
    loadingArchived.add(forumId);
    try {
      const result = await searchArchivedThreads(deps.rest, forumId, { offset: archivedOffset[forumId] ?? 0 });
      if (!Array.isArray(result?.threads)) {
        deps.store.dispatch({ type: "notice/push", key: "archived-posts", level: "info", text: "Discord todavía está indexando el foro, probá en un rato" });
        return;
      }
      archivedOffset[forumId] = (archivedOffset[forumId] ?? 0) + result.threads.length;
      deps.store.dispatch({ type: "threads/loaded", guildId, threads: result.threads });
      if (result.threads.length === 0 || result.has_more === false) {
        deps.store.dispatch({ type: "notice/push", key: "archived-posts", level: "info", text: "no hay más posts archivados" });
      }
    } catch (error) {
      reportError("archived-posts", "traer los posts archivados", error);
      throw error;
    } finally {
      loadingArchived.delete(forumId);
    }
  }

  const fetchFn = deps.fetch ?? fetch;
  const sendActions = createSendActions({
    store: deps.store,
    rest: deps.rest,
    upload: (channelId, files) => uploadAttachments(deps.rest, fetchFn, channelId, files),
  });
  const typing = createTypingNotifier({ postTyping: (id) => postTyping(deps.rest, id), now: deps.now ?? Date.now });
  const ack = createAckScheduler({
    postAck: async (channelId, messageId, token) => {
      deps.store.dispatch({ type: "gw", t: "MESSAGE_ACK", d: { channel_id: channelId, message_id: messageId } });
      return postAck(deps.rest, channelId, messageId, { token });
    },
  });
  const editActions = createEditActions({ rest: deps.rest, store: deps.store });
  const reactActions = createReactActions({ store: deps.store, rest: deps.rest });
  const pollActions = createPollActions({ store: deps.store, rest: deps.rest, now: deps.now });

  async function edit(channelId: string, messageId: string, content: string, keepAttachments?: string[]): Promise<void> {
    try {
      await editActions.edit(channelId, messageId, content, keepAttachments);
    } catch (error) {
      reportError("edit-message", "editar el mensaje", error);
      throw error;
    }
  }

  async function remove(channelId: string, messageId: string): Promise<void> {
    try {
      await editActions.remove(channelId, messageId);
    } catch (error) {
      reportError("remove-message", "borrar el mensaje", error);
      throw error;
    }
  }

  // Quién reaccionó: se pide una vez por mensaje+emoji+cantidad (si cambia la cantidad, se vuelve a pedir).
  const reactionCache = new Map<string, Promise<string[]>>();
  function reactionUsers(channelId: string, messageId: string, emoji: { id: string | null; name: string }): Promise<string[]> {
    const state = deps.store.getState();
    const count = (state.messages[channelId]?.byId[messageId] as any)?.reactions?.find(
      (r: any) => (r?.emoji?.id ?? null) === emoji.id && r?.emoji?.name === emoji.name,
    )?.count;
    const key = `${messageId}:${emoji.id ?? emoji.name}:${count ?? "?"}`;
    let job = reactionCache.get(key);
    if (!job) {
      job = getReactionUsers(deps.rest, channelId, messageId, emoji).then((users) => {
        const now = deps.store.getState();
        const guildId = now.channels[channelId]?.guildId ?? null;
        return users.map((u) => (guildId !== null ? now.members[guildId]?.[u.id]?.nick : null) ?? u.global_name ?? u.username ?? now.users[u.id]?.globalName ?? "alguien");
      });
      job.catch(() => reactionCache.delete(key));
      if (reactionCache.size > 200) reactionCache.clear();
      reactionCache.set(key, job);
    }
    return job;
  }

  async function toggleReaction(
    channelId: string,
    messageId: string,
    emoji: { id: string | null; name: string },
  ): Promise<void> {
    try {
      await reactActions.toggleReaction(channelId, messageId, emoji);
    } catch (error) {
      reportError("toggle-reaction", "reaccionar", error);
      throw error;
    }
  }

  async function votePoll(channelId: string, messageId: string, answerId: number): Promise<void> {
    try {
      const sent = await pollActions.vote(channelId, messageId, answerId);
      if (!sent) deps.store.dispatch({ type: "notice/push", key: "poll-vote", level: "info", text: "la encuesta ya terminó" });
    } catch (error) {
      reportError("poll-vote", "votar", error);
      throw error;
    }
  }

  return {
    selectGuild(id: string | "@dms"): void {
      const wasSelected = deps.store.getState().ui.selectedGuildId !== null;
      deps.store.dispatch({ type: "ui/selectGuild", id });
      const first = selectChannelList(deps.store.getState(), id).find(
        (row) => row.kind === "text" || row.kind === "dm" || row.kind === "group_dm",
      );
      if (!first) return;
      // La selección inicial abre el primer canal al toque. Después, j/k entre servidores solo cambian la selección
      // y el canal donde quedás se abre (con su historial) cuando dejás de moverte: sin un GET por cada paso (B6),
      // pero nunca queda en "cargando…".
      if (pendingGuildOpen !== null) clearTimeout(pendingGuildOpen);
      pendingGuildOpen = null;
      if (!wasSelected) {
        guildOpenSeq++;
        void openChannel(first.id).catch(() => {});
        return;
      }
      deps.store.dispatch({ type: "ui/selectChannel", id: first.id });
      const seq = ++guildOpenSeq;
      pendingGuildOpen = setTimer(() => {
        if (seq !== guildOpenSeq) return; // hubo otro movimiento después
        pendingGuildOpen = null;
        if (deps.store.getState().ui.selectedChannelId === first.id) void openChannel(first.id).catch(() => {});
      }, GUILD_OPEN_DEBOUNCE_MS);
    },
    openChannel,
    loadOlder,
    loadArchivedPosts,
    focus(focus: Focus): void {
      deps.store.dispatch({ type: "ui/focus", focus });
    },
    toggleMembers(): void {
      deps.store.dispatch({ type: "ui/toggleMembers" });
    },
    send: async (channelId, content, opts) => {
      typing.onSent(channelId);
      await sendActions.send(channelId, content, opts);
    },
    keystroke: (channelId, textAfter) => typing.onKeystroke(channelId, textAfter),
    viewing: (channelId, newestId) => ack.viewing(channelId, newestId),
    voice: deps.voice,
    openUrl: (url) => {
      if (!(deps.openUrl ?? openUrl)(url)) {
        deps.store.dispatch({ type: "notice/push", key: "open-url", level: "warn", text: "no pude abrir el link" });
      }
    },
    loadMoreMembers,
    setStatus(status: OwnStatus): void {
      deps.store.dispatch({ type: "settings/set", patch: { status } });
      deps.presence?.statusChanged();
      void deps.statusSync?.push(status);
    },
    retry: sendActions.retry,
    edit,
    remove,
    toggleReaction,
    reactionUsers,
    votePoll,
  };
}
