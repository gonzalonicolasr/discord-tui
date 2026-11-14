import type { AppState } from "../types";

function emojiKey(emoji: any): string {
  return `${emoji?.id ?? "u"}:${emoji?.name ?? ""}`;
}

export function applyReaction(state: AppState, t: string, d: any): AppState {
  const channelId = typeof d?.channel_id === "string" ? d.channel_id : null;
  const messageId = typeof d?.message_id === "string" ? d.message_id : null;
  if (channelId === null || messageId === null) return state;

  const slice = state.messages[channelId];
  const message = slice?.byId[messageId];
  if (!slice || !message) return state;

  let reactions: any[] = Array.isArray((message as any).reactions) ? [...(message as any).reactions] : [];
  const me = state.me?.id ?? null;

  if (t === "MESSAGE_REACTION_REMOVE_ALL") {
    reactions = [];
  } else if (t === "MESSAGE_REACTION_REMOVE_EMOJI") {
    const key = emojiKey(d.emoji);
    reactions = reactions.filter((item: any) => emojiKey(item.emoji) !== key);
  } else {
    const emoji = { id: d.emoji?.id ?? null, name: d.emoji?.name ?? "", ...(d.emoji?.animated === true ? { animated: true } : {}) };
    const key = emojiKey(emoji);
    const index = reactions.findIndex((item: any) => emojiKey(item.emoji) === key);

    if (t === "MESSAGE_REACTION_ADD") {
      if (index === -1) reactions = [...reactions, { emoji, count: 1, me: d.user_id === me }];
      else reactions = reactions.map((item, i) => (i === index ? { ...item, count: (item.count ?? 0) + 1, me: item.me || d.user_id === me } : item));
    } else if (t === "MESSAGE_REACTION_REMOVE") {
      if (index !== -1) {
        reactions = reactions.map((item, i) =>
          i === index ? { ...item, count: Math.max(0, (item.count ?? 1) - 1), me: d.user_id === me ? false : item.me } : item,
        );
        // Sin nadie que reaccione no queda un chip con 0.
        reactions = reactions.filter((item: any) => (item.count ?? 0) > 0);
      }
    }
  }

  const merged = { ...message, reactions } as any;
  return { ...state, messages: { ...state.messages, [channelId]: { ...slice, byId: { ...slice.byId, [messageId]: merged } } } };
}
