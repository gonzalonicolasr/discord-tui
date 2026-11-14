import { expect, jest, test } from "bun:test";

import { checkForUpdate, scheduleUpdateCheck, startUpdateChecks } from "../../src/app/update-check";

function fakeGit(answers: Record<string, { code: number; out: string }>) {
  const calls: string[] = [];
  const run = async (cmd: string[]) => {
    const key = cmd.slice(3).join(" ");
    calls.push(key);
    return answers[key] ?? { code: 1, out: "" };
  };
  return { run, calls };
}

const UP_TO_DATE = {
  "rev-parse --is-inside-work-tree": { code: 0, out: "true\n" },
  "fetch --quiet origin main": { code: 0, out: "" },
  "rev-list --count HEAD..FETCH_HEAD": { code: 0, out: "0\n" },
};

test("counts the commits on GitHub that this clone does not have", async () => {
  const git = fakeGit({ ...UP_TO_DATE, "rev-list --count HEAD..FETCH_HEAD": { code: 0, out: "3\n" } });
  expect(await checkForUpdate({ repoDir: "/zcord", run: git.run, env: {} })).toBe(3);
  expect(git.calls).toEqual(["rev-parse --is-inside-work-tree", "fetch --quiet origin main", "rev-list --count HEAD..FETCH_HEAD"]);
});

test("no check without ZCORD_HOME, outside a git clone, offline, or with ZCORD_NO_AUTO_UPDATE=1", async () => {
  expect(await checkForUpdate({ run: fakeGit(UP_TO_DATE).run, env: {} })).toBeNull();
  expect(await checkForUpdate({ repoDir: "/usr/lib/zcord", run: fakeGit({}).run, env: {} })).toBeNull();
  expect(await checkForUpdate({ repoDir: "/zcord", run: fakeGit({ ...UP_TO_DATE, "fetch --quiet origin main": { code: 128, out: "" } }).run, env: {} })).toBeNull();
  const git = fakeGit(UP_TO_DATE);
  expect(await checkForUpdate({ repoDir: "/zcord", run: git.run, env: { ZCORD_NO_AUTO_UPDATE: "1" } })).toBeNull();
  expect(git.calls).toEqual([]);
});

test("with a new version it leaves the flag for the next launch and tells the app; up to date it does nothing", async () => {
  const flags: string[] = [];
  const told: number[] = [];
  const behind = fakeGit({ ...UP_TO_DATE, "rev-list --count HEAD..FETCH_HEAD": { code: 0, out: "2\n" } });
  await scheduleUpdateCheck((n) => told.push(n), { repoDir: "/zcord", run: behind.run, env: {}, writeFlag: (t) => flags.push(t) });
  expect(told).toEqual([2]);
  expect(flags).toEqual(["2\n"]);
  await scheduleUpdateCheck((n) => told.push(n), { repoDir: "/zcord", run: fakeGit(UP_TO_DATE).run, env: {}, writeFlag: (t) => flags.push(t) });
  expect(told).toEqual([2]);
});

test("it tells which GitHub version is waiting (FETCH_HEAD), even if the flag is already there or cannot be written", async () => {
  const SHA = "c".repeat(40);
  const behind = fakeGit({ ...UP_TO_DATE, "rev-list --count HEAD..FETCH_HEAD": { code: 0, out: "2\n" }, "rev-parse FETCH_HEAD": { code: 0, out: SHA + "\n" } });
  const seen: Array<string | null> = [];
  await scheduleUpdateCheck((_, sha) => seen.push(sha), { repoDir: "/zcord", run: behind.run, env: {}, writeFlag: () => {} });
  await scheduleUpdateCheck((_, sha) => seen.push(sha), {
    repoDir: "/zcord",
    run: behind.run,
    env: {},
    writeFlag: () => {
      throw new Error("EACCES");
    },
  });
  const noSha = fakeGit({ ...UP_TO_DATE, "rev-list --count HEAD..FETCH_HEAD": { code: 0, out: "2\n" } });
  await scheduleUpdateCheck((_, sha) => seen.push(sha), { repoDir: "/zcord", run: noSha.run, env: {}, writeFlag: () => {} });
  expect(seen).toEqual([SHA, SHA, null]);
});

test("it looks for updates 15 s after starting and then every 30 min, until stopped", () => {
  jest.useFakeTimers();
  try {
    let checks = 0;
    const stop = startUpdateChecks(() => void (checks += 1));
    jest.advanceTimersByTime(14_000);
    expect(checks).toBe(0);
    jest.advanceTimersByTime(1_000);
    expect(checks).toBe(1);
    jest.advanceTimersByTime(29 * 60_000);
    expect(checks).toBe(1);
    jest.advanceTimersByTime(60_000);
    expect(checks).toBe(2);
    jest.advanceTimersByTime(60 * 60_000);
    expect(checks).toBe(4);
    stop();
    jest.advanceTimersByTime(60 * 60_000);
    expect(checks).toBe(4);
  } finally {
    jest.useRealTimers();
  }
});
