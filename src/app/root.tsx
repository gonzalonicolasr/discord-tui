import { useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js";

import { createRemoteAuth, type RaEvent } from "../auth/remote-auth";
import { saveSession, type Session } from "../auth/session";
import { normalizePastedToken, validateToken } from "../auth/token-login";
import type { ClientProps } from "../client-props/props";
import { CaptchaRequiredError, UnauthorizedError } from "../rest/errors";
import { createHttp } from "../rest/http";
import type { Secret } from "../secret";
import type { Settings } from "../settings/settings";
import { App } from "../ui/App";
import { LoginScreen } from "../ui/screens/LoginScreen";
import { createRuntime, type Runtime } from "./runtime";

/** Mínimo de remote auth que usan Root y LoginScreen (inyectable en tests). */
export interface RootAuth {
  on(fn: (event: RaEvent) => void): () => void;
  start(): void;
}

export interface RootProps {
  buildNumber: number;
  settings: Settings;
  clientProps: ClientProps;
  /** `null` = arrancar en el login; un runtime ya creado = sesión guardada (main/offline). */
  initialRuntime: Runtime | null;
  onQuit: (runtime: Runtime | null) => void;
  /** Ctrl+R: cerrar prolijo y volver a abrir (bin/zcord lo relanza con el código nuevo). */
  onReload?: (runtime: Runtime) => void;
  /** Cambió el código de zcord: App recarga sola si es seguro (ver src/app/auto-reload.ts). */
  onCodeChange?: (listener: () => void) => () => void;
  kittyKeyboard: () => boolean;
  /** Se inyecta en tests; por defecto el remote auth real. */
  auth?: RootAuth;
}

/**
 * Componente raíz de sesión: siempre registra `onUnauthorized` en el runtime activo y, ante un 401,
 * lo frena y vuelve a `LoginScreen`. Cubre tanto el login como la sesión guardada (B1).
 */
export function Root(props: RootProps): JSX.Element {
  const clientProps = props.clientProps;
  const auth: RootAuth = props.auth ?? createRemoteAuth({ http: createHttp({ props: clientProps }) });
  const [runtime, setRuntime] = createSignal<Runtime | null>(props.initialRuntime);
  let lastName = "";

  function mountRuntime(next: Runtime): void {
    next.onUnauthorized(() => {
      void next.stop();
      setRuntime(null);
    });
    next.start();
    setRuntime(next);
  }

  async function finish(token: Secret, userId: string, username: string): Promise<void> {
    const session: Session = { token, userId, buildNumber: props.buildNumber };
    await saveSession(session);
    mountRuntime(
      createRuntime({
        session,
        me: { id: userId, username },
        props: clientProps,
        initialSettings: props.settings,
        kittyKeyboard: props.kittyKeyboard,
      }),
    );
  }

  onMount(() => {
    const initial = props.initialRuntime;
    if (initial !== null) mountRuntime(initial);
  });

  onMount(() => {
    const off = auth.on((event) => {
      if (event.type === "scanned") lastName = event.username;
      if (event.type === "token") void finish(event.token, event.userId, lastName);
    });
    onCleanup(off);
  });

  async function onPasteToken(raw: string): Promise<string | null> {
    const normalized = normalizePastedToken(raw);
    if (!normalized.ok) {
      if (normalized.reason === "empty") return "Pegá un token";
      if (normalized.reason === "prefixed") return "Sin prefijo Bot/Bearer: solo el token";
      return "Eso no parece un token de Discord";
    }
    try {
      const authed = createHttp({ props: clientProps, token: normalized.token });
      const me = await validateToken(normalized.token, authed);
      await finish(normalized.token, me.userId, me.username);
      return null;
    } catch (error) {
      if (error instanceof CaptchaRequiredError) return "Discord pidió captcha, pegá el token";
      if (error instanceof UnauthorizedError) return "Token rechazado";
      return "No se pudo validar el token";
    }
  }

  useKeyboard((key) => {
    if (runtime() === null && key.name === "q" && !key.ctrl && !key.meta) props.onQuit(null);
  });

  return (
    <Show when={runtime()} fallback={<LoginScreen auth={auth} onPasteToken={onPasteToken} />}>
      {(active: Accessor<Runtime>) => (
        <App
          store={active().store}
          actions={active().actions}
          onQuit={() => props.onQuit(active())}
          onReload={props.onReload ? () => props.onReload?.(active()) : undefined}
          onCodeChange={props.onCodeChange}
          onActivity={() => active().activity()}
          images
          splash
        />
      )}
    </Show>
  );
}
