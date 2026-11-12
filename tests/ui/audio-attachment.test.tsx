import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";

test("a voice message shows as 🎤 with its waveform, length and ▶ escuchar (not as a file)", async () => {
  const store = buildDemoStore();
  store.dispatch({
    type: "gw",
    t: "MESSAGE_CREATE",
    d: {
      id: "930000000000009300",
      channel_id: DEMO.general,
      author: { id: "900000000000000101", username: "ramiro" },
      content: "",
      flags: 8192,
      timestamp: new Date().toISOString(),
      attachments: [{ id: "950000000000009300", filename: "voice-message.ogg", size: 80_000, url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg", content_type: "audio/ogg", duration_secs: 12.3, waveform: btoa(String.fromCharCode(10, 200, 90, 255, 30)) }],
    },
  });
  const h = await testRender(() => <App store={store} actions={demoActions(store)} onQuit={() => {}} />, { width: 160, height: 45 });
  await h.renderOnce();
  const frame = h.captureCharFrame();
  expect(frame).toContain("🎤 mensaje de voz");
  expect(frame).toContain("0:12");
  expect(frame).toContain("▶ escuchar");
  expect(frame).not.toContain("📎 voice-message.ogg");
});
