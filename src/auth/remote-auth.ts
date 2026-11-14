import { log } from "../log/logger";
import { CaptchaRequiredError, HttpError, InvalidResponseError } from "../rest/errors";
import type { Http } from "../rest/http";
import { Secret } from "../secret";
import { generateRaKeys, toBase64Url, type RaKeys } from "./ra-crypto";

export type RaEvent =
  | { type: "qr"; url: string }
  | { type: "scanned"; username: string }
  | { type: "token"; token: Secret; userId: string }
  | { type: "captcha" }
  | { type: "cancelled" }
  | { type: "error"; reason: string };

export interface RemoteAuth {
  start(): void;
  stop(): void;
  on(fn: (event: RaEvent) => void): () => void;
}

export interface RemoteAuthDeps {
  http: Http;
  wsUrl?: string;
  makeKeys?: () => Promise<RaKeys>;
  WebSocketImpl?: typeof WebSocket;
}

const DEFAULT_WS_URL = "wss://remote-auth-gateway.discord.gg/?v=2";
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 50;
const DEFAULT_HEARTBEAT_MS = 30_000;

export function createRemoteAuth(deps: RemoteAuthDeps): RemoteAuth {
  const wsUrl = deps.wsUrl ?? DEFAULT_WS_URL;
  const makeKeys = deps.makeKeys ?? generateRaKeys;
  const WebSocketImpl = deps.WebSocketImpl ?? WebSocket;

  const listeners = new Set<(event: RaEvent) => void>();
  let stopped = false;
  let socket: WebSocket | null = null;
  let keys: RaKeys | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let acked = true;
  let reconnects = 0;
  let awaitingLogin = false;
  let userId = "0";
  /** connect() esperando las claves (start() repetido no abre otro socket). */
  let connecting = false;
  /** Sube con cada stop(): lo que termina de esperar con una sesión vieja no sigue. */
  let session = 0;

  function emit(event: RaEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function send(payload: unknown): void {
    try {
      socket?.send(JSON.stringify(payload));
    } catch {
      // el socket ya estaba cerrado
    }
  }

  function clearHeartbeat(): void {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function closeSocket(code = 1000): void {
    clearHeartbeat();
    const current = socket;
    socket = null;
    if (current === null) return;
    try {
      current.close(code);
    } catch {
      // ya estaba cerrado
    }
  }

  let fingerprintJob: Promise<string | null> = Promise.resolve(null);
  async function fetchFingerprint(): Promise<string | null> {
    try {
      const response = await deps.http.request<Record<string, unknown>>("GET", "/experiments");
      return typeof response?.fingerprint === "string" ? response.fingerprint : null;
    } catch {
      return null;
    }
  }

  function stop(): void {
    stopped = true;
    session += 1;
    connecting = false;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    closeSocket(1000);
    clearHeartbeat();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    closeSocket();
    reconnects += 1;
    if (reconnects > MAX_RECONNECTS) {
      log.error("remote-auth.reconnect-limit", { attempt: reconnects });
      emit({ type: "error", reason: "too many reconnect attempts" });
      stop();
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, RECONNECT_DELAY_MS);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const mine = session;
    connecting = true;
    let fresh: RaKeys;
    try {
      fresh = await makeKeys();
    } catch (error) {
      if (mine !== session) return;
      log.error("remote-auth.keys-failed", { error_name: error instanceof Error ? error.name : "error" });
      emit({ type: "error", reason: "key generation failed" });
      stop();
      return;
    }
    if (mine !== session) return;
    connecting = false;
    keys = fresh;
    awaitingLogin = false;
    acked = true;

    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(wsUrl, { headers: { Origin: "https://discord.com" } });
    } catch {
      emit({ type: "error", reason: "websocket failed" });
      stop();
      return;
    }
    socket = ws;

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      void handleMessage(String(event.data));
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      handleClose(event.code);
    };
    ws.onerror = () => {
      // el cierre llega por onclose
    };
  }

  function handleClose(code: number): void {
    clearHeartbeat();
    socket = null;
    if (stopped || awaitingLogin) return;
    if (reconnectTimer !== null) return;
    if (code === 1000) return;
    scheduleReconnect();
  }

  function onHello(message: Record<string, unknown>): void {
    if (keys === null) return;
    send({ op: "init", encoded_public_key: keys.publicSpkiB64 });

    clearHeartbeat();
    const interval =
      typeof message.heartbeat_interval === "number" && message.heartbeat_interval > 0
        ? message.heartbeat_interval
        : DEFAULT_HEARTBEAT_MS;
    heartbeat = setInterval(() => {
      if (!acked) {
        scheduleReconnect();
        return;
      }
      acked = false;
      send({ op: "heartbeat" });
    }, interval);
  }

  async function onNonceProof(message: Record<string, unknown>): Promise<void> {
    if (keys === null || typeof message.encrypted_nonce !== "string") return;
    try {
      const nonce = await keys.decrypt(message.encrypted_nonce);
      send({ op: "nonce_proof", nonce: toBase64Url(nonce) });
    } catch {
      emit({ type: "error", reason: "nonce decrypt failed" });
      stop();
    }
  }

  function onPendingRemoteInit(message: Record<string, unknown>): void {
    if (keys === null || typeof message.fingerprint !== "string") return;
    if (message.fingerprint !== keys.fingerprint) {
      scheduleReconnect();
      return;
    }
    reconnects = 0;
    emit({ type: "qr", url: `https://discord.com/ra/${message.fingerprint}` });
  }

  async function onPendingTicket(message: Record<string, unknown>): Promise<void> {
    if (keys === null || typeof message.encrypted_user_payload !== "string") return;
    try {
      const payload = new TextDecoder().decode(await keys.decrypt(message.encrypted_user_payload));
      const parts = payload.split(":");
      userId = parts[0] ?? "0";
      emit({ type: "scanned", username: parts.slice(3).join(":") });
    } catch {
      emit({ type: "error", reason: "user payload decrypt failed" });
      stop();
    }
  }

  async function onPendingLogin(message: Record<string, unknown>): Promise<void> {
    awaitingLogin = true;
    clearHeartbeat();
    if (keys === null || typeof message.ticket !== "string") return;
    const mine = session;
    try {
      const fingerprint = await fingerprintJob;
      if (mine !== session) return;
      const response = await deps.http.request<Record<string, unknown>>(
        "POST",
        "/users/@me/remote-auth/login",
        { ticket: message.ticket },
        fingerprint ? { headers: { "X-Fingerprint": fingerprint } } : undefined,
      );
      if (mine !== session) return; // stop() mientras se canjeaba el ticket
      const encrypted = typeof response?.encrypted_token === "string" ? response.encrypted_token : null;
      if (encrypted === null) {
        const names =
          response !== null && typeof response === "object" ? Object.keys(response).sort().join(",") : "sin cuerpo";
        log.error("remote-auth.login-shape", { count: names === "sin cuerpo" ? 0 : names.split(",").length });
        emit({ type: "error", reason: `login sin encrypted_token (${names})` });
        stop();
        return;
      }
      const token = new TextDecoder().decode(await keys.decrypt(encrypted));
      if (mine !== session) return;
      emit({ type: "token", token: new Secret(token), userId });
      stop();
    } catch (error) {
      if (mine !== session) return;
      if (error instanceof CaptchaRequiredError) {
        emit({ type: "captcha" });
        stop();
        return;
      }
      const reason =
        error instanceof InvalidResponseError
          ? `HttpError ${error.status} (${error.contentType || "sin content-type"}, ${error.bytes} bytes)`
          : error instanceof HttpError
            ? `HttpError ${error.status}${error.code !== undefined ? ` ${error.code}` : ""}`
            : error instanceof Error
              ? error.name
              : "login failed";
      log.error("remote-auth.login-failed", { error_name: reason });
      emit({ type: "error", reason });
      stop();
    }
  }

  async function handleMessage(raw: string): Promise<void> {
    if (stopped) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    switch (message.op) {
      case "hello":
        onHello(message);
        return;
      case "nonce_proof":
        await onNonceProof(message);
        return;
      case "pending_remote_init":
        onPendingRemoteInit(message);
        return;
      case "pending_ticket":
        await onPendingTicket(message);
        return;
      case "pending_login":
        await onPendingLogin(message);
        return;
      case "cancel":
        emit({ type: "cancelled" });
        scheduleReconnect();
        return;
      case "heartbeat_ack":
        acked = true;
        return;
    }
  }

  return {
    start(): void {
      if (socket !== null || reconnectTimer !== null || connecting) return;
      stopped = false;
      reconnects = 0;
      // Como la web: un fingerprint (y las cookies que vienen con él) antes del login, para que Discord no
      // trate el canje del ticket como sospechoso y pida captcha.
      fingerprintJob = fetchFingerprint();
      void connect();
    },
    stop,
    on(fn: (event: RaEvent) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
