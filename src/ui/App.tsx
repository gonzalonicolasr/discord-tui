import type { KeyEvent, PasteEvent } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { Actions, InboxMention } from "../actions";
import { log } from "../log/logger";
import { COMMON_EMOJI } from "../emoji/common";
import { animationScheduler } from "../images/animation";
import { audioPlayer, isAudioAttachment } from "../media/audio-player";
import { takeThemeErrors } from "./theme-files";
import { userAvatarUrl } from "../images/avatar";
import { parseMarkdown, plainText } from "../markdown/parse";
import {
  FORUM_TYPES,
  isMessageChannelType,
  selectChannelList,
  selectForumPosts,
  selectMessages,
  selectNextUnread,
  selectVisibleChannelList,
  selectVoiceParticipants,
  selectWatchableStreamers,
} from "../store/selectors";
import type { Store } from "../store/store";
import type { ApiPoll, PendingAttachment } from "../store/types";
import { selectUnreadView } from "../store/unread";
import { filePathsFromPastedText, readClipboardFiles, readClipboardImage, readClipboardText, writeClipboardText } from "../uploads/clipboard";
import { formatBytes, readAttachmentFromPath } from "../uploads/file";
import { listAudioDevices } from "../voice/devices";
import { startCapture, startPlayback } from "../voice/audio-io";
import { CHANNEL_WIDTH, ChannelList } from "./components/ChannelList";
import { Composer, MentionPopup } from "./components/Composer";
import { GUILD_WIDTH, GuildList } from "./components/GuildList";
import { HelpOverlay } from "./components/HelpOverlay";
import { MEMBER_WIDTH, MemberList } from "./components/MemberList";
import { MessageView } from "./components/MessageView";
import { StreamViewer } from "./components/StreamViewer";
import type { MessageAction } from "./components/MessageItem";
import { Button } from "./components/Button";
import { Notices } from "./components/Notices";
import { MentionsInbox } from "./components/MentionsInbox";
import { QuickSwitcher, SWITCHER_ROWS } from "./components/QuickSwitcher";
import { EmojiPicker, PICKER_ROWS } from "./components/EmojiPicker";
import { moveInList } from "./list-window";
import { StatusBar, VoiceBar } from "./components/StatusBar";
import { StatusMenu } from "./components/StatusMenu";
import { MonitorPicker } from "./components/MonitorPicker";
import { Splash, splashStatus } from "./components/Splash";
import { OutputPicker } from "./components/OutputPicker";
import type { AudioDevice } from "../voice/devices";
import type { Monitor } from "../golive/capture";
import { validateOutgoing } from "./composer-state";
import { displayName, truncate } from "./format";
import { rankSwitcherItems } from "./fuzzy";
import {
  applyPick,
  mentionCandidates,
  mentionQueryAt,
  replaceMentions,
  composerFromContent,
  serializeComposer,
  type PickedMention,
} from "./mentions";
import { SettingsScreen, type SettingsDeps } from "./screens/SettingsScreen";
import { useSelector } from "./store-bridge";
import {
  clampCursor,
  lineDown,
  lineEnd,
  lineStart,
  lineUp,
  nextGrapheme,
  prevGrapheme,
  ruboutStart,
  splice,
  wordLeft,
  wordRight,
} from "./text-edit";
import { useTheme } from "./theme";

function isOpenable(kind: string): boolean {
  return kind === "text" || kind === "dm" || kind === "group_dm" || kind === "thread" || kind === "forum" || kind === "media";
}

const defaultSettingsDeps: SettingsDeps = { listAudioDevices, startCapture, startPlayback };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface AppDeps {
  readClipboardFiles?: typeof readClipboardFiles;
  readClipboardImage: typeof readClipboardImage;
  readClipboardText: typeof readClipboardText;
  readAttachmentFromPath: typeof readAttachmentFromPath;
  writeClipboardText?: typeof writeClipboardText;
}

const defaultAppDeps: AppDeps = { readClipboardFiles, readClipboardImage, readClipboardText, readAttachmentFromPath, writeClipboardText };

