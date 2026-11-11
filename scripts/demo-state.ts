import type { Actions } from "../src/actions";
import type { VoiceActions } from "../src/actions/voice";
import { selectChannelList } from "../src/store/selectors";
import { createStore, emptyState, type Store } from "../src/store/store";
import { seedPolls } from "./demo/polls";
import { seedUnread } from "./demo/unread";
import { seedThreads } from "./demo/threads";
import { seedPresence } from "./demo/presence";
import { seedEmoji } from "./demo/emoji";
import { demoStreamActions, seedGoLive } from "./demo/golive";
import { demoWatchActions } from "./demo/watch";

/**
 * Estado de demostración, sin red ni cuenta: sirve para mirar la UI (`bun run demo`)
 * y para los tests de render. Todos los ids y nombres son falsos.
 */
const ME = "900000000000000001";
const U = (n: number): string => `9000000000000001${String(n).padStart(2, "0")}`;
const G1 = "910000000000000001";
const G2 = "910000000000000002";
const G3 = "910000000000000003";
export const DEMO = {
  me: ME,
  guild: G1,
  general: "920000000000000002",
  voice: "920000000000000010",
  voice2: "920000000000000011",
  dm: "920000000000000100",
};

function user(id: string, username: string, globalName: string | null = null) {
  return { id, username, global_name: globalName, avatar: null, discriminator: "0" };
}

const NAMES: Record<string, [string, string]> = {};

function msg(id: number, channel: string, author: string, content: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  const [username, globalName] = NAMES[author] ?? ["alguien", "alguien"];
  return {
    id: `93000000000000${String(1000 + id)}`,
    channel_id: channel,
    guild_id: G1,
    author: { id: author, username, global_name: globalName },
    content,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    mentions: [],
    mention_everyone: false,
    referenced_message: null,
    reactions: [],
    ...extra,
  };
}

