import type { RestClient } from "../rest/client";
import { deleteMessage, patchMessage } from "../rest/routes";

import type { Store } from "../store/store";

/**
 * Editar y borrar aplican la respuesta de Discord al store en el momento, como el cliente oficial, sin esperar el
 * MESSAGE_UPDATE / MESSAGE_DELETE del gateway (que llega después y no cambia nada).
 */
export function createEditActions(deps: { rest: RestClient; store?: Store }) {
  return {
    /** `keepAttachments`: ids de los adjuntos que quedan (los demás se sacan); sin pasarlo no se tocan. */
    async edit(channelId: string, messageId: string, content: string, keepAttachments?: string[]): Promise<void> {
      const body = keepAttachments ? { content, attachments: keepAttachments.map((id) => ({ id })) } : { content };
      const message = await patchMessage(deps.rest, channelId, messageId, body);
      const d = message && typeof message === "object" && typeof message.id === "string" ? message : { id: messageId, channel_id: channelId, content };
      deps.store?.dispatch({ type: "gw", t: "MESSAGE_UPDATE", d: { ...d, channel_id: channelId } });
    },
    async remove(channelId: string, messageId: string): Promise<void> {
      await deleteMessage(deps.rest, channelId, messageId);
      deps.store?.dispatch({ type: "gw", t: "MESSAGE_DELETE", d: { id: messageId, channel_id: channelId } });
    },
  };
}
