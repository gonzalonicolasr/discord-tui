// Demo interactiva de la UI con datos falsos: no se conecta a Discord ni usa la sesión.
// Uso: bun run demo
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { KITTY_KEYBOARD } from "../src/ui/kitty";

import { App } from "../src/ui/App";
import { APP_NAME } from "../src/ui/brand";
import { buildDemoStore, demoActions } from "./demo-state";
import { themesDir } from "../src/config/paths";
import { registerThemes } from "../src/ui/theme";
import { loadUserThemes } from "../src/ui/theme-files";

// Los temas propios (~/.config/zcord/themes) también se ven en la demo: sirve para probarlos sin loguearse.
loadUserThemes(themesDir(), registerThemes);
const store = buildDemoStore();
const actions = demoActions(store);
const renderer = await createCliRenderer({ useKittyKeyboard: KITTY_KEYBOARD });
const quit = (): void => {
  renderer.destroy();
  void renderer.closed.then(() => process.exit(0));
};
renderer.setTerminalTitle(`${APP_NAME} (demo)`);
await render(() => <App store={store} actions={actions} onQuit={quit} splash />, renderer);
