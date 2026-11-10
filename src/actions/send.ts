import { HttpError } from "../rest/errors";
import type { RestClient } from "../rest/client";
import { postMessage } from "../rest/routes";
import type { Store } from "../store/store";
import type { OutboxItem, PendingAttachment } from "../store/types";
import type { UploadedAttachment } from "../uploads/upload";
import { generateNonce } from "../util/snowflake";

export interface SendDeps {
  store: Store;
  rest: RestClient;
  upload?: (channelId: string, files: PendingAttachment[]) => Promise<UploadedAttachment[]>;
}

function errorText(error: unknown): string {
  // 50013 Missing Permissions / 50001 Missing Access: el canal no te deja escribir (o ya no lo ves).
  if (error instanceof HttpError && (error.code === 50013 || error.code === 50001)) return "no tenés permiso para escribir acá";
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof Error) return error.message;
  return "error";
}

export function createSendActions(deps: SendDeps) {
  // Los slots ya subidos se cachean por nonce: reintentar un mensaje no vuelve a subir los adjuntos.
  const uploadedByNonce = new Map<string, UploadedAttachment[]>();

  async function deliver(item: OutboxItem): Promise<void> {
    const { nonce, channelId, content, replyTo, attachments } = item;
    try {
      const body: Record<string, unknown> = { content, nonce, tts: false, flags: 0 };
      if (replyTo !== null) {
        body.message_reference = { message_id: replyTo, channel_id: channelId };
        body.allowed_mentions = { parse: ["users", "roles", "everyone"], replied_user: true };
      }
      if (attachments.length > 0) {
        if (deps.upload) {
          let uploaded = uploadedByNonce.get(nonce);
          if (!uploaded) {
            uploaded = await deps.upload(channelId, attachments);
            uploadedByNonce.set(nonce, uploaded);
          }
          body.attachments = uploaded;
        } else {
          body.attachments = attachments.map((attachment) => ({ filename: attachment.filename }));
        }
      }

      const message = await postMessage(deps.rest, channelId, body as never);
      uploadedByNonce.delete(nonce);
      deps.store.dispatch({ type: "outbox/sent", nonce, messageId: message.id });
    } catch (error) {
      deps.store.dispatch({ type: "outbox/failed", nonce, error: errorText(error) });
    }
  }

  return {
    async send(
      channelId: string,
      content: string,
      opts: { replyTo?: string; attachments?: PendingAttachment[] } = {},
    ): Promise<void> {
      const item: OutboxItem = {
        nonce: generateNonce(),
        channelId,
        content,
        replyTo: opts.replyTo ?? null,
        attachments: opts.attachments ?? [],
        state: "pending",
        error: null,
        createdAt: Date.now(),
      };
      deps.store.dispatch({ type: "outbox/enqueue", item });
      await deliver(item);
    },

    async retry(nonce: string): Promise<void> {
      const item = deps.store.getState().outbox[nonce];
      if (!item) return;
      deps.store.dispatch({ type: "outbox/retry", nonce });
      await deliver({ ...item, state: "pending", error: null });
    },
  };
}