export function buildDemoStore(): Store {
  const store = createStore(emptyState());
  const users = [
    user(ME, "gon", "Gon"),
    user(U(1), "ramiro", "Ramiro"),
    user(U(2), "celes", "Celes💜"),
    user(U(3), "dfuentes", "dfuentes"),
    user(U(4), "bruno_7712", "bruno_7712"),
    user(U(5), "pepa", "Pepa"),
    user(U(6), "zero", "zero"),
  ];
  for (const u of users) NAMES[u.id] = [u.username, u.global_name ?? u.username];
  const roles = [
    { id: G1, name: "@everyone", color: 0, position: 0, permissions: "1071698660929" },
    { id: "940000000000000001", name: "Admin", color: 0xe67e22, position: 3, permissions: "8" },
    { id: "940000000000000002", name: "Devs", color: 0x3498db, position: 2, permissions: "0" },
  ];
  const ch = (id: string, name: string, type: number, position: number, parent: string | null = null) => ({
    id,
    name,
    type,
    position,
    parent_id: parent,
    permission_overwrites: [],
    last_message_id: null as string | null,
  });
  const catInfo = "920000000000000050";
  const catCom = "920000000000000051";
  const catVoice = "920000000000000052";
  const channels = [
    ch(catInfo, "📌 Información", 4, 0),
    ch("920000000000000001", "👋-bienvenida", 0, 0, catInfo),
    ch("920000000000000003", "📚-reglas", 0, 1, catInfo),
    ch(catCom, "⭐ Comunidad", 4, 1),
    ch(DEMO.general, "💬-general", 0, 0, catCom),
    ch("920000000000000004", "🎥-youtube", 0, 1, catCom),
    ch("920000000000000005", "🐸-memes", 0, 2, catCom),
    ch("920000000000000006", "👾-devland", 0, 3, catCom),
    ch(catVoice, "🔊 Coworkings", 4, 2),
    ch(DEMO.voice, "Sala 1", 2, 0, catVoice),
    ch(DEMO.voice2, "Sala 2", 2, 1, catVoice),
  ];
  channels.find((c) => c.id === "920000000000000005")!.last_message_id = "939999999999999999";
  channels.find((c) => c.id === "920000000000000006")!.last_message_id = "939999999999999998";

  store.dispatch({
    type: "gw",
    t: "READY",
    d: {
      user: user(ME, "gon", "Gon"),
      users,
      guilds: [
        {
          id: G1,
          properties: { name: "Los Andes", owner_id: ME },
          roles,
          emojis: [{ id: "950000000000000001", name: "kek", animated: false }],
          channels,
          members: [
            { user_id: U(1), roles: ["940000000000000001"], nick: null },
            { user_id: U(2), roles: ["940000000000000002"], nick: null },
            { user_id: U(3), roles: [], nick: null },
            { user_id: ME, roles: ["940000000000000001"], nick: null },
          ],
          voice_states: [
            { user_id: U(1), channel_id: DEMO.voice, self_mute: false, self_deaf: false },
            { user_id: U(2), channel_id: DEMO.voice, self_mute: true, self_deaf: false },
            { user_id: U(5), channel_id: DEMO.voice2, self_mute: false, self_deaf: true },
          ],
        },
        { id: G2, properties: { name: "Club de Programadores", owner_id: U(3) }, roles: [], channels: [ch("920000000000000200", "general", 0, 0)] },
        { id: G3, properties: { name: "Pixelandia", owner_id: U(3) }, roles: [], channels: [ch("920000000000000300", "anuncios", 0, 0)] },
      ],
      // Como lo manda Discord a una cuenta de usuario: `recipient_ids`, los usuarios van en `users`.
      private_channels: [
        { id: DEMO.dm, type: 1, recipient_ids: [U(2)], last_message_id: "939000000000000500" },
        { id: "920000000000000101", type: 3, recipient_ids: [U(1), U(3)], name: null, last_message_id: "939000000000000400" },
        { id: "920000000000000102", type: 1, recipient_ids: [U(5)], last_message_id: "939000000000000300" },
        { id: "920000000000000103", type: 3, recipient_ids: [U(1), U(2), U(4)], name: "Los del ajedrez", last_message_id: "939000000000000600" },
        { id: "920000000000000104", type: 1, recipient_ids: [U(6)], last_message_id: "939000000000000100" },
      ],
      read_state: [
        { id: "920000000000000006", last_message_id: "1", mention_count: 2 },
        { id: DEMO.dm, last_message_id: "1", mention_count: 1 },
      ],
      user_guild_settings: [],
    },
  });
  store.dispatch({ type: "connection", status: "ready" });
  store.dispatch({
    type: "gw",
    t: "READY_SUPPLEMENTAL",
    d: { merged_presences: { friends: [{ user_id: U(2), status: "online" }, { user_id: U(5), status: "idle" }, { user_id: U(6), status: "dnd" }], guilds: [] } },
  });

  store.dispatch({
    type: "gw",
    t: "GUILD_MEMBER_LIST_UPDATE",
    d: {
      guild_id: G1,
      id: "everyone",
      ops: [
        {
          op: "SYNC",
          range: [0, 99],
          items: [
            { group: { id: "940000000000000001", count: 2 } },
            { member: { user: users[0], roles: ["940000000000000001"], presence: { status: "online" } } },
            { member: { user: users[1], roles: ["940000000000000001"], presence: { status: "online" } } },
            { group: { id: "online", count: 2 } },
            { member: { user: users[2], roles: ["940000000000000002"], presence: { status: "idle" } } },
            { member: { user: users[3], roles: [], presence: { status: "dnd" } } },
            { group: { id: "offline", count: 2 } },
            { member: { user: users[4], roles: [] } },
            { member: { user: users[5], roles: [] } },
          ],
        },
      ],
    },
  });

  const general = DEMO.general;
  const messages = [
    msg(1, general, U(6), "joker el tirano", 300),
    msg(2, general, U(5), "Diablo pero que voz tú tienes", 62),
    msg(3, general, U(1), `<@${U(4)}> ¿che pero lo estás haciendo eso en **hora**?`, 60),
    msg(4, general, U(4), "Claro pues ya nos robaron la radio por la plata, baila el mono", 59),
    msg(5, general, U(4), "jajaja hay *guita guita* ~~y no pagarles~~", 59),
    msg(6, general, U(1), "Dile que acá ya hay dj, está romoro así que ya tenemos", 58, {
      referenced_message: { id: "x", author: { id: U(4) }, content: "Claro pues ya nos robaron la radio" },
    }),
    msg(7, general, U(3), "como lo ves\n```ts\nconst sala = await voice.join(\"Sala 1\");\nsala.mute();\n```", 40),
    msg(8, general, U(2), "pensé q te habías cambiado la foto <:kek:950000000000000001> ||spoiler||", 30, {
      reactions: [
        { emoji: { id: null, name: "😂" }, count: 3, me: true },
        { emoji: { id: null, name: "🔥" }, count: 1, me: false },
      ],
    }),
    msg(9, general, ME, `> esto es una cita\nmirá https://github.com/sst/opentui y <#${DEMO.general}>`, 12, {
      edited_timestamp: new Date().toISOString(),
      attachments: [{ id: "1", filename: "captura-20261107.png", size: 123456, url: "https://cdn.discordapp.com/x.png", proxy_url: "https://media.discordapp.net/x.png", content_type: "image/png", width: 800, height: 400 }],
    }),
    msg(10, general, U(1), `¿estás trabajando en ese juego de ajedrez <@${ME}>?`, 2, {
      mentions: [{ id: ME }],
      embeds: [{ title: "OpenTUI", description: "Build terminal user interfaces with **TypeScript**.", url: "https://github.com/sst/opentui", color: 0x5865f2, provider: { name: "GitHub" } }],
    }),
  ];
  store.dispatch({ type: "messages/page", channelId: general, messages: messages as never, mode: "latest" });
  seedPolls(store);
  seedEmoji(store);
  store.dispatch({ type: "gw", t: "TYPING_START", d: { channel_id: general, user_id: U(2), timestamp: Math.floor(Date.now() / 1000) + 3600 } });
  store.dispatch({
    type: "messages/page",
    channelId: DEMO.dm,
    messages: [
      { ...msg(50, DEMO.dm, U(2), "che, ¿te sumás a la llamada de las 22?", 25), guild_id: undefined },
      { ...msg(51, DEMO.dm, ME, "dale, ahí entro desde zcord 😎", 20), guild_id: undefined },
      { ...msg(52, DEMO.dm, U(2), "jaja ¿en serio en la terminal?", 2), guild_id: undefined },
    ] as never,
    mode: "latest",
  });
  seedThreads(store);
  seedUnread(store);
  store.dispatch({ type: "ui/selectGuild", id: G1 });
  store.dispatch({ type: "ui/selectChannel", id: general });
  store.dispatch({ type: "ui/focus", focus: "messages" });
  seedPresence(store);
  seedGoLive(store, G1, DEMO.voice, U(1));
  return store;
}

