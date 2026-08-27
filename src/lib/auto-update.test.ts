import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discardStage,
  maybeSpawnBackgroundCheck,
  readState,
  runBackgroundCheck,
  swapStagedUpdate,
  writeState,
} from "./auto-update.ts";
import { captureSinks } from "./test-support.ts";

const scratchDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stateDir + installDir pair, with a real "installed" binary and (optionally) a real staged one
 * whose checksum genuinely matches - so swap tests exercise the real hashing path, not a stub. */
function setup(opts: { installedBody?: string; stagedBody?: string } = {}) {
  const stateDir = tmpDir("gusto-cli-autoupdate-state-");
  const installDir = tmpDir("gusto-cli-autoupdate-install-");
  const stateFile = path.join(stateDir, "update-state.toml");
  const installedPath = path.join(installDir, "gusto");
  writeFileSync(installedPath, opts.installedBody ?? '#!/bin/sh\necho "0.2.0"\n', { mode: 0o755 });

  let stagedPath: string | undefined;
  let stagedChecksum: string | undefined;
  if (opts.stagedBody !== undefined) {
    stagedPath = path.join(installDir, ".gusto-upgrade");
    writeFileSync(stagedPath, opts.stagedBody, { mode: 0o755 });
    stagedChecksum = createHash("sha256").update(opts.stagedBody).digest("hex");
  }

  return { stateFile, installDir, installedPath, stagedPath, stagedChecksum };
}

describe("swapStagedUpdate", () => {
  test("no-op when nothing is staged", async () => {
    const { stateFile, installedPath } = setup();
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: {}, sinks, mode: "human" });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(stderr.buffer).toBe("");
  });

  test("swaps a verified staged binary into place and prints a notice in human mode", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        last_checked: "2026-08-26T00:00:00.000Z",
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: "0.2.0",
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath, "utf8")).toBe(STAGED_BODY);
    expect(existsSync(stagedPath!)).toBe(false);
    expect(stderr.buffer).toContain("0.2.0");
    expect(stderr.buffer).toContain("0.3.0");
    expect(stderr.buffer).toContain("auto_update off");
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
    expect(state.last_checked).toBe("2026-08-26T00:00:00.000Z");
  });

  test("swaps silently (no stderr) in agent mode", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "agent" });

    expect(readFileSync(installedPath, "utf8")).toBe(STAGED_BODY);
    expect(stderr.buffer).toBe("");
  });

  test("leaves the stage untouched when GUSTO_CLI_VERSION is pinned", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
      },
      stateFile,
    );
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir, GUSTO_CLI_VERSION: "v0.2.0" },
      sinks,
      mode: "human",
    });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(existsSync(stagedPath!)).toBe(true);
    expect(stderr.buffer).toBe("");
    const state = await readState(stateFile);
    expect(state.staged_version).toBe("0.3.0");
  });

  // GUSTO_CLI_VERSION=latest is not a pin anywhere else in this codebase - resolveTargetTag in
  // lib/upgrade.ts explicitly excludes it and does the real release lookup instead. The
  // auto-update path has to agree, or the same env var means two different things depending on
  // which code path reads it.
  test("does not treat GUSTO_CLI_VERSION=latest as a pin", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
      },
      stateFile,
    );
    const { sinks } = captureSinks();

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir, GUSTO_CLI_VERSION: "latest" },
      sinks,
      mode: "human",
    });

    expect(readFileSync(installedPath, "utf8")).toBe(STAGED_BODY);
  });

  test("leaves the stage untouched when auto_update is off", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
      },
      stateFile,
    );
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({
      stateFile,
      env: { GUSTO_INSTALL_DIR: installDir },
      cfg: { auto_update: "off" },
      sinks,
      mode: "human",
    });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(existsSync(stagedPath!)).toBe(true);
    expect(stderr.buffer).toBe("");
    const state = await readState(stateFile);
    expect(state.staged_version).toBe("0.3.0");
  });

  test("discards a staged file whose checksum no longer matches, without swapping", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: "0".repeat(64),
        staged_path: stagedPath,
        staged_install_path: installedPath,
      },
      stateFile,
    );
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(existsSync(stagedPath!)).toBe(false);
    expect(stderr.buffer).toBe("");
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
  });

  test("discards stale state when the staged file no longer exists", async () => {
    const { stateFile, installDir, installedPath } = setup();
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: "a".repeat(64),
        staged_path: path.join(installDir, ".gusto-upgrade"),
        staged_install_path: installedPath,
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(stderr.buffer).toBe("");
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
  });

  test("discards a stage recorded for a different install target", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: "/somewhere/else/gusto",
      },
      stateFile,
    );
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(stderr.buffer).toBe("");
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
  });
});

