import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { KITTY_IMAGE_TRANSPORT, KITTY_KEYBOARD, logKittyTransport } from "./ui/kitty";

import { boot } from "./app/boot";
import { Root } from "./app/root";
import { createRuntime, type Runtime } from "./app/runtime";
import { autoReloadForUpdate, loadAutoReloadRecord, saveAutoReloadRecord } from "./app/auto-reload";
import { captureReloadState, RELOAD_EXIT_CODE, restoreAfterReload, saveReloadState, takeReloadState, watchForCodeChanges } from "./app/reload";
import { deleteSession, loadSession, type Session } from "./auth/session";
import { validateToken } from "./auth/token-login";
import { fetchBuildNumber } from "./client-props/build-number";
import { createClientProps } from "./client-props/props";
import { createHttp } from "./rest/http";
import { log } from "./log/logger";
import { loadSettings } from "./settings/settings";
import { themesDir } from "./config/paths";
import { registerThemes } from "./ui/theme";
import { loadUserThemes } from "./ui/theme-files";
import { APP_NAME } from "./ui/brand";

export function assertTty(stream: { isTTY?: boolean }): string | null {
  return stream.isTTY ? null : "zcord necesita una terminal";
}

async function main(): Promise<void> {
  const message = assertTty(process.stdout);
  if (message) {
    process.stderr.write(message + "\n");
    process.exit(1);
  }

  const { value: buildNumber } = await fetchBuildNumber({ fetch });
  const settings = await loadSettings();
  loadUserThemes(themesDir(), registerThemes);
  const result = await boot(process.argv.slice(2), {
    loadSession,
    deleteSession,
    validate: async (session: Session) => {
      const http = createHttp({ props: createClientProps({ buildNumber }), token: session.token });
      const me = await validateToken(session.token, http);
      return { id: me.userId, username: me.username };
    },
  });

  if (result.kind === "logout-done") return process.exit(0);
  if (result.kind === "fatal") {
    process.stderr.write(result.message + "\n");
    return process.exit(1);
  }

  const renderer = await createCliRenderer({ useKittyKeyboard: KITTY_KEYBOARD, kittyImageTransport: KITTY_IMAGE_TRANSPORT });
  logKittyTransport(renderer, log);
  const kittyKeyboard = (): boolean => renderer.capabilities?.kitty_keyboard ?? true;
  renderer.setTerminalTitle(APP_NAME);
  let quitting = false;
  const quit = (runtime: Runtime | null): void => {
    if (quitting) return;
    quitting = true;
    // Primero se sale de voz (op 4 con channel_id null) y se cierra el gateway; después la terminal.
    void (runtime?.stop() ?? Promise.resolve()).finally(() => {
      renderer.destroy();
      void renderer.closed.then(() => process.exit(0));
    });
  };

  // Ctrl+R: se guarda dónde estás, se sale de voz y se cierra con RELOAD_EXIT_CODE; bin/zcord vuelve a abrir
  // zcord (recompilado si cambió algo) y al arrancar se vuelve al mismo canal y a la llamada.
  const reload = (runtime: Runtime): void => {
    if (quitting) return;
    quitting = true;
    saveReloadState(captureReloadState(runtime.store));
    void runtime.stop().finally(() => {
      renderer.destroy();
      void renderer.closed.then(() => process.exit(RELOAD_EXIT_CODE));
    });
  };
  const canReload = process.env.ZCORD_HOME !== undefined;

  const clientProps = createClientProps({ buildNumber });

  if (result.kind === "login") {
    await render(
      () => (
        <Root
          buildNumber={buildNumber}
          settings={settings}
          clientProps={clientProps}
          initialRuntime={null}
          onQuit={quit}
          onReload={canReload ? reload : undefined}
          kittyKeyboard={kittyKeyboard}
        />
      ),
      renderer,
    );
    return;
  }

  const session = result.session;
  const me = result.kind === "main" ? result.me : { id: session.userId, username: "" };
  // Código nuevo (lo que se está desarrollando, un git pull o una versión nueva en GitHub): App recarga sola cuando
  // es seguro y bin/zcord recompila (y aplica la actualización) antes de volver a abrir.
  const codeListeners = new Set<() => void>();
  const codeChanged = (): void => codeListeners.forEach((listener) => listener());
  const onCodeChange = (listener: () => void): (() => void) => {
    codeListeners.add(listener);
    return () => codeListeners.delete(listener);
  };
  // Tope contra bucles, en disco: una recarga automática por versión de GitHub (SHA de FETCH_HEAD) y como mínimo
  // 10 min entre dos recargas automáticas. Si no se puede guardar, no se recarga solo (queda Ctrl+R).
  const lastAutoReload = loadAutoReloadRecord();
  let pendingUpdateSha: string | null = null;
  const autoReload = {
    onChange: onCodeChange,
    lastAt: (): number => lastAutoReload?.at ?? 0,
    reload: (active: Runtime): void => {
      const updateSha = pendingUpdateSha ?? lastAutoReload?.updateSha ?? null;
      if (!saveAutoReloadRecord({ at: Date.now(), updateSha })) {
        active.store.dispatch({ type: "notice/push", key: "code-changed", level: "warn", text: "Hay cambios en zcord: Ctrl+R para recargar sin salir." });
        return;
      }
      reload(active);
    },
  };
  const runtime = createRuntime({
    session,
    me,
    props: clientProps,
    initialSettings: settings,
    kittyKeyboard,
    onUpdateAvailable: (sha) => {
      if (!autoReloadForUpdate(sha, lastAutoReload)) return;
      pendingUpdateSha = sha;
      codeChanged();
    },
  });
  const saved = takeReloadState();
  if (saved) restoreAfterReload(runtime.store, runtime.actions as never, saved);
  watchForCodeChanges(codeChanged);
  await render(
    () => (
      <Root
        buildNumber={buildNumber}
        settings={settings}
        clientProps={clientProps}
        initialRuntime={runtime}
        onQuit={quit}
        onReload={canReload ? reload : undefined}
        autoReload={canReload ? autoReload : undefined}
        kittyKeyboard={kittyKeyboard}
      />
    ),
    renderer,
  );
}

if (import.meta.main) await main();