/** Acciones locales para la demo: no salen a la red; la voz simula conexión y quién habla. */
export function demoActions(store: Store): Actions {
  let speakTimer: ReturnType<typeof setInterval> | null = null;
  const voice: VoiceActions = {
    async toggleVoice(channelId) {
      const state = store.getState();
      if (state.voice.channelId === channelId) return voice.leaveVoice();
      store.dispatch({ type: "voice/joining", guildId: DEMO.guild, channelId });
      store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: DEMO.guild, user_id: ME, channel_id: channelId, self_mute: state.voice.selfMute, self_deaf: state.voice.selfDeaf } });
      await Bun.sleep(400);
      store.dispatch({ type: "voice/status", status: "connected" });
      store.dispatch({ type: "voice/privacyCode", code: "4812093317502246618810475" });
      store.dispatch({ type: "voice/outputLabel", label: "AE01" });
      let on = false;
      speakTimer = setInterval(() => {
        on = !on;
        store.dispatch({ type: "voice/speaking", userId: U(1), on });
        store.dispatch({ type: "voice/selfSpeaking", on: !on && !store.getState().voice.selfMute });
      }, 1200);
    },
    async leaveVoice() {
      if (speakTimer) clearInterval(speakTimer);
      store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: DEMO.guild, user_id: ME, channel_id: null } });
      store.dispatch({ type: "voice/left" });
    },
    toggleMute() {
      const v = store.getState().voice;
      store.dispatch({ type: "voice/flags", selfMute: !v.selfMute, selfDeaf: false, muteBeforeDeaf: false });
    },
    toggleDeaf() {
      const v = store.getState().voice;
      store.dispatch({ type: "voice/flags", selfMute: v.selfDeaf ? v.muteBeforeDeaf : true, selfDeaf: !v.selfDeaf, muteBeforeDeaf: v.selfMute });
    },
    setInputMode(mode) {
      store.dispatch({ type: "settings/set", patch: { inputMode: mode } });
    },
    toggleInputMode() {
      const mode = store.getState().settings.inputMode;
      voice.setInputMode(mode === "push_to_talk" ? "voice_activity" : "push_to_talk");
    },
    pttKey() {},
    micLevel: () => null,
    async listOutputs() {
      const outputs = [
        { name: "alsa_output.usb-Logitech_PRO_X_2", description: "PRO X 2 LIGHTSPEED Analog Stereo" },
        { name: "bluez_output.AE01", description: "AE01" },
        { name: "alsa_output.pci-hdmi", description: "GA102 HDMI [Odyssey G40B]" },
      ];
      const current = store.getState().settings.outputDevice;
      return { outputs, current: current ?? "bluez_output.AE01", isDefault: current === null };
    },
    async setOutputDevice(name) {
      store.dispatch({ type: "settings/set", patch: { outputDevice: name } });
      const labels: Record<string, string> = { "alsa_output.usb-Logitech_PRO_X_2": "PRO X 2 LIGHTSPEED Analog Stereo", "alsa_output.pci-hdmi": "GA102 HDMI" };
      store.dispatch({ type: "voice/outputLabel", label: name ? labels[name] ?? name : "AE01" });
    },
    ...demoStreamActions(store, ME),
    ...demoWatchActions(store),
  };
  let n = 2000;
  return {
    selectGuild: (id) => {
      store.dispatch({ type: "ui/selectGuild", id });
      // Como las acciones reales: abre el primer canal de texto o DM.
      const first = selectChannelList(store.getState(), id).find((row) => row.kind === "text" || row.kind === "dm" || row.kind === "group_dm");
      if (first) store.dispatch({ type: "ui/selectChannel", id: first.id });
    },
    openChannel: async (id) => {
      store.dispatch({ type: "ui/selectChannel", id });
      if (!store.getState().messages[id]) store.dispatch({ type: "messages/page", channelId: id, messages: [], mode: "latest" });
    },
    loadOlder: async () => {},
    focus: (focus) => store.dispatch({ type: "ui/focus", focus }),
    toggleMembers: () => store.dispatch({ type: "ui/toggleMembers" }),
    send: async (channelId, content) => {
      n += 1;
      store.dispatch({ type: "gw", t: "MESSAGE_CREATE", d: msg(n, channelId, ME, content, 0) });
    },
    retry: async () => {},
    edit: async (channelId, messageId, content) => {
      store.dispatch({ type: "gw", t: "MESSAGE_UPDATE", d: { id: messageId, channel_id: channelId, content, edited_timestamp: new Date().toISOString() } });
    },
    remove: async (channelId, messageId) => {
      store.dispatch({ type: "gw", t: "MESSAGE_DELETE", d: { id: messageId, channel_id: channelId } });
    },
    toggleReaction: async () => {},
    // Quién reaccionó, inventado para la demo (la primera persona sos vos si tu reacción está puesta).
    reactionUsers: async (channelId, messageId, emoji) => {
      const message = store.getState().messages[channelId]?.byId[messageId] as any;
      const reaction = message?.reactions?.find((r: any) => r?.emoji?.name === emoji.name);
      const pool = ["Ramiro", "Celes", "dfuentes", "Pepa", "bruno_7712"];
      const names = reaction?.me ? ["Gon", ...pool] : pool;
      return names.slice(0, reaction?.count ?? 1);
    },
    setStatus: (status) => store.dispatch({ type: "settings/set", patch: { status } }),
    voice,
  };
}
