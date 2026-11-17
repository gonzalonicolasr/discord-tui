import { expect, test } from "bun:test";

import { closeReasonForLog } from "../../src/golive/errors";

test("the stream WS close reason goes to the log printable only: no line breaks, control or bidi characters, at most 80", () => {
  expect(closeReasonForLog("Session is no longer valid.")).toBe("Session is no longer valid.");
  expect(closeReasonForLog("bad\r\nfake-log-line {\"level\":\"error\"}")).toBe("bad fake-log-line level:error");
  expect(closeReasonForLog("a\u0000b\u001b[31mc‮d")).toBe("ab31mcd");
  expect(closeReasonForLog("x".repeat(200))).toHaveLength(80);
  expect(closeReasonForLog(undefined)).toBe("");
  expect(closeReasonForLog(4006)).toBe("");
});