describe("maybeSpawnBackgroundCheck", () => {
  test("does not spawn when auto_update is off", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({ cfg: { auto_update: "off" }, env: {}, stateFile, spawn: () => spawned++ });

    expect(spawned).toBe(0);
    expect((await readState(stateFile)).last_checked).toBeUndefined();
  });

  test("does not spawn when GUSTO_CLI_VERSION is pinned", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: { GUSTO_CLI_VERSION: "v0.2.0" },
      stateFile,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
  });

  test("spawns when GUSTO_CLI_VERSION is latest, since that is not a pin", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: { GUSTO_CLI_VERSION: "latest" },
      stateFile,
      now: "2026-08-27T12:00:00.000Z",
      spawn: () => spawned++,
    });

    expect(spawned).toBe(1);
  });

  // Otherwise a redundant check - triggered only because the *previous* successful stage is still
  // waiting on a swap that keeps failing (disk full, perms) - would call stageUpdate again, whose
  // preflightStagingPath treats the still-good, still-verified staged file from the first check as
  // a crashed-run stray and deletes it before staging the new download. The fix is simpler than
  // detecting that: never re-check while something is already staged and waiting.
  test("does not spawn while a previous stage is still pending a swap", async () => {
    const { stateFile } = setup();
    await writeState({ last_checked: "2020-01-01T00:00:00.000Z", staged_version: "0.3.0" }, stateFile);
    let spawned = 0;

    await maybeSpawnBackgroundCheck({ cfg: {}, env: {}, stateFile, spawn: () => spawned++ });

    expect(spawned).toBe(0);
    // Untouched, including the stale last_checked - swapStagedUpdate, not this function, owns
    // clearing it once the stage is actually resolved.
    expect((await readState(stateFile)).last_checked).toBe("2020-01-01T00:00:00.000Z");
  });

  test("spawns and claims the check on a fresh (never-checked) state", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: {},
      stateFile,
      now: "2026-08-27T12:00:00.000Z",
      spawn: () => spawned++,
    });

    expect(spawned).toBe(1);
    expect((await readState(stateFile)).last_checked).toBe("2026-08-27T12:00:00.000Z");
  });

  test("does not spawn again within 24h of the last check", async () => {
    const { stateFile } = setup();
    await writeState({ last_checked: "2026-08-27T00:00:00.000Z" }, stateFile);
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: {},
      stateFile,
      now: "2026-08-27T12:00:00.000Z",
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
  });

  test("spawns again once the last check is more than 24h old", async () => {
    const { stateFile } = setup();
    await writeState({ last_checked: "2026-08-26T00:00:00.000Z" }, stateFile);
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: {},
      stateFile,
      now: "2026-08-27T12:00:00.000Z",
      spawn: () => spawned++,
    });

    expect(spawned).toBe(1);
    expect((await readState(stateFile)).last_checked).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("runBackgroundCheck", () => {
  function stubFetch(impl: (url: string | URL) => Promise<Response>): typeof fetch {
    return impl as unknown as typeof fetch;
  }

  test("persists a staged update to state on success", async () => {
    const { stateFile, installDir, installedPath } = setup({ installedBody: '#!/bin/sh\necho "0.2.0"\n' });
    const NEW_BINARY = '#!/bin/sh\necho "0.3.0"\n';
    const hash = createHash("sha256").update(NEW_BINARY).digest("hex");

    await runBackgroundCheck({
      stateFile,
      log: () => {},
      env: { GUSTO_INSTALL_DIR: installDir, GUSTO_CLI_VERSION: "v0.3.0" },
      currentVersion: "0.2.0",
      platform: "linux",
      arch: "x64",
      fetchImpl: stubFetch(async (url) => {
        const name = url.toString().split("/").pop() ?? "";
        if (name === "SHA256SUMS") return new Response(`${hash}  gusto-linux-x64\n`);
        if (name === "gusto-linux-x64") return new Response(NEW_BINARY);
        return new Response("not found", { status: 404 });
      }),
      versionOf: async (file) => readFileSync(file, "utf8").match(/"([0-9.]+)"/)?.[1] ?? null,
    });

    const state = await readState(stateFile);
    expect(state.staged_version).toBe("0.3.0");
    expect(state.staged_checksum).toBe(hash);
    expect(state.staged_install_path).toBe(installedPath);
    expect(state.staged_from).toBe("0.2.0");
    expect(existsSync(state.staged_path!)).toBe(true);
    // The installed binary itself is untouched - staging never renames.
    expect(readFileSync(installedPath, "utf8")).toContain("0.2.0");
  });

  test("persists nothing when already up to date", async () => {
    const { stateFile, installDir } = setup({ installedBody: '#!/bin/sh\necho "0.3.0"\n' });

    await runBackgroundCheck({
      stateFile,
      log: () => {},
      env: { GUSTO_INSTALL_DIR: installDir, GUSTO_CLI_VERSION: "v0.3.0" },
      currentVersion: "0.3.0",
      platform: "linux",
      arch: "x64",
      fetchImpl: stubFetch(async () => new Response("not found", { status: 404 })),
      versionOf: async (file) => readFileSync(file, "utf8").match(/"([0-9.]+)"/)?.[1] ?? null,
    });

    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
  });
});

describe("discardStage", () => {
  test("clears the observed stage when nothing has changed since", async () => {
    const { stateFile } = setup();
    await writeState({ last_checked: "t0", staged_version: "0.3.0", staged_path: "/a" }, stateFile);
    const observed = await readState(stateFile);

    await discardStage(observed, stateFile);

    const after = await readState(stateFile);
    expect(after.staged_version).toBeUndefined();
    expect(after.last_checked).toBe("t0");
  });

  // The race this guards: invocation A reads state and decides to discard it. Before A writes that
  // decision, a concurrent background check (from a different invocation) finishes and persists a
  // fresh stage. A blindly writing its stale decision would erase the fresh stage - orphaning a
  // just-verified binary on disk with nothing in state pointing at it.
  test("does not clobber a fresher stage written after it observed state", async () => {
    const { stateFile } = setup();
    await writeState({ last_checked: "t0", staged_version: "0.3.0", staged_path: "/a" }, stateFile);
    const observed = await readState(stateFile);

    await writeState({ last_checked: "t1", staged_version: "0.4.0", staged_path: "/b" }, stateFile);

    await discardStage(observed, stateFile);

    const after = await readState(stateFile);
    expect(after.staged_version).toBe("0.4.0");
    expect(after.staged_path).toBe("/b");
  });
});

describe("writeState", () => {
  test("writes the state file at 0600, like config.toml and credentials.toml", async () => {
    const { stateFile } = setup();

    await writeState({ last_checked: "t0" }, stateFile);

    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });
});
