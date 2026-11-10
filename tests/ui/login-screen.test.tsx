import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import type { RaEvent } from "../../src/auth/remote-auth";
import { findTokenLike } from "../../src/security/token-pattern";
import { LoginScreen } from "../../src/ui/screens/LoginScreen";
import { fakeToken } from "../helpers/fake-token";

function fakeAuth() {
  let listener: ((event: RaEvent) => void) | null = null;
  return {
    auth: {
      on(fn: (event: RaEvent) => void) {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      start() {},
    },
    emit(event: RaEvent) {
      listener?.(event);
    },
  };
}

test("shows the QR and the scan hint on qr event", async () => {
  const { auth, emit } = fakeAuth();
  const { captureCharFrame, renderOnce } = await testRender(
    () => <LoginScreen auth={auth} onPasteToken={async () => null} />,
    { width: 100, height: 30 },
  );
  emit({ type: "qr", url: "https://discord.com/ra/abc" });
  await renderOnce();
  expect(captureCharFrame()).toContain("Escaneá el código");
});

test("shows the username on scanned", async () => {
  const { auth, emit } = fakeAuth();
  const { captureCharFrame, renderOnce } = await testRender(
    () => <LoginScreen auth={auth} onPasteToken={async () => null} />,
    { width: 100, height: 30 },
  );
  emit({ type: "scanned", username: "gonfake" });
  await renderOnce();
  expect(captureCharFrame()).toContain("¿Sos vos, gonfake?");
});

test("captcha says so plainly and r asks for a fresh QR (no token homework)", async () => {
  const { auth, emit } = fakeAuth();
  let starts = 0;
  const start = auth.start;
  auth.start = () => {
    starts++;
    start();
  };
  const { captureCharFrame, mockInput, renderOnce } = await testRender(
    () => <LoginScreen auth={auth} onPasteToken={async () => null} />,
    { width: 140, height: 40 },
  );
  emit({ type: "captcha" });
  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("Discord pidió un captcha");
  expect(frame).toContain("Apretá r para un QR nuevo");
  expect(frame).not.toContain("DevTools");
  const before = starts;
  mockInput.pressKey("r");
  await renderOnce();
  expect(starts).toBe(before + 1);
  expect(captureCharFrame()).not.toContain("Discord pidió un captcha");
});

test("pasted token is masked on screen", async () => {
  const { auth } = fakeAuth();
  const { captureCharFrame, mockInput, renderOnce } = await testRender(
    () => <LoginScreen auth={auth} onPasteToken={async () => null} />,
    { width: 100, height: 30 },
  );
  await mockInput.pasteBracketedText(fakeToken());
  await renderOnce();
  expect(findTokenLike(captureCharFrame())).toEqual([]);
});

test("the QR is the default way in: token instructions stay hidden until you press t", async () => {
  const { auth, emit } = fakeAuth();
  const { captureCharFrame, mockInput, renderOnce } = await testRender(
    () => <LoginScreen auth={auth} onPasteToken={async () => null} />,
    { width: 100, height: 50 },
  );
  emit({ type: "qr", url: "https://discord.com/ra/abc" });
  await renderOnce();
  const qr = captureCharFrame();
  expect(qr).toContain("Escanear código QR");
  expect(qr).toContain("Apretá t para entrar con tu token");
  expect(qr).not.toContain("DevTools");
  mockInput.pressKey("t");
  await renderOnce();
  expect(captureCharFrame()).toContain("DevTools → Network");
  mockInput.pressKey("t");
  await renderOnce();
  expect(captureCharFrame()).not.toContain("DevTools");
});
