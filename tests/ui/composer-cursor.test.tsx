import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { Actions } from "../../src/actions";
import { App } from "../../src/ui/App";
import { THEMES } from "../../src/ui/theme";
import { RGBA } from "@opentui/core";
import { buildDemoStore, DEMO } from "../../scripts/demo-state";

const RAGNAR = "900000000000000101";

function setup() {
  const store = buildDemoStore();
  const sent: string[] = [];
  const actions: Actions = {
    selectGuild: (id) => store.dispatch({ type: "ui/selectGuild", id }),
    openChannel: async (id) => store.dispatch({ type: "ui/selectChannel", id }),
    loadOlder: async () => {},
    focus: (focus) => store.dispatch({ type: "ui/focus", focus }),
    toggleMembers: () => {},
    send: async (_channelId, content) => void sent.push(content),
    retry: async () => {},
    edit: async () => {},
    remove: async () => {},
    toggleReaction: async () => {},
  };
  return { store, actions, sent };
}

const NAMED: Record<string, string> = { home: "HOME", end: "END", delete: "DELETE", backspace: "BACKSPACE" };

async function open(width = 160, height = 45) {
  const s = setup();
  const h = await testRender(() => <App store={s.store} actions={s.actions} onQuit={() => {}} />, {
    width,
    height,
    kittyKeyboard: true, // como la app real (src/ui/kitty.ts)
  });
  await h.renderOnce();
  h.mockInput.pressKey("i");
  await h.renderOnce();
  const press = (name: string, times = 1, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
    for (let i = 0; i < times; i += 1) {
      if (name === "left" || name === "right" || name === "up" || name === "down") h.mockInput.pressArrow(name, mods);
      else h.mockInput.pressKey((NAMED[name] ?? name) as any, mods);
    }
  };
  const send = async () => {
    h.mockInput.pressEnter();
    await h.renderOnce();
    return s.sent.at(-1);
  };
  return { ...s, ...h, press, send };
}

/** La línea del composer (la que tiene el prompt ❯). */
function composerLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("❯ ")) ?? "";
}

test("type, move left and insert in the middle; send gets the exact content", async () => {
  const t = await open();
  await t.mockInput.typeText("hola mundo");
  t.press("left", 5);
  await t.mockInput.typeText("querido ");
  expect(await t.send()).toBe("hola querido mundo");
});

test("Home/End, Ctrl-a/Ctrl-e and word motions move the cursor", async () => {
  const t = await open();
  await t.mockInput.typeText("uno dos tres");
  t.press("home");
  await t.mockInput.typeText("A");
  t.press("end");
  await t.mockInput.typeText("Z");
  t.press("a", 1, { ctrl: true });
  t.press("right", 1, { ctrl: true }); // al final de "Auno"
  await t.mockInput.typeText("1");
  t.press("e", 1, { ctrl: true });
  t.press("left", 1, { ctrl: true }); // al principio de "tresZ"
  await t.mockInput.typeText("-");
  t.press("b", 1, { meta: true }); // Alt-b: salta "-" y el espacio → principio de "dos"
  await t.mockInput.typeText("[");
  t.press("f", 1, { meta: true }); // Alt-f: fin de "dos"
  await t.mockInput.typeText("]");
  expect(await t.send()).toBe("Auno1 [dos] -tresZ");
});

test("Backspace, Delete, Ctrl-w, Ctrl-u and Ctrl-k edit at the cursor", async () => {
  const t = await open();
  await t.mockInput.typeText("hola lindo mundo");
  t.press("left", 5); // antes de "mundo"
  t.press("backspace"); // borra el espacio
  t.press("delete"); // borra la "m"
  await t.mockInput.typeText(" M");
  t.press("w", 1, { ctrl: true }); // borra la tira sin espacios anterior: "M"
  await t.mockInput.typeText("N");
  expect(await t.send()).toBe("hola lindo Nundo");

  t.press("i");
  await t.mockInput.typeText("abc def");
  t.press("left", 3);
  t.press("k", 1, { ctrl: true }); // borra "def"
  await t.mockInput.typeText("!");
  t.press("left", 1);
  t.press("u", 1, { ctrl: true });
  expect(await t.send()).toBe("!");
});

test("Ctrl-k opens the quick switcher in normal mode but not while typing", async () => {
  const t = await open();
  await t.mockInput.typeText("hola");
  t.press("home");
  t.press("k", 1, { ctrl: true });
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("Saltar a…");
  expect(await t.send()).toBeUndefined(); // Ctrl-k borró todo: no hay nada que mandar
  t.mockInput.pressKeys(["\u001b[27u"]);
  await Bun.sleep(5);
  t.press("k", 1, { ctrl: true });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Saltar a…");
});

test("a mention picked in the middle of the text is serialized as <@id>", async () => {
  const t = await open();
  await t.mockInput.typeText("hola todo bien");
  t.press("left", 9); // antes de "todo"
  await t.mockInput.typeText("@ram");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("@ mencionar");
  t.mockInput.pressTab();
  await t.renderOnce();
  // el texto de después también corre las menciones ya elegidas
  t.press("home");
  await t.mockInput.typeText("ey ");
  expect(await t.send()).toBe(`ey hola <@${RAGNAR}> todo bien`);
});

