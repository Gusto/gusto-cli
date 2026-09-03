import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discardStage,
  MAX_SWAP_ATTEMPTS,
  maybeSpawnBackgroundCheck,
  readState,
  runBackgroundCheck,
  swapStagedUpdate,
  writeState,
} from "./auto-update.ts";
import { captureSinks } from "./test-support.ts";
import { BACKGROUND_STAGING_NAME, SWAP_EXEC_CHECK_TIMEOUT_MS } from "./upgrade.ts";
import { VERSION } from "./version.ts";

/** What the "installed" fixture binary reports for `--version`. The freshness check in
 * `swapStagedUpdate` really does spawn it on the `!isSelf` path, so a fixture that expects the swap
 * to proceed has to record this as the version it was staged against. */
const INSTALLED_VERSION = "0.2.0";

const scratchDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()!;
    // A test may have made the dir read-only; restore before removing.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone or never ours.
    }
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
  writeFileSync(installedPath, opts.installedBody ?? `#!/bin/sh\necho "${INSTALLED_VERSION}"\n`, {
    mode: 0o755,
  });

  let stagedPath: string | undefined;
  let stagedChecksum: string | undefined;
  if (opts.stagedBody !== undefined) {
    // The name a background check actually stages under. The swap reads the path out of state
    // rather than reconstructing it, so this literal doesn't change behaviour - but staging the
    // fixture at the interactive name would suggest the two paths share one file, which is the
    // thing `BACKGROUND_STAGING_NAME` exists to prevent.
    stagedPath = path.join(installDir, BACKGROUND_STAGING_NAME);
    writeFileSync(stagedPath, opts.stagedBody, { mode: 0o755 });
    stagedChecksum = createHash("sha256").update(opts.stagedBody).digest("hex");
  }

  // Lives next to the state file, mirroring the real config dir layout.
  const configFile = path.join(stateDir, "config.toml");

  return { stateFile, configFile, installDir, installedPath, stagedPath, stagedChecksum };
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
        staged_from: INSTALLED_VERSION,
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
        staged_from: INSTALLED_VERSION,
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

  // A mismatch means the file at the staging path is *not* the one we staged - and since
  // `.gusto-upgrade` is a fixed name every stage and every `gusto upgrade` shares, the likeliest
  // reason is that another process has already claimed it for its own in-flight download.
  // Deleting it would sabotage that run, so the state entry is dropped and the file is left where
  // it is; `preflightStagingPath` clears a genuine stray next time anything stages there.
  test("gives up a checksum-mismatched stage without deleting the file, and never swaps", async () => {
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
    const stagedBefore = readFileSync(stagedPath!);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(readFileSync(stagedPath!)).toEqual(stagedBefore);
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
    expect(stderr.buffer).toContain("checksum");
  });

  // Unlike the routine "auto-updated" notice, this one is reported in agent mode too. Only a
  // background check ever writes the staged file, so a mismatch means it changed underneath the
  // one process that touches it - an anomaly worth surfacing rather than a routine event. Precedent
  // is `loadConfig`'s corrupt-config warning, which also goes to stderr with no mode check; stdout
  // stays a clean envelope either way, which is the contract that actually matters.
  test("reports a checksum-mismatched stage in agent mode too, naming the file", async () => {
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
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "agent" });

    expect((await readState(stateFile)).staged_version).toBeUndefined();
    expect(stderr.buffer).toContain("checksum");
    // Names the file, so there is something to go and look at.
    expect(stderr.buffer).toContain(stagedPath!);
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

  // Recorded against an install target that isn't the one resolving now - GUSTO_INSTALL_DIR moved
  // since the stage was made. Nothing will ever look at the old directory again, so dropping only
  // the state entry would strand a release-sized binary there permanently. The checksum matches
  // here, which is what makes deleting it safe: it proves the file is the one we staged rather
  // than something another process now owns.
  test("removes the staged file, not just the state entry, when the install target moved", async () => {
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
    expect(existsSync(stagedPath!)).toBe(false);
    expect(stderr.buffer).toBe("");
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
  });

  // The other half of that: if the file at the recorded path is *not* the one we staged, it isn't
  // ours to delete even though the install target moved - it may be a concurrent run's download.
  test("leaves a mismatched file alone when the install target moved", async () => {
    const { stateFile, installDir, installedPath, stagedPath } = setup({ stagedBody: "someone else's bytes\n" });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: "0".repeat(64),
        staged_path: stagedPath,
        staged_install_path: "/somewhere/else/gusto",
      },
      stateFile,
    );
    const stagedBefore = readFileSync(stagedPath!);
    const { sinks } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(stagedPath!)).toEqual(stagedBefore);
    expect((await readState(stateFile)).staged_version).toBeUndefined();
    expect(readFileSync(installedPath, "utf8")).toContain("0.2.0");
  });

  // The rename must act on the file that was just hashed. `.gusto-upgrade` is a fixed name shared
  // with every `gusto upgrade` and every background stage, so a concurrent run can replace it
  // between the hash and the rename - and renaming then installs bytes nothing ever verified onto
  // the live binary. `upgrade.ts` guards its own staging with the same identity check; this pins
  // that the swap refuses rather than installing an unverified file.
  test("refuses to swap when the staged file is replaced after it was verified", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: INSTALLED_VERSION,
      },
      stateFile,
    );
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir },
      sinks,
      mode: "human",
      // Stands in for the race: the file we hashed is no longer the file at that path.
      stillOurs: async () => false,
    });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(stderr.buffer).toBe("");
    expect((await readState(stateFile)).staged_version).toBeUndefined();
  });

  // The checksum proves integrity - these are the bytes we staged - but says nothing about
  // freshness. If something replaced the live binary after the stage was made (the installer, which
  // stages through its own mktemp dir and so leaves `.gusto-upgrade` untouched), installing the
  // stage now is a *downgrade*, announced as an upgrade. `execPath` pointing at the install target
  // makes this process's own VERSION the version on disk, so the check costs nothing there.
  test("discards a stage whose recorded from-version no longer matches what is installed", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        // Staged when 0.1.0 was installed; the running binary reports package.json's version, so
        // these deliberately disagree - something replaced the install behind our back.
        staged_from: "0.1.0",
      },
      stateFile,
    );
    const before = readFileSync(installedPath);
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir },
      // Makes isSelf true, which is what lets the swap know the installed version for free.
      execPath: installedPath,
      sinks,
      mode: "human",
    });

    expect(readFileSync(installedPath)).toEqual(before);
    expect(existsSync(stagedPath!)).toBe(false);
    // Names both versions, so the reason it was skipped is legible rather than mysterious.
    expect(stderr.buffer).toContain("staged against 0.1.0");
    expect(stderr.buffer).toContain(`${VERSION} is installed`);
    expect((await readState(stateFile)).staged_version).toBeUndefined();
  });

  test("still swaps when the recorded from-version matches what is installed", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: VERSION,
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir },
      execPath: installedPath,
      sinks,
      mode: "human",
    });

    expect(readFileSync(installedPath, "utf8")).toBe(STAGED_BODY);
    expect(stderr.buffer).toContain("auto-updated");
  });

  // The same downgrade the isSelf case above refuses, on the path where the swap target isn't this
  // process - which `GUSTO_INSTALL_DIR` naming a second install reaches, and the README documents
  // as supported. The checksum proves the bytes and `staged_install_path` proves the destination;
  // neither looks at what is actually installed there now, so without a spawn a stage made against
  // an older release renames over a newer one that landed out of band.
  test("discards a stale stage on the !isSelf path, where the installed version costs a spawn", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    // Installed is 0.4.0 - newer than the 0.2.0 this stage was built against.
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({
      installedBody: '#!/bin/sh\necho "0.4.0"\n',
      stagedBody: STAGED_BODY,
    });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: "0.2.0",
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    // No execPath override, so the swap target is not this process: the real `versionOf` spawn runs.
    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath, "utf8")).toContain("0.4.0");
    expect(stderr.buffer).toContain("staged against 0.2.0");
    expect(stderr.buffer).toContain("0.4.0 is installed now");
    expect((await readState(stateFile)).staged_version).toBeUndefined();
    expect(existsSync(stagedPath!)).toBe(false);
  });

  // The mirror of that on the same path: the spawn reports the very version the stage was recorded
  // against, so the freshness check confirms the stage rather than refusing it, and the swap runs.
  test("still swaps on the !isSelf path when the target reports the version it was staged against", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: INSTALLED_VERSION,
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath, "utf8")).toBe(STAGED_BODY);
    expect(stderr.buffer).toContain("auto-updated");
  });

  // The deadline that spawn is given, which this path can't leave to the 30s default: it runs
  // before the handler of a command nobody invoked to upgrade anything, so a target that blocks
  // on init - a wedged build, a stale mount at `GUSTO_INSTALL_DIR` - has to cost that command a
  // moment rather than half a minute.
  test("bounds the !isSelf freshness spawn by the short swap deadline", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: INSTALLED_VERSION,
      },
      stateFile,
    );
    const { sinks } = captureSinks();
    const deadlines: (number | undefined)[] = [];

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir },
      sinks,
      mode: "human",
      versionOf: async (_file, timeoutMs) => {
        deadlines.push(timeoutMs);
        return INSTALLED_VERSION;
      },
    });

    expect(deadlines).toEqual([SWAP_EXEC_CHECK_TIMEOUT_MS]);
  });

  // And the `installed === undefined` case the check normalises for: nothing runnable at the target
  // at all, so the spawn reports no version, which has to match a stage recorded against nothing
  // installed rather than reading as a mismatch. Otherwise a stage made into an empty
  // `GUSTO_INSTALL_DIR` could never complete - the absent `staged_from` would never equal it.
  test("still swaps on the !isSelf path when nothing is installed at the target yet", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    // Nothing for `versionOf` to spawn, which is what makes it report no version.
    rmSync(installedPath);
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        // No `staged_from`: this stage was recorded with nothing installed there.
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect(readFileSync(installedPath, "utf8")).toBe(STAGED_BODY);
    expect(stderr.buffer).toContain("auto-updated");
  });

  // The timeout has to be decided before the version comparison rather than inside it. A stage
  // recorded when nothing runnable was at the target carries no `staged_from`, which matched the
  // `undefined` a killed probe also produces - so the retry branch was skipped and the stage
  // installed over whatever is at the target now, which is the downgrade this check exists to
  // refuse, in exactly the slow-target case the deadline was introduced for.
  test("does not install over an undetermined target just because the stage recorded no from-version", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    // Newer than the stage, and installed - but too slow to answer inside the deadline.
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({
      installedBody: '#!/bin/sh\necho "0.9.0"\n',
      stagedBody: STAGED_BODY,
    });
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

    await swapStagedUpdate({
      stateFile,
      cfg: {},
      env: { GUSTO_INSTALL_DIR: installDir },
      sinks,
      mode: "human",
      versionOf: async (_file, _timeoutMs, onTimeout) => {
        onTimeout?.();
        return null;
      },
    });

    expect(readFileSync(installedPath, "utf8")).toContain("0.9.0");
    expect(existsSync(stagedPath!)).toBe(true);
    expect((await readState(stateFile)).swap_attempts).toBe("1");
    // Nothing claimed about a version it never read.
    expect(stderr.buffer).toBe("");
  });

  // A probe its deadline killed is not a mismatch. This deadline is `SWAP_EXEC_CHECK_TIMEOUT_MS`
  // while `staged_from` was recorded under the 30s default, so a target that answers between the
  // two - a cold release-sized binary on a network-mounted install dir - would otherwise have a
  // good stage deleted, be described as "nothing runnable" while it sits there installed and
  // runnable, and have the same release downloaded again next window, forever.
  test("keeps the stage for a bounded retry when the freshness probe hits its deadline", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: INSTALLED_VERSION,
      },
      stateFile,
    );
    const { sinks, stderr } = captureSinks();
    const swap = async (): Promise<void> => {
      await swapStagedUpdate({
        stateFile,
        cfg: {},
        env: { GUSTO_INSTALL_DIR: installDir },
        sinks,
        mode: "human",
        // What the real `defaultVersionOf` reports when the deadline, not the binary, ended the
        // spawn: no version, plus the callback that says which of the two it was.
        versionOf: async (_file, _timeoutMs, onTimeout) => {
          onTimeout?.();
          return null;
        },
      });
    };

    // Below the cap the stage survives untouched and the count climbs, so a target that is merely
    // slow this time gets another go rather than a fresh multi-MB download next window.
    for (let attempt = 1; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
      await swap();
      const state = await readState(stateFile);
      expect(state.staged_version).toBe("0.3.0");
      expect(state.swap_attempts).toBe(String(attempt));
      expect(existsSync(stagedPath!)).toBe(true);
      // Nothing announced either: nothing has been decided about this stage yet.
      expect(stderr.buffer).toBe("");
    }

    // The cap still applies, since nothing else clears a pending stage.
    await swap();
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
    expect(existsSync(stagedPath!)).toBe(false);
    expect(readFileSync(installedPath, "utf8")).toContain(INSTALLED_VERSION);
  });

  // The rename's two failure branches, which behave deliberately differently. ENOENT means the
  // staged file went away between the lstat and the rename - another invocation won the swap, so
  // the stage is gone for good and the state entry goes with it. Anything else is transient (a full
  // disk, permissions changed) and the stage is left exactly where it is, so the next invocation
  // retries for free rather than re-downloading.
  test("clears the state entry when the rename fails because the source vanished", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    // An install dir that doesn't exist, so `rename` onto it fails ENOENT while the staged file
    // itself is present and hashes correctly.
    const missingDir = path.join(tmpDir("gusto-cli-autoupdate-gone-"), "not-created");
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: path.join(missingDir, "gusto"),
      },
      stateFile,
    );
    const { sinks } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: missingDir }, sinks, mode: "human" });

    expect((await readState(stateFile)).staged_version).toBeUndefined();
  });

  test.skipIf(process.getuid?.() === 0)("keeps the stage for a retry when the rename fails transiently", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        staged_from: INSTALLED_VERSION,
      },
      stateFile,
    );
    const { sinks } = captureSinks();
    // Read-only install dir: the staged file is still readable and hashes fine, but `rename` into
    // this directory is refused - EACCES/EPERM, not ENOENT.
    chmodSync(installDir, 0o500);

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });
    chmodSync(installDir, 0o700); // before any assertion can throw and strand the scratch dir

    expect(existsSync(stagedPath!)).toBe(true);
    const state = await readState(stateFile);
    expect(state.staged_version).toBe("0.3.0");
    expect(state.staged_checksum).toBe(stagedChecksum);
  });

  // ...but "keep it for a retry" can't mean forever. An install dir that stays unwritable is not
  // transient, and nothing else clears a pending stage - `maybeSpawnBackgroundCheck` returns early
  // while one is set. Left unbounded, every subsequent invocation would open the staged binary and
  // sha256 tens of MB on the startup path before failing the same rename, which is the one cost
  // this whole design is built to avoid. So the retries are counted and the stage is dropped.
  test("gives up on a stage after repeated rename failures, and removes the staged file", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    // A *directory* where the binary belongs, so `rename` onto it fails EISDIR every time while the
    // install dir itself stays writable. Making the directory unwritable instead - the obvious way
    // to fail a rename - also makes this branch's own `unlink` fail EACCES and get swallowed, so
    // the stage would read as dropped from the state file while the file stayed on disk at release
    // size, and deleting that `unlink` would leave the test green.
    rmSync(installedPath);
    mkdirSync(installedPath);
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
    const swap = async (): Promise<void> => {
      await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });
    };

    // Below the cap the stage survives and the count climbs, so the next invocation retries.
    for (let attempt = 1; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
      await swap();
      const state = await readState(stateFile);
      expect(state.staged_version).toBe("0.3.0");
      expect(state.swap_attempts).toBe(String(attempt));
      expect(existsSync(stagedPath!)).toBe(true);
    }

    // The attempt that reaches the cap drops both the state entry and the file itself.
    await swap();
    const state = await readState(stateFile);
    expect(state.staged_version).toBeUndefined();
    expect(state.swap_attempts).toBeUndefined();
    expect(existsSync(stagedPath!)).toBe(false);
  });

  // The count is read back out of a file, so a value that isn't a number has to be survivable:
  // `Number("?") + 1` is NaN, every comparison against the cap is false, and `String(NaN)` would go
  // straight back to disk - leaving the cap permanently unreachable and every later invocation
  // re-hashing the whole staged binary on the startup path before failing the same rename.
  test("treats a non-numeric swap_attempts as zero instead of disabling the cap", async () => {
    const STAGED_BODY = '#!/bin/sh\necho "0.3.0"\n';
    const { stateFile, installDir, installedPath, stagedPath, stagedChecksum } = setup({ stagedBody: STAGED_BODY });
    rmSync(installedPath);
    mkdirSync(installedPath);
    await writeState(
      {
        staged_version: "0.3.0",
        staged_checksum: stagedChecksum,
        staged_path: stagedPath,
        staged_install_path: installedPath,
        swap_attempts: "not-a-number",
      },
      stateFile,
    );
    const { sinks } = captureSinks();

    await swapStagedUpdate({ stateFile, cfg: {}, env: { GUSTO_INSTALL_DIR: installDir }, sinks, mode: "human" });

    expect((await readState(stateFile)).swap_attempts).toBe("1");
  });
});

