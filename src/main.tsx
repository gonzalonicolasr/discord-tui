import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { KITTY_KEYBOARD } from "./ui/kitty";

import { boot } from "./app/boot";
import { Root } from "./app/root";
import { createRuntime, type Runtime } from "./app/runtime";
import { deleteSession, loadSession, type Session } from "./auth/session";
import { validateToken } from "./auth/token-login";
import { fetchBuildNumber } from "./client-props/build-number";
import { createClientProps } from "./client-props/props";
import { createHttp } from "./rest/http";
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

  const renderer = await createCliRenderer({ useKittyKeyboard: KITTY_KEYBOARD });
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
          kittyKeyboard={kittyKeyboard}
        />
      ),
      renderer,
    );
    return;
  }

  const session = result.session;
  const me = result.kind === "main" ? result.me : { id: session.userId, username: "" };
  const runtime = createRuntime({
    session,
    me,
    props: clientProps,
    initialSettings: settings,
    kittyKeyboard,
  });
  await render(
    () => (
      <Root
        buildNumber={buildNumber}
        settings={settings}
        clientProps={clientProps}
        initialRuntime={runtime}
        onQuit={quit}
        kittyKeyboard={kittyKeyboard}
      />
    ),
    renderer,
  );
}

if (import.meta.main) await main();