test("deleting across a picked mention drops it (stays as plain text)", async () => {
  const t = await open();
  await t.mockInput.typeText("hola @ram");
  t.mockInput.pressTab();
  await t.mockInput.typeText("chau");
  t.press("left", 6); // antes de la "o" final de "@Ramiro"
  t.press("backspace");
  await t.renderOnce();
  // "@Rami" antes del cursor vuelve a abrir el popup; al final del texto se cierra.
  expect(t.captureCharFrame()).toContain("@ mencionar");
  t.press("end");
  expect(await t.send()).toBe("hola @Ramio chau");
});

test("the @ popup follows the text before the cursor", async () => {
  const t = await open();
  await t.mockInput.typeText("@ram hola");
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("@ mencionar");
  t.press("left", 5);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("@ mencionar");
});

test("multi-line drafts: up/down keep the column and render every line", async () => {
  const t = await open();
  await t.mockInput.typeText("abc");
  t.mockInput.pressEnter({ shift: true });
  await t.mockInput.typeText("de");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("❯ abc");
  expect(frame).toMatch(/│de█/);
  t.press("up");
  await t.mockInput.typeText("X");
  t.press("down");
  await t.mockInput.typeText("Y");
  expect(await t.send()).toBe("abXc\ndeY");
});

test("an emoji is one step for arrows and backspace", async () => {
  const t = await open();
  await t.mockInput.typeText("a");
  t.mockInput.pressKey("😀"); // typeText parte el emoji en dos mitades; la terminal lo manda entero
  await t.mockInput.typeText("b");
  t.press("left", 2);
  await t.mockInput.typeText("x");
  t.press("right");
  t.press("backspace");
  expect(await t.send()).toBe("axb");
});

test("bracketed paste inserts at the cursor", async () => {
  const t = await open();
  await t.mockInput.typeText("hola mundo");
  t.press("left", 5);
  await t.mockInput.pasteBracketedText("pegado ");
  expect(await t.send()).toBe("hola pegado mundo");
});

test("the cursor is drawn on the character, or as a block at the end", async () => {
  const t = await open();
  await t.mockInput.typeText("hola mundo");
  await t.renderOnce();
  expect(composerLine(t.captureCharFrame())).toContain("❯ hola mundo█");
  t.press("left", 5);
  await t.renderOnce();
  expect(composerLine(t.captureCharFrame())).toContain("❯ hola mundo ");
  expect(composerLine(t.captureCharFrame())).not.toContain("█");
  // la "m" va invertida: fondo del color de insert, letra del color de fondo
  const y = t.captureCharFrame().split("\n").findIndex((line) => line.includes("❯ hola mundo"));
  const spans = t.captureSpans().lines[y]!.spans;
  const m = spans.find((span) => span.text === "m")!;
  const rest = spans.find((span) => span.text.startsWith("undo"))!;
  const theme = THEMES[t.store.getState().settings.theme === "light" ? "light" : "dark"];
  expect(m.bg.toString()).toBe(RGBA.fromHex(theme.modeInsert).toString());
  expect(m.fg.toString()).toBe(RGBA.fromHex(theme.bg).toString());
  expect(rest.bg.toString()).not.toBe(m.bg.toString());
});

test("clicking inside the composer text moves the cursor there", async () => {
  const t = await open();
  await t.mockInput.typeText("hola mundo");
  await t.renderOnce();
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("❯ hola mundo"));
  const x = [...lines[y]!.slice(0, lines[y]!.indexOf("❯ hola mundo"))].length + 2 + 5; // la "m"
  await t.mockMouse.click(x, y);
  await t.renderOnce();
  await t.mockInput.typeText("X");
  expect(await t.send()).toBe("hola Xmundo");
});

test("the draft and its cursor are kept per channel", async () => {
  const t = await open();
  await t.mockInput.typeText("borrador");
  t.press("left", 3);
  t.mockInput.pressKeys(["\u001b[27u"]);
  await Bun.sleep(5);
  t.store.dispatch({ type: "ui/selectChannel", id: DEMO.dm });
  t.press("i");
  await t.mockInput.typeText("otro");
  t.mockInput.pressKeys(["\u001b[27u"]);
  await Bun.sleep(5);
  t.store.dispatch({ type: "ui/selectChannel", id: DEMO.general });
  t.press("i");
  await t.mockInput.typeText("-");
  expect(await t.send()).toBe("borra-dor");
});

test("clicking on a wrapped or second line puts the cursor on that character", async () => {
  const t = await open(100, 30);
  const long = `${"a".repeat(100)}Ybb`;
  await t.mockInput.pasteBracketedText(`uno\n${long}`);
  await t.renderOnce();
  const lines = t.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("Y"));
  expect(lines[y]).not.toContain("❯"); // "Y" quedó en una fila partida, no en la del prompt
  await t.mockMouse.click([...lines[y]!.slice(0, lines[y]!.indexOf("Y"))].length, y);
  await t.mockInput.typeText("Z");
  expect(await t.send()).toBe(`uno\n${"a".repeat(100)}ZYbb`);

  // después de mandar se sigue en modo escritura (como Discord): se pega directo
  await t.mockInput.pasteBracketedText("abc\ndefgh");
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  const row = rows.findIndex((line) => line.includes("defgh"));
  await t.mockMouse.click([...rows[row]!.slice(0, rows[row]!.indexOf("defgh"))].length + 2, row);
  await t.mockInput.typeText("X");
  expect(await t.send()).toBe("abc\ndeXfgh");
});