export function App(props: {
  store: Store;
  actions: Actions;
  onQuit: () => void;
  /** Ctrl+R: recargar zcord sin salir de la terminal (solo con bin/zcord). */
  onReload?: () => void;
  settingsDeps?: SettingsDeps;
  deps?: Partial<AppDeps>;
  onActivity?(): void;
  images?: boolean;
  /** Mostrar la pantalla de inicio de zcord mientras conecta (la app real; los tests no). */
  splash?: boolean;
}): JSX.Element {
  const deps = (): AppDeps => ({ ...defaultAppDeps, ...props.deps });
  // Splash: mínimo 1,2 s; se va cuando ya hay servidores cargados, o si la conexión falla (para ver el error).
  const [splashMinDone, setSplashMinDone] = createSignal(false);
  const splashTimer = setTimeout(() => setSplashMinDone(true), 1_200);
  onCleanup(() => clearTimeout(splashTimer));
  const connectionState = useSelector(props.store, (state) => ({
    connection: state.connection,
    guilds: state.guildOrder.length,
    loaded: state.guildOrder.length > 0 || state.privateChannelIds.length > 0,
  }), (a, b) => a.connection === b.connection && a.guilds === b.guilds && a.loaded === b.loaded);
  const [splashSeenConnecting, setSplashSeenConnecting] = createSignal(false);
  createEffect(() => {
    if (connectionState().connection !== "disconnected") setSplashSeenConnecting(true);
  });
  const showSplash = (): boolean => {
    if (!props.splash) return false;
    const { connection, loaded } = connectionState();
    const failed = connection === "disconnected" && splashSeenConnecting();
    if (failed) return false;
    return !splashMinDone() || !(connection === "ready" && loaded);
  };
  const theme = useTheme(props.store);
  const dims = useTerminalDimensions();
  const focus = useSelector(props.store, (state) => state.ui.focus);
  const membersVisible = useSelector(props.store, (state) => state.ui.membersVisible);
  // Miembros en servidores y también en DMs y grupos (los participantes), como Discord.
  const inGuild = useSelector(props.store, (state) => {
    const channelId = state.ui.selectedChannelId;
    if (channelId !== null && state.channels[channelId]) return true;
    return state.ui.selectedGuildId !== null && state.ui.selectedGuildId !== "@dms";
  });
  const inlineImages = useSelector(props.store, (state) => state.settings.inlineImages);
  const animateImages = useSelector(props.store, (state) => state.settings.animateImages);
  const showAvatars = useSelector(props.store, (state) => state.settings.showAvatars);
  // Terminal sin foco (Ghostty manda CSI I / CSI O): los GIFs se frenan y no queda timer vivo.
  const renderer = useRenderer();
  // Audios y mensajes de voz suenan por la salida elegida en settings (la misma que las llamadas).
  const player = audioPlayer(() => props.store.getState().settings.outputDevice);
  onCleanup(() => player.stop());
  const pauseAnimations = (): void => animationScheduler.setPaused(true);
  const resumeAnimations = (): void => animationScheduler.setPaused(false);
  renderer.on("blur", pauseAnimations);
  renderer.on("focus", resumeAnimations);
  onCleanup(() => {
    renderer.off("blur", pauseAnimations);
    renderer.off("focus", resumeAnimations);
    animationScheduler.setPaused(false);
  });
  const textChannel = useSelector(props.store, (state) => {
    const id = state.ui.selectedChannelId;
    const type = id === null ? undefined : state.channels[id]?.type;
    return id !== null && (type === undefined || isMessageChannelType(type));
  });

  const [insert, setInsert] = createSignal(false);
  const [replyTo, setReplyTo] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [hint, setHint] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [mentions, setMentions] = createSignal<Record<string, PickedMention[]>>({});
  const [cursors, setCursors] = createSignal<Record<string, number>>({});
  const [attachments, setAttachments] = createSignal<Record<string, PendingAttachment[]>>({});
  /** Al editar: los adjuntos que ya tiene el mensaje (se pueden sacar; null = no se está editando). */
  const [editAttachments, setEditAttachments] = createSignal<Array<{ id: string; filename: string; size: number }> | null>(null);
  const editAttachmentsChanged = { value: false };
  const [attachPrompt, setAttachPrompt] = createSignal<string | null>(null);
  const [mentionIndex, setMentionIndex] = createSignal(0);
  const [mentionClosed, setMentionClosed] = createSignal(false);
  const [lastD, setLastD] = createSignal(0);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [pendingG, setPendingG] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [statusMenuOpen, setStatusMenuOpen] = createSignal(false);
  const [outputChoices, setOutputChoices] = createSignal<{ outputs: AudioDevice[]; current: string | null; isDefault: boolean } | null>(null);
  /** Monitores para elegir qué transmitir (null = cerrado). */
  const [monitorChoices, setMonitorChoices] = createSignal<Monitor[] | null>(null);
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  // Bandeja de menciones (@ o 🔔 en la barra): null = cargando.
  const [inboxOpen, setInboxOpen] = createSignal(false);
  const [inboxItems, setInboxItems] = createSignal<InboxMention[] | null>(null);
  const [inboxError, setInboxError] = createSignal<string | null>(null);
  const [inboxIndex, setInboxIndex] = createSignal(0);
  const [switcherQuery, setSwitcherQuery] = createSignal("");
  const [switcherIndex, setSwitcherIndex] = createSignal(0);
  const [pickerIndex, setPickerIndex] = createSignal(0);
  /** Cada cambio scrollea la ayuda (en filas); la ayuda lo aplica a su scrollbox. */
  const [helpScroll, setHelpScroll] = createSignal(0);
  const [participant, setParticipant] = createSignal<string | null>(null);
  const [bottomTick, setBottomTick] = createSignal(0);
  const toBottom = (): void => {
    setSelectedId(null);
    setBottomTick((n) => n + 1);
  };

  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Botón o tecla de Go Live: en vivo (o iniciando) lo corta; si no, transmite el monitor guardado, o pregunta
   * cuál si hay más de uno y no hay uno guardado que siga conectado.
   */
  async function streamPress(): Promise<void> {
    const voice = props.actions.voice;
    if (!voice?.startStream) return;
    const state = props.store.getState();
    const status = state.voice.stream.status;
    if (status === "live" || status === "starting") return void (await voice.stopStream?.());
    if (state.voice.status !== "connected") return void (await voice.startStream());
    const monitors = (await voice.listMonitors?.().catch(() => [])) ?? [];
    const saved = state.settings.streamMonitor;
    if (monitors.length > 1 && !(saved && monitors.some((m) => m.name === saved))) return void setMonitorChoices(monitors);
    await voice.startStream(saved && monitors.some((m) => m.name === saved) ? saved : monitors[0]?.name);
  }

  /**
   * `w` o `▶ ver`: con un participante que transmite elegido en la lista, mirarlo (o dejar de verlo); si no, dejar
   * de ver lo que estés mirando, o mirar al primero que transmita en tu canal.
   */
  function watchPress(): void {
    const voice = props.actions.voice;
    if (!voice?.toggleWatch) return;
    const state = props.store.getState();
    const streamers = selectWatchableStreamers(state);
    const chosen = participant();
    if (chosen !== null && streamers.includes(chosen)) return void voice.toggleWatch(chosen);
    if (state.voice.watch.status !== "idle") return void voice.stopWatching?.();
    if (state.voice.status !== "connected") return flash("entrá al canal de voz de quien transmite para verlo");
    if (streamers.length === 0) return flash("nadie está transmitiendo en tu canal de voz");
    void voice.watchStream?.(streamers[0]!);
  }
  const watching = useSelector(props.store, (s) => s.voice.watch.status !== "idle");
  // Al empezar a mirar una transmisión se abre el chat de ese canal de voz (como en Discord), al lado del video.
  let wasWatching = false;
  createEffect(() => {
    const now = watching();
    if (now && !wasWatching) {
      const voiceChannel = props.store.getState().voice.channelId;
      if (voiceChannel !== null && props.store.getState().ui.selectedChannelId !== voiceChannel) {
        void props.actions.openChannel(voiceChannel).catch(() => {});
      }
    }
    wasWatching = now;
  });

  function flash(text: string): void {
    setHint(text);
    if (hintTimer !== null) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => setHint(null), 4_000);
  }
  onCleanup(() => {
    if (hintTimer !== null) clearTimeout(hintTimer);
  });

  const channelId = (): string | null => props.store.getState().ui.selectedChannelId;
  const currentText = (): string => {
    const id = channelId();
    return id === null ? "" : drafts()[id] ?? "";
  };
  /** Cursor del borrador del canal (offset en el texto); sin cursor guardado, al final. */
  const currentCursor = (): number => {
    const id = channelId();
    const text = currentText();
    return id === null ? 0 : clampCursor(text, cursors()[id] ?? text.length);
  };
  const currentMentions = (): PickedMention[] => {
    const id = channelId();
    return id === null ? [] : mentions()[id] ?? [];
  };
  const currentAttachments = (): PendingAttachment[] => {
    const id = channelId();
    return id === null ? [] : attachments()[id] ?? [];
  };
  const isTextChannel = (): boolean => {
    const id = channelId();
    const type = id === null ? undefined : props.store.getState().channels[id]?.type;
    return id !== null && (type === undefined || isMessageChannelType(type));
  };

  function setText(text: string, picked: PickedMention[] = currentMentions(), cursor: number = text.length): void {
    const id = channelId();
    if (id === null) return;
    setDrafts((previous) => ({ ...previous, [id]: text }));
    setMentions((previous) => ({ ...previous, [id]: picked }));
    setCursors((previous) => ({ ...previous, [id]: cursor }));
  }

  function moveCursor(cursor: number): void {
    const id = channelId();
    if (id === null) return;
    setCursors((previous) => ({ ...previous, [id]: clampCursor(currentText(), cursor) }));
    setMentionIndex(0);
  }

  /** Reemplaza [from, to) del borrador por `chunk`, corre las menciones y deja el cursor después. */
  function replaceRange(from: number, to: number, chunk: string): void {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    if (a === b && chunk.length === 0) return;
    const next = splice(currentText(), a, b, chunk);
    setText(next.text, replaceMentions(currentMentions(), a, b, chunk.length), next.cursor);
    setMentionIndex(0);
  }

  function insertText(chunk: string): void {
    const id = channelId();
    if (id === null || chunk.length === 0) return;
    const at = currentCursor();
    replaceRange(at, at, chunk);
    setMentionClosed(false);
    props.actions.keystroke?.(id, currentText());
  }

  /** Borra desde el cursor hasta `to` (antes o después del cursor). */
  function deleteTo(to: number): void {
    replaceRange(currentCursor(), to, "");
  }

  /** Saca un adjunto: al editar, de los que ya tiene el mensaje; si no, de los que vas a mandar. */
  function removeAttachmentAt(index: number): void {
    const editingList = editAttachments();
    if (editingList !== null) {
      setEditAttachments(editingList.filter((_, i) => i !== index));
      editAttachmentsChanged.value = true;
      return;
    }
    const id = channelId();
    if (id !== null) setAttachments((previous) => ({ ...previous, [id]: (previous[id] ?? []).filter((_, i) => i !== index) }));
  }

  /** Abre la bandeja de menciones y las pide a Discord (las más nuevas primero). */
  function openInbox(): void {
    if (!props.actions.mentionsInbox) return flash("las menciones no están disponibles acá");
    setInboxOpen(true);
    setInboxItems(null);
    setInboxError(null);
    setInboxIndex(0);
    void props.actions
      .mentionsInbox()
      .then((items) => setInboxItems(items))
      .catch(() => setInboxError("no pude traer las menciones (¿sin conexión?)"));
  }

  /** Ir a la mención: su canal, con el mensaje seleccionado (se trae el historial alrededor si hace falta). */
  function goToMention(index: number): void {
    const item = inboxItems()?.[index];
    setInboxOpen(false);
    if (!item || !props.actions.jumpToMessage) return;
    void props.actions
      .jumpToMessage(item.channelId, item.messageId)
      .then(() => {
        setSelectedId(item.messageId);
        props.actions.focus("messages");
      })
      .catch(() => flash("no pude abrir ese mensaje (¿lo borraron o ya no tenés acceso?)"));
  }

  /** Mouse sobre una reacción: "💯 Ramiro, Celes +3" arriba del cuadro de texto. */
  let hoveredReaction = "";
  function showReactionUsers(messageId: string, emoji: { id: string | null; name: string; label: string; count: number } | null): void {
    const id = channelId();
    const key = emoji ? `${messageId}:${emoji.id ?? emoji.name}` : "";
    hoveredReaction = key;
    if (!emoji || id === null || !props.actions.reactionUsers) return;
    void props.actions
      .reactionUsers(id, messageId, emoji)
      .then((names) => {
        if (hoveredReaction !== key || names.length === 0) return;
        const shown = names.slice(0, 6);
        const rest = Math.max(emoji.count, names.length) - shown.length;
        flash(`${emoji.label} ${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`);
      })
      .catch(() => {
        if (hoveredReaction === key) flash("no pude ver quién reaccionó");
      });
  }

  /** Suma un adjunto al mensaje que vas a mandar; false si no se pudo (al editar no se suman). */
  function addAttachment(file: PendingAttachment): boolean {
    const id = channelId();
    if (id === null) return false;
    if (editing() !== null) {
      flash("al editar solo podés sacar adjuntos; para sumar uno, mandalo en un mensaje nuevo");
      return false;
    }
    setAttachments((previous) => ({ ...previous, [id]: [...(previous[id] ?? []), file] }));
    return true;
  }

  const mentionState = () => {
    const id = channelId();
    if (!insert() || id === null || mentionClosed()) return null;
    const query = mentionQueryAt(currentText(), currentCursor());
    if (query === null) return null;
    const candidates = mentionCandidates(props.store.getState(), id, query.query);
    if (candidates.length === 0) return null;
    return { ...query, candidates };
  };

  function pickMention(index: number = mentionIndex()): boolean {
    const popup = mentionState();
    if (!popup) return false;
    const candidate = popup.candidates[Math.min(index, popup.candidates.length - 1)];
    if (!candidate) return false;
    const next = applyPick(currentText(), popup.start, currentCursor(), candidate.label, candidate.userId, currentMentions());
    setText(next.text, next.mentions, next.cursor);
    setMentionIndex(0);
    return true;
  }

  function switcherItems() {
    return rankSwitcherItems(props.store.getState(), switcherQuery());
  }

  function openFromSwitcher(): void {
    const item = switcherItems()[switcherIndex()];
    setSwitcherOpen(false);
    setSwitcherQuery("");
    setSwitcherIndex(0);
    if (!item) return;
    goToChannel(item.channelId);
  }

  function goToChannel(id: string): void {
    const state = props.store.getState();
    const channel = state.channels[id];
    if (!channel) return;
    props.store.dispatch({ type: "ui/selectGuild", id: channel.guildId ?? "@dms" });
    props.store.dispatch({ type: "ui/selectChannel", id });
    setSelectedId(null);
    void props.actions.openChannel(id).catch(() => {});
    props.actions.focus("messages");
    if (channel.type === 2) flash("chat del canal de voz · v entra a la llamada");
  }

  function moveGuild(delta: number): void {
    const state = props.store.getState();
    const ids = ["@dms", ...state.guildOrder];
    const index = Math.max(0, ids.indexOf(state.ui.selectedGuildId ?? "@dms"));
    const next = ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) props.actions.selectGuild(next);
  }

  function jumpGuild(toEnd: boolean): void {
    const state = props.store.getState();
    const ids = ["@dms", ...state.guildOrder];
    const next = toEnd ? ids.at(-1) : ids[0];
    if (next !== undefined) props.actions.selectGuild(next);
  }

  function channelRows() {
    const state = props.store.getState();
    if (state.ui.selectedGuildId === null) return [];
    return selectVisibleChannelList(state, state.ui.selectedGuildId).filter((row) => row.kind !== "category");
  }

  function participantsOf(channelId: string | null): string[] {
    const state = props.store.getState();
    const channel = channelId ? state.channels[channelId] : undefined;
    if (!channel || channel.type !== 2 || channel.guildId === null) return [];
    return selectVoiceParticipants(state, channel.guildId, channel.id).map((p) => p.userId);
  }

  /** j/k en la lista de canales; en un canal de voz recorre también sus participantes (para el volumen). */
  function moveChannel(delta: number): void {
    const rows = channelRows();
    if (rows.length === 0) return;
    const current = props.store.getState().ui.selectedChannelId;
    const users = participantsOf(current);
    const at = participant() === null ? -1 : users.indexOf(participant()!);
    if (delta > 0 && at + 1 < users.length) return void setParticipant(users[at + 1]!);
    if (delta < 0 && at > 0) return void setParticipant(users[at - 1]!);
    if (delta < 0 && at === 0) return void setParticipant(null);
    setParticipant(null);
    const index = rows.findIndex((row) => row.id === current);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (index === -1 ? -1 : index) + delta))] ?? rows[0];
    if (!next) return;
    props.store.dispatch({ type: "ui/selectChannel", id: next.id });
    if (delta < 0) {
      const previousUsers = participantsOf(next.id);
      if (previousUsers.length > 0 && next.id !== current) setParticipant(previousUsers.at(-1)!);
    }
  }

  function nudgeVolume(delta: number, target: string | null = participant()): void {
    const userId = target;
    const state = props.store.getState();
    if (userId === null || userId === state.me?.id) return;
    const current = state.settings.userVolumes[userId] ?? 100;
    const next = Math.max(0, Math.min(200, current + delta));
    props.store.dispatch({ type: "settings/set", patch: { userVolumes: { ...state.settings.userVolumes, [userId]: next } } });
    flash(`volumen de ${displayName(state, userId, state.channels[state.ui.selectedChannelId ?? ""]?.guildId ?? null)}: ${next} %`);
  }

  function jumpChannel(toEnd: boolean): void {
    const rows = channelRows();
    const next = toEnd ? rows.at(-1) : rows[0];
    if (next) props.store.dispatch({ type: "ui/selectChannel", id: next.id });
  }

  /** El canal abierto es un foro: el panel de mensajes muestra sus posts. */
  function openForumId(): string | null {
    const id = channelId();
    const type = id === null ? undefined : props.store.getState().channels[id]?.type;
    return id !== null && type !== undefined && FORUM_TYPES.has(type) ? id : null;
  }

  /** Lo que j/k recorre en el panel de mensajes: los mensajes, o los posts si es un foro. */
  function messageIds(): string[] {
    const id = channelId();
    if (id === null) return [];
    if (openForumId() !== null) return selectForumPosts(props.store.getState(), id).map((post) => post.id);
    return selectMessages(props.store.getState(), id).map((message) => message.id);
  }

  /** gn o la barra "↑ N+ mensajes nuevos": trae historial (solo por esta acción) hasta el primero sin leer y lo selecciona. */
  async function jumpToUnread(): Promise<void> {
    const id = channelId();
    if (id === null) return;
    // 9 páginas de 50 + la primera: lo que entra en los 500 mensajes que guarda el canal.
    for (let page = 0; page < 9; page += 1) {
      const state = props.store.getState();
      if (state.ui.selectedChannelId !== id || !selectUnreadView(state, id).missing) break;
      const oldest = state.messages[id]?.ids[0];
      try {
        await props.actions.loadOlder(id);
      } catch {
        break;
      }
      if (props.store.getState().messages[id]?.ids[0] === oldest) break;
    }
    const state = props.store.getState();
    if (state.ui.selectedChannelId !== id) return;
    const view = selectUnreadView(state, id);
    if (view.firstUnreadId !== null) {
      setSelectedId(view.firstUnreadId);
      props.actions.focus("messages");
    } else if (view.missing) {
      const oldest = state.messages[id]?.ids[0];
      if (oldest) setSelectedId(oldest);
      props.actions.focus("messages");
      flash("hay más mensajes nuevos de los que entran: te dejo en el más viejo cargado");
    } else {
      flash("no hay mensajes nuevos en este canal");
    }
  }

  function moveMessage(delta: number): void {
    const id = channelId();
    if (id === null) return;
    const ids = messageIds();
    if (ids.length === 0) return;
    if (openForumId() !== null) {
      // Posts: de arriba (el más activo) hacia abajo.
      const index = selectedId() === null ? -1 : ids.indexOf(selectedId()!);
      setSelectedId(ids[Math.min(ids.length - 1, Math.max(0, index + delta))] ?? null);
      return;
    }
    const current = selectedId();
    if (current === null) {
      if (delta < 0) setSelectedId(ids.at(-1)!);
      return;
    }
    const index = ids.indexOf(current);
    if (index <= 0 && delta < 0) {
      void props.actions.loadOlder(id).catch(() => {});
      return;
    }
    const nextIndex = index + delta;
    if (nextIndex >= ids.length) {
      setSelectedId(null);
      return;
    }
    const next = ids[Math.max(0, nextIndex)];
    if (next) setSelectedId(next);
  }

  function focusChannels(): void {
    props.actions.focus("channels");
    const state = props.store.getState();
    if (state.ui.selectedGuildId === null) return;
    const rows = selectChannelList(state, state.ui.selectedGuildId);
    // Si el canal elegido es de otro servidor (o de los DMs), se elige el primero de esta lista.
    if (state.ui.selectedChannelId !== null && rows.some((row) => row.id === state.ui.selectedChannelId)) return;
    const first = rows.find((row) => isOpenable(row.kind));
    if (first) props.store.dispatch({ type: "ui/selectChannel", id: first.id });
  }

  function openSelected(): void {
    const state = props.store.getState();
    if (state.ui.focus === "guilds") {
      focusChannels();
      return;
    }
    const id = state.ui.selectedChannelId;
    if (id === null) return;
    if (state.channels[id]?.type === 2 && state.ui.focus === "channels") {
      // Enter/l en un canal de voz abre su chat sin entrar a la llamada (para entrar: v, 🎧 o doble click).
      void props.actions.openChannel(id).catch(() => {});
      props.actions.focus("messages");
      if (state.voice.channelId !== id) flash("chat del canal de voz · v entra a la llamada");
      return;
    }
    const post = selectedId();
    if (state.ui.focus === "messages" && openForumId() !== null && post !== null) {
      goToChannel(post);
      return;
    }
    setSelectedId(null);
    void props.actions.openChannel(id).catch(() => {});
    props.actions.focus("messages");
  }

  /** Segunda v dentro de este tiempo: recién ahí se sale de la llamada. */
  const LEAVE_CONFIRM_MS = 2000;
  let lastLeaveV = 0;
  /** Primera Ctrl+R con algo que se perdería: la segunda dentro de LEAVE_CONFIRM_MS recarga. */
  let lastReload = 0;

  /** Lo que una recarga tira sin guardar: borradores, adjuntos pendientes y tu transmisión. */
  function reloadLosses(): string[] {
    const lost: string[] = [];
    if (Object.values(drafts()).some((text) => text.trim().length > 0)) lost.push("el borrador");
    const files = Object.values(attachments()).reduce((n, list) => n + list.length, 0);
    if (files > 0) lost.push(files === 1 ? "1 adjunto" : `${files} adjuntos`);
    const stream = props.store.getState().voice.stream.status;
    if (stream === "live" || stream === "starting") lost.push("la transmisión");
    return lost;
  }

  function closeComposer(): void {
    setReplyTo(null);
    setEditing(null);
    setEditAttachments(null);
    editAttachmentsChanged.value = false;
    setInsert(false);
    setMentionClosed(false);
  }

  function clearComposer(): void {
    const id = channelId();
    if (id !== null) {
      setDrafts((previous) => ({ ...previous, [id]: "" }));
      setMentions((previous) => ({ ...previous, [id]: [] }));
      setCursors((previous) => ({ ...previous, [id]: 0 }));
      setAttachments((previous) => ({ ...previous, [id]: [] }));
    }
    closeComposer();
    setHint(null);
  }

  async function submitComposer(): Promise<void> {
    const id = channelId();
    if (id === null) return;
    const text = currentText();
    const files = currentAttachments();
    const kept = editAttachments();
    const validation = validateOutgoing(text, editing() !== null ? kept?.length ?? 0 : files.length);
    if (!validation.ok) {
      if (validation.reason === "too_long") flash("el mensaje pasa de 2000 caracteres");
      else if (editing() !== null) flash("el mensaje no puede quedar vacío; para borrarlo: Esc y dd");
      return;
    }
    const content = serializeComposer(text, currentMentions());

    if (editing() !== null) {
      const editId = editing()!;
      try {
        await props.actions.edit(id, editId, content, editAttachmentsChanged.value ? (kept ?? []).map((a) => a.id) : undefined);
      } catch {
        flash("no se pudo editar");
        return;
      }
      clearComposer();
      setInsert(true); // como Discord: el cuadro sigue listo para escribir
      return;
    }

    const reply = replyTo();
    const opts: { replyTo?: string; attachments?: PendingAttachment[] } = {};
    if (reply !== null) opts.replyTo = reply;
    if (files.length > 0) opts.attachments = files;
    clearComposer();
    setInsert(true); // como Discord: después de mandar seguís escribiendo, sin volver a hacer click (Esc sale)
    setSelectedId(null);
    await props.actions.send(id, content, opts);
  }

  function retryFirstFailed(): void {
    const id = channelId();
    if (id === null) return;
    const failed = Object.values(props.store.getState().outbox).find(
      (item) => item.channelId === id && item.state === "failed",
    );
    if (failed) void props.actions.retry(failed.nonce);
    else flash("no hay envíos fallidos");
  }

  function selectedMessage(): any | undefined {
    const id = channelId();
    if (id === null || selectedId() === null) return undefined;
    return props.store.getState().messages[id]?.byId[selectedId()!];
  }

  function startEdit(): void {
    const id = channelId();
    if (id === null) return;
    if (selectedId() === null) {
      flash("seleccioná un mensaje con k");
      return;
    }
    const message = selectedMessage();
    if (!message || message.author?.id !== props.store.getState().me?.id) {
      flash("solo podés editar o borrar tus mensajes");
      return;
    }
    setEditing(selectedId());
    setReplyTo(null);
    const existing = Array.isArray(message.attachments) ? message.attachments : [];
    setEditAttachments(
      existing
        .filter((a: any) => typeof a?.id === "string")
        .map((a: any) => ({ id: a.id, filename: String(a.filename ?? "archivo"), size: Number(a.size ?? 0) })),
    );
    editAttachmentsChanged.value = false;
    const guildId = props.store.getState().channels[id]?.guildId ?? null;
    const draft = composerFromContent(String(message.content ?? ""), (userId) => displayName(props.store.getState(), userId, guildId));
    setText(draft.text, draft.mentions);
    setInsert(true);
  }

  function requestDelete(): void {
    if (selectedId() === null) {
      flash("seleccioná un mensaje con k");
      return;
    }
    const now = Date.now();
    if (now - lastD() < 500) {
      const message = selectedMessage();
      if (!message || message.author?.id !== props.store.getState().me?.id) {
        flash("solo podés editar o borrar tus mensajes");
        setLastD(0);
        return;
      }
      setConfirmDelete(selectedId());
      setLastD(0);
      return;
    }
    setLastD(now);
  }

  function startReply(): void {
    const id = channelId();
    if (id === null || !isTextChannel()) return;
    const target = selectedId() ?? selectMessages(props.store.getState(), id).at(-1)?.id ?? null;
    if (target === null) return;
    setEditing(null);
    setReplyTo(target);
    setInsert(true);
  }

  function pickerMatches() {
    const query = pickerQuery().toLowerCase();
    const state = props.store.getState();
    const id = channelId();
    const guildId = id ? state.channels[id]?.guildId ?? null : null;
    const custom = guildId
      ? (state.guilds[guildId]?.emojis ?? [])
          .filter((emoji) => emoji.name.toLowerCase().includes(query))
          .map((emoji) => ({ name: emoji.name, char: `:${emoji.name}:`, id: emoji.id as string | null }))
      : [];
    const common = COMMON_EMOJI.filter((emoji) => emoji.name.includes(query) || emoji.char === pickerQuery()).map(
      (emoji) => ({ ...emoji, id: null as string | null }),
    );
    return [...common, ...custom];
  }

  function togglePickedReaction(index = 0): void {
    const id = channelId();
    const target = selectedId() ?? (id ? selectMessages(props.store.getState(), id).at(-1)?.id ?? null : null);
    if (id === null || target === null) {
      flash("seleccioná un mensaje");
      return;
    }
    const match = pickerMatches()[index];
    if (match) {
      const emoji = match.id ? { id: match.id, name: match.name } : { id: null, name: match.char };
      void props.actions.toggleReaction(id, target, emoji).catch(() => {});
    }
    setPickerOpen(false);
    setPickerQuery("");
  }

  /** Adjunta archivos por ruta (pegados o copiados desde un gestor de archivos); avisa los que no se pudieron. */
  async function attachPaths(paths: string[]): Promise<number> {
    let added = 0;
    const failed: string[] = [];
    for (const path of paths) {
      try {
        if (!addAttachment(await deps().readAttachmentFromPath(path))) return added;
        added += 1;
      } catch (error) {
        failed.push(`${path.split("/").pop()}: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    if (failed.length > 0) flash(`no se pudo adjuntar ${failed.join(", ")}`);
    if (added > 0) setInsert(true);
    return added;
  }

  /** Ctrl-v / 📋: archivos copiados → imagen → texto, en ese orden. */
  async function pasteFromClipboard(): Promise<void> {
    flash("📋 leyendo el portapapeles…");
    const files = (await deps().readClipboardFiles?.()) ?? [];
    log.info("clipboard.paste", { msg: "files", count: files.length });
    if (files.length > 0) {
      const added = await attachPaths(files);
      if (added > 0) {
        if (added === files.length) flash(added === 1 ? `📎 pegado: ${files[0]!.split("/").pop()}` : `📎 pegados ${added} archivos`);
        return;
      }
    }
    const image = await deps().readClipboardImage();
    log.info("clipboard.paste", { msg: image ? `image ${image.mime}` : "no image", count: image?.bytes.byteLength ?? 0 });
    if (image) {
      if (image.bytes.byteLength > MAX_UPLOAD_BYTES) {
        flash("la imagen del portapapeles pesa más de 10 MiB");
        return;
      }
      if (!addAttachment({ filename: image.filename, mime: image.mime, bytes: image.bytes })) return;
      setInsert(true);
      flash(`📎 pegada la imagen ${image.filename} (${formatBytes(image.bytes.byteLength)}) · Enter la manda`);
      return;
    }
    const text = await deps().readClipboardText();
    if (text) {
      setInsert(true);
      insertText(text);
      flash(`📋 pegado texto (${[...text].length} caracteres)`);
    } else flash("el portapapeles está vacío (ni archivos, ni imagen, ni texto)");
  }

  async function finishAttachPrompt(): Promise<void> {
    const path = attachPrompt() ?? "";
    setAttachPrompt(null);
    if (path.trim().length === 0) return;
    try {
      addAttachment(await deps().readAttachmentFromPath(path));
      setHint(null);
      setInsert(true);
    } catch (error) {
      flash(`no se pudo adjuntar: ${error instanceof Error ? error.message : "error"}`);
    }
  }

  /** 1-9 sobre un mensaje con encuesta: vota la respuesta N (en el orden en que se muestran). */
  function votePollKey(n: number): void {
    const id = channelId();
    const message = selectedMessage() as { id: string; poll?: ApiPoll } | undefined;
    if (id === null || !message?.poll) return;
    const answer = (message.poll.answers ?? []).filter((a) => typeof a?.answer_id === "number")[n - 1];
    if (answer) void props.actions.votePoll?.(id, message.id, answer.answer_id!).catch(() => {});
  }

  /** Barra de acciones de un mensaje (click): igual que r / e / dd / +. */
  function messageAction(action: MessageAction, messageId: string): void {
    setSelectedId(messageId);
    props.actions.focus("messages");
    if (action === "reply") return startReply();
    if (action === "edit") return startEdit();
    if (action === "react") {
      setPickerOpen(true);
      setPickerQuery("");
      setPickerIndex(0);
      return;
    }
    const message = selectedMessage();
    if (!message || message.author?.id !== props.store.getState().me?.id) {
      flash("solo podés editar o borrar tus mensajes");
      return;
    }
    setConfirmDelete(messageId);
  }

  function confirmDeleteNow(yes: boolean): void {
    const id = channelId();
    const messageId = confirmDelete();
    if (yes && id !== null && messageId !== null) void props.actions.remove(id, messageId).catch(() => {});
    setConfirmDelete(null);
    if (yes) setSelectedId(null);
  }

  /** Click en un miembro: lo menciona en el composer (sale como <@id> al mandar). */
  function mentionMember(userId: string): void {
    const state = props.store.getState();
    const id = channelId();
    if (id === null || !isTextChannel()) return;
    const label = displayName(state, userId, state.channels[id]?.guildId ?? null);
    const at = currentCursor();
    const before = currentText().slice(0, at);
    const glue = before.length === 0 || /\s$/.test(before) ? "" : " ";
    const start = at + glue.length;
    const next = splice(currentText(), at, at, `${glue}@${label} `);
    const shifted = replaceMentions(currentMentions(), at, at, next.cursor - at);
    const picked = [...shifted, { start, end: start + label.length + 1, userId }].sort((a, b) => a.start - b.start);
    setText(next.text, picked, next.cursor);
    setInsert(true);
  }

  function startComposer(): void {
    if (!isTextChannel()) {
      flash("abrí un canal de texto para escribir");
      return;
    }
    setInsert(true);
    props.actions.focus("messages");
  }

  function printable(key: KeyEvent): string | null {
    if (key.ctrl || key.meta) return null;
    if (key.name === "space") return " ";
    return key.sequence.length > 0 && [...key.sequence].length === 1 && key.sequence >= " " ? key.sequence : null;
  }

  usePaste((event: PasteEvent) => {
    const text = new TextDecoder().decode(event.bytes);
    log.info("ui.paste", { count: event.bytes.byteLength });
    // Pegado de la terminal (Ctrl+Shift+V): si son rutas de archivos se adjuntan; si viene vacío (la terminal
    // no puede pegar imágenes como texto) se mira si el portapapeles tiene una imagen.
    if (attachPrompt() === null && !switcherOpen() && isTextChannel()) {
      const paths = filePathsFromPastedText(text);
      if (paths.length > 0) return void attachPaths(paths);
      if (text.trim().length === 0) return void pasteFromClipboard();
    }
    if (attachPrompt() !== null) {
      setAttachPrompt((previous) => (previous ?? "") + text.replace(/\n/g, ""));
      return;
    }
    if (switcherOpen()) {
      setSwitcherQuery((previous) => previous + text.replace(/\n/g, " "));
      return;
    }
    if (!isTextChannel()) return;
    setInsert(true);
    insertText(text);
  });

  useKeyboard(
    (key) => {
      // Push-to-talk: solo Espacio; los release siempre llegan para no quedar transmitiendo.
      if (key.eventType === "release") {
        if (key.name === "space") props.actions.voice?.pttKey({ name: "space", eventType: "release" });
        return;
      }
      props.onActivity?.();
      // Ctrl+R recarga zcord (código nuevo, sin salir de la terminal): funciona en cualquier modo. Si hay algo que
      // se perdería (borrador, adjuntos, tu transmisión), pide una segunda Ctrl+R, como v con la llamada.
      if (key.ctrl && key.name === "r" && props.onReload) {
        const lost = reloadLosses();
        const now = Date.now();
        if (lost.length > 0 && now - lastReload > LEAVE_CONFIRM_MS) {
          lastReload = now;
          flash(`Ctrl+R otra vez para recargar: se pierde ${lost.join(", ")}`);
          return;
        }
        lastReload = 0;
        flash("recargando zcord…");
        props.onReload();
        return;
      }
      // Diagnóstico del pegado: solo teclas con Ctrl/Alt o sin nombre (nunca lo que se escribe).
      if (key.ctrl || key.meta || !key.name) {
        log.info("ui.key", { msg: JSON.stringify({ name: key.name, ctrl: key.ctrl, meta: key.meta, shift: key.shift, raw: key.raw ?? key.sequence }) });
      }
      if (settingsOpen() || statusMenuOpen() || monitorChoices() !== null || outputChoices() !== null) return;

      if (helpOpen()) {
        if (key.name === "escape" || key.name === "q" || (key.name === "?" && !key.ctrl && !key.meta)) return void setHelpOpen(false);
        const step = key.name === "j" || key.name === "down" ? 1 : key.name === "k" || key.name === "up" ? -1 : key.name === "pagedown" || key.name === "space" ? 10 : key.name === "pageup" ? -10 : 0;
        if (step !== 0) setHelpScroll((n) => n + step);
        if (key.name === "g" || key.name === "home") setHelpScroll(-1e6);
        return;
      }

      if (inboxOpen()) {
        const count = inboxItems()?.length ?? 0;
        if (key.name === "escape" || key.name === "q" || key.sequence === "@") return void setInboxOpen(false);
        if ((key.name === "j" || key.name === "down") && count > 0) return void setInboxIndex((i) => Math.min(count - 1, i + 1));
        if ((key.name === "k" || key.name === "up") && count > 0) return void setInboxIndex((i) => Math.max(0, i - 1));
        if (key.name === "return" && count > 0) return void goToMention(inboxIndex());
        return;
      }

      if (switcherOpen()) {
        if (key.name === "escape") {
          setSwitcherOpen(false);
          setSwitcherQuery("");
          return;
        }
        if (key.name === "return") return openFromSwitcher();
        const moved = moveInList(key, switcherIndex(), switcherItems().length, SWITCHER_ROWS);
        if (moved !== null) return void setSwitcherIndex(moved);
        if (key.name === "backspace") {
          setSwitcherQuery((q) => q.slice(0, -1));
          setSwitcherIndex(0);
          return;
        }
        const ch = printable(key);
        if (ch !== null) {
          setSwitcherQuery((q) => q + ch);
          setSwitcherIndex(0);
        }
        return;
      }

      // En el composer Ctrl-k borra hasta el fin de línea (como en la shell); en modo normal abre el switcher.
      if (key.ctrl && key.name === "k" && !insert()) {
        setSwitcherOpen(true);
        setSwitcherQuery("");
        setSwitcherIndex(0);
        return;
      }

      if (attachPrompt() !== null) {
        if (key.name === "escape") return void setAttachPrompt(null);
        if (key.name === "return") return void finishAttachPrompt();
        if (key.name === "backspace") return void setAttachPrompt((p) => (p ?? "").slice(0, -1));
        const ch = printable(key);
        if (ch !== null) setAttachPrompt((p) => (p ?? "") + ch);
        return;
      }

      if (pickerOpen()) {
        if (key.name === "escape") {
          setPickerOpen(false);
          setPickerQuery("");
          return;
        }
        if (key.name === "return") return togglePickedReaction(pickerIndex());
        const moved = moveInList(key, pickerIndex(), pickerMatches().length, PICKER_ROWS);
        if (moved !== null) return void setPickerIndex(moved);
        if (key.name === "backspace") {
          setPickerIndex(0);
          return void setPickerQuery((previous) => previous.slice(0, -1));
        }
        const ch = printable(key);
        if (ch !== null) {
          setPickerIndex(0);
          setPickerQuery((previous) => previous + ch);
        }
        return;
      }

      if (confirmDelete() !== null) {
        if (key.name === "y") return confirmDeleteNow(true);
        if (key.name === "n" || key.name === "escape") confirmDeleteNow(false);
        return;
      }

      if (insert()) {
        const popup = mentionState();
        if (key.name === "escape") {
          if (popup) {
            setMentionClosed(true);
            return;
          }
          if (editing() !== null) clearComposer();
          else closeComposer();
          return;
        }
        if (popup && (key.name === "tab" || key.name === "return")) {
          pickMention();
          return;
        }
        if (popup && (key.name === "down" || (key.ctrl && key.name === "n"))) {
          setMentionIndex((i) => Math.min(popup.candidates.length - 1, i + 1));
          return;
        }
        if (popup && (key.name === "up" || (key.ctrl && key.name === "p"))) {
          setMentionIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "return") {
          if (key.shift || key.option || key.meta) insertText("\n");
          else void submitComposer();
          return;
        }
        const text = currentText();
        const at = currentCursor();
        const word = key.ctrl || key.meta;
        if (key.name === "left") return moveCursor(word ? wordLeft(text, at) : prevGrapheme(text, at));
        if (key.name === "right") return moveCursor(word ? wordRight(text, at) : nextGrapheme(text, at));
        if (key.meta && key.name === "b") return moveCursor(wordLeft(text, at));
        if (key.meta && key.name === "f") return moveCursor(wordRight(text, at));
        if (key.name === "home" || (key.ctrl && key.name === "a")) return moveCursor(lineStart(text, at));
        if (key.name === "end" || (key.ctrl && key.name === "e")) return moveCursor(lineEnd(text, at));
        if (key.name === "up") return moveCursor(lineUp(text, at));
        if (key.name === "down") return moveCursor(lineDown(text, at));
        if (key.name === "backspace") return deleteTo(word ? wordLeft(text, at) : prevGrapheme(text, at));
        if (key.name === "delete") return deleteTo(word ? wordRight(text, at) : nextGrapheme(text, at));
        if (key.ctrl && key.name === "v") return void pasteFromClipboard();
        if (key.ctrl && key.name === "w") return deleteTo(ruboutStart(text, at));
        if (key.ctrl && key.name === "u") return deleteTo(lineStart(text, at));
        if (key.ctrl && key.name === "k") {
          const end = lineEnd(text, at);
          // Al final de una línea, Ctrl-k junta la siguiente (borra el salto), como en Emacs.
          return deleteTo(end === at && at < text.length ? at + 1 : end);
        }
        const ch = printable(key);
        if (ch !== null) insertText(ch);
        return;
      }

      // Push-to-talk en modo normal: el press.
      if (key.name === "space") {
        props.actions.voice?.pttKey({ name: "space", eventType: key.eventType === "repeat" || key.repeated ? "repeat" : "press", repeated: key.repeated });
        return;
      }

      const focused = props.store.getState().ui.focus;

      // Mantener apretada una tecla repite el evento: solo la navegación se repite, los toggles no.
      const navigation = ["j", "k", "up", "down", "h", "l", "left", "right", "backspace"];
      if (key.repeated && !navigation.includes(key.name)) return;

      if (pendingG()) {
        setPendingG(false);
        switch (key.name) {
          case "s":
            setSettingsOpen(true);
            return;
          case "p":
            setStatusMenuOpen(true);
            return;
          case "m":
            props.actions.toggleMembers();
            return;
          case "n":
            void jumpToUnread();
            return;
          case "u": {
            const next = selectNextUnread(props.store.getState(), channelId());
            if (next) goToChannel(next);
            else flash("no hay canales sin leer");
            return;
          }
          case "g":
            if (focused === "messages") {
              const id = channelId();
              const first = messageIds()[0];
              if (first) setSelectedId(first);
              if (id) void props.actions.loadOlder(id).catch(() => {});
            } else if (focused === "channels") jumpChannel(false);
            else jumpGuild(false);
            return;
          default:
            break;
        }
      }

      if (key.ctrl && key.name === "v") {
        if (isTextChannel()) void pasteFromClipboard();
        return;
      }

      switch (key.name) {
        case "g":
          if (key.shift) {
            if (focused === "messages") toBottom();
            else if (focused === "channels") jumpChannel(true);
            else jumpGuild(true);
            return;
          }
          setPendingG(true);
          return;
        case "?":
          setHelpOpen(true);
          return;
        case "q":
          props.onQuit();
          return;
        case "escape":
          if (watching()) return void props.actions.voice?.stopWatching?.();
          if (focused === "messages") toBottom();
          setHint(null);
          return;
        case "w":
          if (!key.ctrl && !key.meta && !key.shift) watchPress();
          return;
        case "i":
          if (!isTextChannel()) {
            flash("abrí un canal de texto para escribir");
            return;
          }
          setInsert(true);
          props.actions.focus("messages");
          return;
        case "j":
        case "down":
          if (focused === "messages") moveMessage(1);
          else if (focused === "channels") moveChannel(1);
          else moveGuild(1);
          return;
        case "k":
        case "up":
          if (focused === "messages") moveMessage(-1);
          else if (focused === "channels") moveChannel(-1);
          else moveGuild(-1);
          return;
        case "h":
        case "left":
          setParticipant(null);
          if (focused === "messages") props.actions.focus("channels");
          else props.actions.focus("guilds");
          return;
        case "l":
        case "right":
          if (focused === "channels") openSelected();
          else if (focused === "guilds") focusChannels();
          else if (focused === "messages") {
            if (!isTextChannel()) flash("abrí un canal de texto para escribir");
            else setInsert(true);
          }
          return;
        case "return":
          openSelected();
          return;
        case "r":
          if (key.shift) return retryFirstFailed();
          startReply();
          return;
        case "e":
          startEdit();
          return;
        case "s":
          if (key.shift) void streamPress();
          return;
        case "d":
          if (key.shift) {
            props.actions.voice?.toggleDeaf();
            return;
          }
          requestDelete();
          return;
        case "m":
          if (key.shift) props.actions.voice?.toggleInputMode();
          else props.actions.voice?.toggleMute();
          return;
        case "v": {
          const id = channelId();
          const state = props.store.getState();
          // Estando en una llamada, v te saca (o te cambia de canal): pide una segunda v para no cortar
          // la llamada ni la transmisión por una tecla suelta.
          if (state.voice.channelId !== null) {
            const now = Date.now();
            if (now - lastLeaveV > LEAVE_CONFIRM_MS) {
              lastLeaveV = now;
              const switching = id !== null && state.channels[id]?.type === 2 && id !== state.voice.channelId;
              flash(switching ? "apretá v otra vez para cambiarte a este canal de voz" : "apretá v otra vez para salir de la llamada");
              return;
            }
            lastLeaveV = 0;
          }
          if (id !== null && state.channels[id]?.type === 2) void props.actions.voice?.toggleVoice(id);
          else if (state.voice.channelId !== null) void props.actions.voice?.leaveVoice();
          else flash("seleccioná un canal 🔊 para entrar a voz");
          return;
        }
        case "a": {
          const forum = openForumId();
          if (forum !== null) return void props.actions.loadArchivedPosts?.(forum).catch(() => {});
          if (!isTextChannel()) return;
          setAttachPrompt("");
          return;
        }
        case "p": {
          // p: escuchar (o parar) el audio / mensaje de voz del mensaje seleccionado.
          const message = selectedMessage();
          const audio = (Array.isArray(message?.attachments) ? message.attachments : []).find((a: any) => isAudioAttachment(a));
          if (!audio) {
            flash(selectedId() === null ? "seleccioná un mensaje con un audio (k)" : "ese mensaje no tiene audio");
            return;
          }
          player.toggle(audio.id, audio.url);
          return;
        }
        case "x": {
          const count = editAttachments()?.length ?? currentAttachments().length;
          if (count > 0) removeAttachmentAt(count - 1);
          return;
        }
        default:
          break;
      }

      if (participant() !== null && focused === "channels" && (key.sequence === "+" || key.sequence === "-")) {
        nudgeVolume(key.sequence === "+" ? 10 : -10);
        return;
      }
      if (focused === "messages" && /^[1-9]$/.test(key.sequence ?? "")) {
        votePollKey(Number(key.sequence));
        return;
      }
      if (key.sequence === "+") {
        setPickerOpen(true);
        setPickerQuery("");
        setPickerIndex(0);
        return;
      }
      if (key.sequence === "?") setHelpOpen(true);
      if (key.sequence === "@") return void openInbox();
      if (key.sequence === "R") retryFirstFailed();
      if (key.sequence === "D") props.actions.voice?.toggleDeaf();
      if (key.sequence === "S") void streamPress();
      if (key.sequence === "M") props.actions.voice?.toggleInputMode();
      if (key.sequence === "G") {
        if (focused === "messages") toBottom();
        else if (focused === "channels") jumpChannel(true);
        else jumpGuild(true);
      }
    },
    { release: true },
  );

  // Seleccionar texto con el mouse (arrastrando) lo copia al soltar, como en una terminal: wl-copy y, por las dudas,
  // OSC 52 (lo toman Ghostty, Kitty y la mayoría de los multiplexores).
  const onSelection = (selection: { getSelectedText(): string } | null): void => {
    // Como las terminales: sin los espacios de relleno al final de cada línea.
    const text = (selection?.getSelectedText() ?? "").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "");
    if (text.trim().length === 0) return;
    try {
      renderer.copyToClipboardOSC52(text);
    } catch {
      // la terminal no lo soporta: queda wl-copy
    }
    void (deps().writeClipboardText ?? (async () => false))(text).then((ok) => {
      const n = [...text].length;
      flash(ok ? `📋 copiado (${n} caracteres)` : `📋 copiado por la terminal (${n} caracteres; sin wl-copy)`);
    });
  };
  renderer.on("selection", onSelection);
  onCleanup(() => renderer.off("selection", onSelection));

  onMount(() => {
    takeThemeErrors().forEach((text, i) => props.store.dispatch({ type: "notice/push", key: `theme-file-${i}`, level: "warn", text }));
  });
  onMount(() => {
    const unsubscribe = props.store.subscribe(() => {
      const state = props.store.getState();
      if (state.ui.selectedGuildId === null && state.guildOrder.length > 0) {
        props.actions.selectGuild(state.guildOrder[0]!);
      }
    });
    onCleanup(unsubscribe);
  });

  const composerContext = (): string | null => {
    const state = props.store.getState();
    const id = channelId();
    const target = replyTo() ?? editing();
    if (id === null || target === null) return null;
    const message = state.messages[id]?.byId[target];
    if (!message) return null;
    const guildId = state.channels[id]?.guildId ?? null;
    const who = displayName(state, message.author?.id ?? "", guildId);
    const text = plainText(parseMarkdown(String(message.content ?? "")));
    return editing() !== null ? `editando: ${truncate(text, 50)}` : `respondiendo a @${who}: ${truncate(text, 40)}`;
  };

  const placeholder = useSelector(props.store, (state) => {
    const id = state.ui.selectedChannelId;
    const channel = id ? state.channels[id] : undefined;
    if (!channel) return "elegí un canal";
    if (channel.type === 2) return `i para escribir en el chat de 🔊 ${channel.name}`;
    if (FORUM_TYPES.has(channel.type)) return "foro · abrí un post con click o j/k y Enter para escribir";
    if (channel.thread !== undefined) return `i para escribir en 🧵 ${channel.name}`;
    return channel.guildId === null ? `i para escribirle a @${channel.name}` : `i para escribir en #${channel.name}`;
  });

  const showMembers = (): boolean => membersVisible() && inGuild() && dims().width >= 110 && !watching();
  const centerWidth = (): number => dims().width - GUILD_WIDTH - CHANNEL_WIDTH;
  /** Video y chat lado a lado cuando el centro tiene lugar; si no, el chat va abajo del video. */
  const watchSideBySide = (): boolean => centerWidth() >= 100;
  const watchChatWidth = (): number => Math.max(40, Math.min(70, Math.round(centerWidth() * 0.34)));

  const messageView = (titleWidth: number): JSX.Element => (
    <MessageView
      store={props.store}
      theme={theme()}
      selectedId={selectedId()}
      focused={focus() === "messages"}
      images={props.images === true && inlineImages()}
      animate={animateImages()}
      avatars={showAvatars()}
      onSelect={(id) => {
        setSelectedId(id);
        props.actions.focus("messages");
      }}
      onAction={messageAction}
      onReact={(messageId, emoji) => {
        const id = channelId();
        if (id !== null) void props.actions.toggleReaction(id, messageId, emoji).catch(() => {});
      }}
      onReactionHover={(messageId, emoji) => showReactionUsers(messageId, emoji)}
      onOpen={(url) => props.actions.openUrl?.(url)}
      onVote={(messageId, answerId) => {
        const id = channelId();
        if (id !== null) void props.actions.votePoll?.(id, messageId, answerId).catch(() => {});
      }}
      onLoadOlder={() => {
        const id = channelId();
        if (id !== null) void props.actions.loadOlder(id).catch(() => {});
      }}
      onFocus={() => props.actions.focus("messages")}
      onJumpUnread={() => void jumpToUnread()}
      onJumpBottom={() => setSelectedId(null)}
      bottomTick={bottomTick()}
      onVoiceToggle={(id) => void props.actions.voice?.toggleVoice(id)}
      onOpenPost={(id) => goToChannel(id)}
      titleWidth={titleWidth}
      onLoadArchived={(id) => void props.actions.loadArchivedPosts?.(id).catch(() => {})}
      onWatch={(userId) => void props.actions.voice?.toggleWatch?.(userId)}
    />
  );

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
      <box flexDirection="row" flexGrow={1} width="100%">
        <GuildList store={props.store} actions={props.actions} theme={theme()} focused={focus() === "guilds"} />
        <ChannelList
          store={props.store}
          actions={props.actions}
          theme={theme()}
          focused={focus() === "channels"}
          selectedParticipant={focus() === "channels" ? participant() : null}
          onParticipant={(_channelId, userId) => setParticipant(userId)}
          onVolume={(userId, delta) => nudgeVolume(delta, userId)}
          images={props.images === true && inlineImages()}
          onWatch={(userId) => void props.actions.voice?.toggleWatch?.(userId)}
        />
        <Show when={watching()}>
          {/* Mirando una transmisión: el video y el chat del canal a la vez (al lado si entra, si no abajo). */}
          <box flexDirection={watchSideBySide() ? "row" : "column"} flexGrow={1} height="100%">
            <box flexGrow={1} flexDirection="row">
              <StreamViewer
                store={props.store}
                theme={theme()}
                voice={props.actions.voice}
                focused={focus() === "messages"}
                titleWidth={Math.max(10, Math.min(60, centerWidth() - (watchSideBySide() ? watchChatWidth() : 0) - 6))}
              />
            </box>
            <box
              width={watchSideBySide() ? watchChatWidth() : "100%"}
              height={watchSideBySide() ? "100%" : "40%"}
              flexShrink={0}
              flexDirection="row"
            >
              {messageView(Math.max(10, watchChatWidth() - 6))}
            </box>
          </box>
        </Show>
        <Show when={!watching()}>
          {messageView(Math.max(10, Math.min(60, centerWidth() - (showMembers() ? MEMBER_WIDTH : 0) - 6)))}
        </Show>
        <Show when={showMembers()}>
          <MemberList
            store={props.store}
            theme={theme()}
            images={props.images === true && inlineImages()}
            onMember={mentionMember}
            onNearEnd={() => {
              const id = channelId();
              if (id !== null) props.actions.loadMoreMembers?.(id);
            }}
          />
        </Show>
      </box>
      <Show when={confirmDelete() !== null}>
        <box height={1} width="100%" paddingLeft={1} flexShrink={0} flexDirection="row" columnGap={1}>
          <text fg={theme().error}>¿Borrar este mensaje? y/n</text>
          <Button label="sí, borrar" theme={theme()} danger onPress={() => confirmDeleteNow(true)} />
          <Button label="no" theme={theme()} onPress={() => confirmDeleteNow(false)} />
        </box>
      </Show>
      <Show when={pickerOpen()}>
        <EmojiPicker
          query={pickerQuery()}
          matches={pickerMatches()}
          index={pickerIndex()}
          theme={theme()}
          onPick={(i) => togglePickedReaction(i)}
          onMove={setPickerIndex}
          onClose={() => (setPickerOpen(false), setPickerQuery(""))}
        />
      </Show>
      <Show when={hint() !== null}>
        <box height={1} width="100%" paddingLeft={1} flexShrink={0}>
          <text fg={theme().warn}>{hint()}</text>
        </box>
      </Show>
      <Show when={mentionState()}>
        {(popup: () => NonNullable<ReturnType<typeof mentionState>>) => (
          <MentionPopup
            candidates={popup().candidates}
            index={mentionIndex()}
            theme={theme()}
            onPick={(i) => pickMention(i)}
            onMove={(i) => setMentionIndex(i)}
            avatar={
              showAvatars()
                ? (userId) => {
                    if (props.images !== true || !inlineImages()) return null;
                    const state = props.store.getState();
                    const id = channelId();
                    return userAvatarUrl(state, userId, id !== null ? state.channels[id]?.guildId ?? null : null, animateImages());
                  }
                : undefined
            }
          />
        )}
      </Show>
      <Notices store={props.store} theme={theme()} />
      <Composer
        text={currentText()}
        cursor={currentCursor()}
        insert={insert()}
        replyTo={replyTo()}
        editing={editing()}
        theme={theme()}
        placeholder={placeholder()}
        context={composerContext()}
        attachments={editAttachments()?.map((a) => ({ filename: a.filename, bytes: { byteLength: a.size } })) ?? currentAttachments()}
        prompt={attachPrompt()}
        onClick={startComposer}
        onCursor={(offset) => {
          if (isTextChannel()) moveCursor(offset);
        }}
        onAttach={textChannel() ? () => setAttachPrompt("") : undefined}
        onPaste={textChannel() ? () => void pasteFromClipboard() : undefined}
        onRemoveAttachment={(index) => removeAttachmentAt(index)}
      />
      <VoiceBar
        store={props.store}
        theme={theme()}
        actions={props.actions}
        onStream={() => void streamPress()}
        onOutput={
          props.actions.voice?.listOutputs
            ? () => void props.actions.voice!.listOutputs!().then((choices) => setOutputChoices(choices))
            : undefined
        }
      />
      <StatusBar
        store={props.store}
        theme={theme()}
        mode={insert() || attachPrompt() !== null ? "INSERT" : "NORMAL"}
        onHelp={() => setHelpOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onStatus={() => setStatusMenuOpen(true)}
        onMentions={props.actions.mentionsInbox ? openInbox : undefined}
        onSwitcher={() => {
          setSwitcherOpen(true);
          setSwitcherQuery("");
          setSwitcherIndex(0);
        }}
      />
      <Show when={switcherOpen()}>
        <QuickSwitcher
          query={switcherQuery()}
          items={switcherItems()}
          index={switcherIndex()}
          theme={theme()}
          onPick={(i) => {
            setSwitcherIndex(i);
            openFromSwitcher();
          }}
          onMove={setSwitcherIndex}
          onClose={() => {
            setSwitcherOpen(false);
            setSwitcherQuery("");
          }}
        />
      </Show>
      <Show when={inboxOpen()}>
        <MentionsInbox
          items={inboxItems()}
          error={inboxError()}
          index={inboxIndex()}
          theme={theme()}
          onPick={goToMention}
          onMove={setInboxIndex}
          onClose={() => setInboxOpen(false)}
        />
      </Show>
      <Show when={statusMenuOpen()}>
        <StatusMenu
          current={props.store.getState().settings.status}
          theme={theme()}
          onPick={(status) => {
            setStatusMenuOpen(false);
            props.actions.setStatus?.(status);
          }}
          onClose={() => setStatusMenuOpen(false)}
        />
      </Show>
      <Show when={outputChoices()}>
        {(choices: () => { outputs: AudioDevice[]; current: string | null; isDefault: boolean }) => (
          <OutputPicker
            outputs={choices().outputs}
            current={choices().current}
            isDefault={choices().isDefault}
            theme={theme()}
            onPick={(name) => {
              setOutputChoices(null);
              void props.actions.voice?.setOutputDevice?.(name);
            }}
            onClose={() => setOutputChoices(null)}
          />
        )}
      </Show>
      <Show when={monitorChoices()}>
        {(monitors: () => Monitor[]) => (
          <MonitorPicker
            monitors={monitors()}
            current={props.store.getState().settings.streamMonitor}
            theme={theme()}
            onPick={(name) => {
              setMonitorChoices(null);
              void props.actions.voice?.startStream?.(name);
            }}
            onClose={() => setMonitorChoices(null)}
          />
        )}
      </Show>
      <Show when={helpOpen()}>
        <HelpOverlay onClose={() => setHelpOpen(false)} theme={theme()} scroll={helpScroll()} height={dims().height} />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsScreen
          store={props.store}
          actions={props.actions}
          deps={props.settingsDeps ?? defaultSettingsDeps}
          inVoice={props.store.getState().voice.channelId !== null}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>
      <Show when={showSplash()}>
        <Splash theme={theme()} status={splashStatus(connectionState().connection, connectionState().guilds)} />
      </Show>
    </box>
  );
}