describe("maybeSpawnBackgroundCheck", () => {
  // Every case here has to name an `execPath` that looks like an installed `gusto`: under the test
  // runner `process.execPath` is `bun`, which `isSelfExecutable` rejects, so a case that leaves it
  // out passes on that gate alone and never reaches the one it is named for.
  test("does not spawn when auto_update is off", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: { auto_update: "off" },
      env: {},
      execPath: "/usr/local/bin/gusto",
      stateFile,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
    expect((await readState(stateFile)).last_checked).toBeUndefined();
  });

  test("does not spawn when GUSTO_CLI_VERSION is pinned", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: { GUSTO_CLI_VERSION: "v0.2.0" },
      execPath: "/usr/local/bin/gusto",
      stateFile,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
  });

  // A base-URL override makes `resolveTargetTag` return no tag at all, so `resolveUpgradeTarget`
  // can never reach its up-to-date branch and `stageUpdate` stages unconditionally. That's correct
  // for `gusto upgrade`, where installing regardless is the documented point of the override, but
  // unattended it never converges: every window re-downloads the same asset and the next
  // invocation renames it over an identical binary, announcing `0.2.0 -> 0.2.0` forever.
  test("does not spawn when GUSTO_CLI_BASE_URL points at a custom origin", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: { GUSTO_CLI_BASE_URL: "http://localhost:9999" },
      execPath: "/usr/local/bin/gusto",
      stateFile,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
    expect((await readState(stateFile)).last_checked).toBeUndefined();
  });

  // Same shape as the base-URL bail, but the stake is integrity rather than convergence: the child
  // inherits the whole environment, so this override would have it stage a binary from a different
  // origin - checksummed against that origin's own SHA256SUMS, so nothing downstream can tell -
  // for a later ordinary invocation to install and report as an auto-update.
  test("does not spawn when GUSTO_CLI_REPO points at a different origin", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: { GUSTO_CLI_REPO: "someone/fork" },
      execPath: "/usr/local/bin/gusto",
      stateFile,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
    expect((await readState(stateFile)).last_checked).toBeUndefined();
  });

  // A `last_checked` ahead of now - clock skew on a fresh VM, or a config dir restored from a
  // machine ahead in time - makes the age negative, which satisfies "younger than the window" and
  // would suppress every check until wall-clock time caught up. Nothing would recover it either,
  // since the field is only rewritten once the staleness gate passes.
  test("checks anyway when last_checked is in the future, and resets it", async () => {
    const { stateFile } = setup();
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
    await writeState({ last_checked: future }, stateFile);
    let spawned = 0;
    const now = new Date().toISOString();

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: {},
      execPath: "/usr/local/bin/gusto",
      stateFile,
      now,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(1);
    expect((await readState(stateFile)).last_checked).toBe(now);
  });

  test("spawns when GUSTO_CLI_VERSION is latest, since that is not a pin", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: { GUSTO_CLI_VERSION: "latest" },
      execPath: "/usr/local/bin/gusto",
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

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: {},
      execPath: "/usr/local/bin/gusto",
      stateFile,
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
    // Untouched, including the stale last_checked - swapStagedUpdate, not this function, owns
    // clearing it once the stage is actually resolved.
    expect((await readState(stateFile)).last_checked).toBe("2020-01-01T00:00:00.000Z");
  });

  // What gets re-exec'd is `execPath`, so that - not the upgrade target - is what has to be a
  // `gusto` binary. Under `bun run dev` execPath is the developer's `bun`, and spawning it would
  // fork a doomed child every 24h: `bun --internal-background-update` never reaches index.ts's
  // flag check at all. The GUSTO_INSTALL_DIR row is the one a `resolveTargetPath` check misses -
  // that function stops looking at execPath entirely once an install dir is named.
  test.each([
    ["no install dir override", {} as Record<string, string>],
    ["an install dir override, which does not make execPath runnable", { GUSTO_INSTALL_DIR: "/opt/tools/bin" }],
  ])("does not spawn when execPath is not a gusto binary: %s", async (_label, env) => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env,
      stateFile,
      execPath: "/usr/local/bin/bun",
      spawn: () => spawned++,
    });

    expect(spawned).toBe(0);
    expect((await readState(stateFile)).last_checked).toBeUndefined();
  });

  test("spawns and claims the check on a fresh (never-checked) state", async () => {
    const { stateFile } = setup();
    let spawned = 0;

    await maybeSpawnBackgroundCheck({
      cfg: {},
      env: {},
      execPath: "/usr/local/bin/gusto",
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
      execPath: "/usr/local/bin/gusto",
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
      execPath: "/usr/local/bin/gusto",
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

  // The child outlives the invocation that spawned it, so `auto_update` can be turned off while it
  // is still downloading - including by the very command that spawned it, since the trigger sees
  // the pre-command config. Recording the stage anyway would strand a release-sized binary that
  // nothing will ever consume, because swapping is now disabled. Re-read at the end and clean up.
  test("discards its own staged file when auto_update was turned off while it ran", async () => {
    const { stateFile, installDir, installedPath, configFile } = setup({ installedBody: '#!/bin/sh\necho "0.2.0"\n' });
    const NEW_BINARY = '#!/bin/sh\necho "0.3.0"\n';
    const hash = createHash("sha256").update(NEW_BINARY).digest("hex");

    await runBackgroundCheck({
      stateFile,
      configFile,
      log: () => {},
      env: { GUSTO_INSTALL_DIR: installDir, GUSTO_CLI_VERSION: "v0.3.0" },
      currentVersion: "0.2.0",
      platform: "linux",
      arch: "x64",
      fetchImpl: stubFetch(async (url) => {
        const name = url.toString().split("/").pop() ?? "";
        // Stands in for the race: the opt-out lands while this download is in flight.
        writeFileSync(configFile, 'auto_update = "off"\n');
        if (name === "SHA256SUMS") return new Response(`${hash}  gusto-linux-x64\n`);
        if (name === "gusto-linux-x64") return new Response(NEW_BINARY);
        return new Response("not found", { status: 404 });
      }),
      versionOf: async (file) => readFileSync(file, "utf8").match(/"([0-9.]+)"/)?.[1] ?? null,
    });

    expect((await readState(stateFile)).staged_version).toBeUndefined();
    expect(existsSync(path.join(installDir, BACKGROUND_STAGING_NAME))).toBe(false);
    expect(readFileSync(installedPath, "utf8")).toContain("0.2.0");
  });

  // ...but that cleanup must not delete a file that is no longer the one we staged. By the time it
  // runs, `stageAndFinalize` has closed its descriptor, so the only thing tying the path to our
  // bytes is the checksum - and a `gusto upgrade` that claimed the same name in the meantime would
  // otherwise get its in-flight download deleted, then fail blaming a concurrent run.
  test("leaves the staging path alone on opt-out cleanup when the file is no longer ours", async () => {
    const { stateFile, installDir, configFile } = setup({ installedBody: '#!/bin/sh\necho "0.2.0"\n' });
    const NEW_BINARY = '#!/bin/sh\necho "0.3.0"\n';
    const hash = createHash("sha256").update(NEW_BINARY).digest("hex");
    const stagedPath = path.join(installDir, BACKGROUND_STAGING_NAME);
    const someoneElse = "another run's in-flight download\n";

    await runBackgroundCheck({
      stateFile,
      configFile,
      log: () => {},
      env: { GUSTO_INSTALL_DIR: installDir, GUSTO_CLI_VERSION: "v0.3.0" },
      currentVersion: "0.2.0",
      platform: "linux",
      arch: "x64",
      fetchImpl: stubFetch(async (url) => {
        const name = url.toString().split("/").pop() ?? "";
        writeFileSync(configFile, 'auto_update = "off"\n');
        if (name === "SHA256SUMS") return new Response(`${hash}  gusto-linux-x64\n`);
        if (name === "gusto-linux-x64") return new Response(NEW_BINARY);
        return new Response("not found", { status: 404 });
      }),
      // Runs after staging completes and before the cleanup: stands in for another process
      // claiming the shared staging name in that window.
      versionOf: async (file) => {
        const reported = readFileSync(file, "utf8").match(/"([0-9.]+)"/)?.[1] ?? null;
        writeFileSync(stagedPath, someoneElse);
        return reported;
      },
    });

    expect((await readState(stateFile)).staged_version).toBeUndefined();
    expect(readFileSync(stagedPath, "utf8")).toBe(someoneElse);
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
