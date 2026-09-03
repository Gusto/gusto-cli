import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONST } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { AutoUpdate } from "./config.ts";
import { configPaths, readConfig } from "./config.ts";
import type { EnvSource } from "./env.ts";
import type { OutputMode, StreamSinks } from "./output.ts";
import {
  BACKGROUND_STAGING_NAME,
  defaultVersionOf,
  envForSubprocess,
  isSelfExecutable,
  pinnedVersion,
  resolveTargetPath,
  type StageDeps,
  stageUpdate,
  stagingStillOurs,
  SWAP_EXEC_CHECK_TIMEOUT_MS,
} from "./upgrade.ts";
import { VERSION } from "./version.ts";

/** Persisted next to `credentials.toml`/`config.toml`, but never user-edited: last background
 * check time, plus (while one is pending) the staged update a later invocation's
 * `swapStagedUpdate` will install. Absence of a field always means "unknown", never "no" - every
 * reader here treats a missing or corrupt state file as "nothing has happened yet." */
export interface UpdateState {
  last_checked?: string;
  staged_version?: string;
  staged_checksum?: string;
  staged_path?: string;
  staged_install_path?: string;
  staged_from?: string;
  /** How many times a swap has tried and failed to install this stage for a reason worth retrying.
   * Stored as a string like every other field here, since the file is flat TOML. */
  swap_attempts?: string;
}

const STALE_MS = 24 * 60 * 60 * 1000;

/** Total swap attempts per stage. Bounded because nothing else clears a pending stage, so an
 * install dir that never becomes writable would make every later invocation re-hash the staged
 * binary on the startup path. */
export const MAX_SWAP_ATTEMPTS = 3;

export function stateFilePath(): string {
  return path.join(configPaths().dir, "update-state.toml");
}

/** Corrupt or missing state is never fatal - both read as "nothing known yet", the same way a
 * corrupt `config.toml` warns and falls back rather than blocking every command. */
export async function readState(file: string = stateFilePath()): Promise<UpdateState> {
  const f = Bun.file(file);
  if (!(await f.exists())) return {};
  const text = await f.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed = parse(text);
    const out: UpdateState = {};
    for (const key of [
      "last_checked",
      "staged_version",
      "staged_checksum",
      "staged_path",
      "staged_install_path",
      "staged_from",
      "swap_attempts",
    ] as const) {
      const value = parsed[key];
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeState(state: UpdateState, file: string = stateFilePath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) if (v !== undefined) out[k] = v;

  // Temp-then-rename, not truncate-in-place: `readState` maps a truncated file to `{}`, which it
  // can't tell from a first run, so a kill mid-write would erase a pending stage and orphan the
  // binary it pointed at. Unique per call - both `preAction` callers write this file.
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await Bun.write(temp, stringify(out));
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

function isPinned(env: EnvSource): boolean {
  return pinnedVersion(env) !== null;
}

export interface SwapDeps {
  cfg: { auto_update?: AutoUpdate };
  env?: EnvSource;
  execPath?: string;
  stateFile?: string;
  sinks: StreamSinks;
  mode: OutputMode;
  /** Whether the open descriptor is still the file at that path. Injectable so a test can force
   * the lost-race branch, which otherwise needs a real concurrent process to hit. */
  stillOurs?: typeof stagingStillOurs;
  /** This build's version, i.e. the installed one when `isSelf`. Injectable for tests. */
  currentVersion?: string;
  /** Reads the version of the binary at a path. Only called when the swap target isn't us; see the
   * freshness check. `onTimeout` fires when the deadline, rather than the binary itself, ended that
   * spawn - a distinction the return value can't carry, since a killed build and an unrunnable one
   * both read as null. Injectable for tests. */
  versionOf?: (file: string, timeoutMs?: number, onTimeout?: () => void) => Promise<string | null>;
}

/** Installs a stage a previous background check left, from the `preAction` hook in `index.ts` -
 * before the matched command's handler, so never mid-command. Cheap when nothing is staged: one
 * small file read. Always fails open; an update bug must never block the command someone ran. */
export async function swapStagedUpdate(deps: SwapDeps): Promise<void> {
  const file = deps.stateFile ?? stateFilePath();
  try {
    // Both free, and both checked before the state file is read: a user who opted out or pinned
    // would otherwise pay a stat, an open, a read and a TOML parse on every command they ever run
    // to reach a decision that needed none of it. Neither branch touches state, so a stage left
    // behind before the opt-out still sits there untouched when it's turned back on.
    if (deps.cfg.auto_update === "off") return;
    const env = deps.env ?? process.env;
    if (isPinned(env)) return;

    const state = await readState(file);
    if (state.staged_version === undefined || state.staged_checksum === undefined) return;

    const pathResult = resolveTargetPath(env, deps.execPath ?? process.execPath);
    if (!pathResult.ok) return;
    const { targetPath, isSelf } = pathResult;

    // Derived, never read back from the state file: opening a recorded path would let whoever can
    // write that file choose what gets renamed over the live binary, and supply the checksum it is
    // checked against. A background check only ever stages here anyway.
    const stagedPath = path.join(path.dirname(targetPath), BACKGROUND_STAGING_NAME);
    if (state.staged_path !== stagedPath) {
      // Either a corrupt entry or one written for a different install dir. The recorded path is
      // not trusted enough to open or unlink, so only the entry goes; a real stray at the derived
      // path is cleared by `preflightStagingPath` the next time anything stages there.
      await discardStage(state, file);
      return;
    }
    const stillOurs = deps.stillOurs ?? stagingStillOurs;
    const currentVersion = deps.currentVersion ?? VERSION;
    const versionOf = deps.versionOf ?? defaultVersionOf;

    // Held open for the rest of this function, and everything below acts on the descriptor rather
    // than the path: two background checks share this fixed name and can overlap, so re-resolving
    // the path could hash one file and rename another.
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(stagedPath, FS_CONST.O_RDONLY);
    } catch {
      // Gone (a concurrent invocation already won the swap) or unreadable - either way there is no
      // verified stage here anymore.
      await discardStage(state, file);
      return;
    }

    try {
      if (!(await handle.stat()).isFile()) {
        await discardStage(state, file);
        return;
      }

      // Off the descriptor rather than the path, so what gets verified is what was opened.
      const actual = createHash("sha256")
        .update(await handle.readFile())
        .digest("hex");
      if (actual !== state.staged_checksum) {
        // The entry goes, the file stays: an overlapping background check may own it now, and
        // `preflightStagingPath` clears a genuine stray next time anything stages here.
        //
        // Reported in every mode, unlike the success notice below, so a failing disk can't recur
        // silently in agent mode. Worded as an observation, not an accusation - two checks
        // overlapping reach this too, and that is benign.
        // noboost - the XSS rule matches `.write(` with interpolation; this is a terminal stream
        // in a CLI with no web surface.
        deps.sinks.stderr.write(
          `gusto: ignored a pending update - the staged file at ${stagedPath} no longer matches its ` + // noboost
            `recorded checksum, so it was not installed. If this repeats, remove that file and ` + // noboost
            `run \`gusto upgrade\` to install a verified build.\n`, // noboost
        );
        await discardStage(state, file);
        return;
      }

      // Staged for a different install target (GUSTO_INSTALL_DIR moved since). The file at the
      // derived path belongs to that other target, so it is left alone and only the entry goes.
      if (state.staged_install_path !== targetPath) {
        await discardStage(state, file);
        return;
      }

      // The checksum proves these are the bytes that were staged, not that they are still newer
      // than what is installed: a `curl | sh` reinstall to a newer release leaves the stage and its
      // state entry intact, so installing now would rename an older build over a newer one and
      // announce the stale pair. Costs a subprocess when the target isn't us, which is worth paying
      // - the whole staged binary has already been hashed by this point.
      //
      // Both sides normalise `undefined` to "nothing runnable installed", so a stage recorded
      // against an empty target still installs into one.
      let probeTimedOut = false;
      const noteTimeout = (): void => {
        probeTimedOut = true;
      };
      const installed = isSelf
        ? currentVersion
        : ((await versionOf(targetPath, SWAP_EXEC_CHECK_TIMEOUT_MS, noteTimeout)) ?? undefined);
      // Checked before the comparison, not inside it: a killed probe means the installed version
      // was not determined, which has to be decided on its own. Inside, a stage recorded when
      // nothing runnable was there (`staged_from` absent) matched the `undefined` a timeout also
      // produces, so the branch was skipped and the stage installed over whatever is now at the
      // target - the very downgrade this check exists to refuse, for the slow-target case the
      // deadline was added for.
      if (probeTimedOut) {
        await countSwapAttempt(state, file, handle, stagedPath, stillOurs);
        return;
      }
      if (state.staged_from !== installed) {
        if (deps.mode === "human") {
          deps.sinks.stderr.write(
            `gusto: ignored a pending update - it was staged against ${state.staged_from ?? "nothing installed"}, ` + // noboost
              `but ${installed ?? "nothing runnable"} is installed now, so it was not installed\n`, // noboost
          );
        }
        if (await stillOurs(handle, stagedPath)) await unlink(stagedPath).catch(() => {});
        await discardStage(state, file);
        return;
      }

      // Immediately before the rename, so what lands on the live binary is what was just hashed.
      // A window remains between this check and the rename - closing it needs `renameat2`, which
      // isn't reachable from here - but it shrinks from the whole hash to a syscall apart.
      if (!(await stillOurs(handle, stagedPath))) {
        await discardStage(state, file);
        return;
      }

      try {
        await rename(stagedPath, targetPath);
      } catch (err) {
        // The source vanished between the check above and this rename - someone else won the swap,
        // and there is nothing left to retry.
        if ((err as { code?: unknown }).code === "ENOENT") {
          await discardStage(state, file);
          return;
        }
        // Anything else (disk full, perms changed) *might* be transient, so the stage is kept - but
        // only for a bounded number of goes, or an install dir that never becomes writable would
        // make every future invocation hash the whole staged binary before failing the same way.
        await countSwapAttempt(state, file, handle, stagedPath, stillOurs);
        return;
      }

      await discardStage(state, file);
      if (deps.mode === "human") {
        const from = state.staged_from ?? "unknown";
        deps.sinks.stderr.write(
          `gusto auto-updated: ${from} -> ${state.staged_version} (opt out: gusto config set auto_update off)\n`, // noboost
        );
      }
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // Fail open.
  }
}

/** One more bounded go at a stage this invocation couldn't resolve either way. Below the cap the
 * stage and its file are kept so the next invocation retries bytes already on disk; at the cap both
 * go. The parse takes a positive integer or nothing: a non-numeric value writes `String(NaN)` back
 * and a negative one compares below the cap forever, either of which disables it. */
async function countSwapAttempt(
  state: UpdateState,
  file: string,
  handle: Awaited<ReturnType<typeof open>>,
  stagedPath: string,
  stillOurs: typeof stagingStillOurs,
): Promise<void> {
  const previous = Number.parseInt(state.swap_attempts ?? "0", 10);
  const attempts = (Number.isInteger(previous) && previous > 0 ? previous : 0) + 1;
  if (attempts >= MAX_SWAP_ATTEMPTS) {
    if (await stillOurs(handle, stagedPath)) await unlink(stagedPath).catch(() => {});
    await discardStage(state, file);
    return;
  }
  const fresh = await readState(file);
  if (fresh.staged_version === state.staged_version && fresh.staged_path === state.staged_path) {
    await writeState({ ...fresh, swap_attempts: String(attempts) }, file);
  }
}

/** Clears the staged_* fields of the stage `state` observed, re-reading first so a concurrent
 * `last_checked` write survives. The equality check catches a *different* stage replacing ours, but
 * not a *duplicate* one - every field is identical for two concurrent checks. Telling those apart
 * needs a per-stage nonce, and losing that race costs one orphaned file, not a bad install. */
export async function discardStage(state: UpdateState, file: string): Promise<void> {
  const fresh = await readState(file);
  if (fresh.staged_version !== state.staged_version || fresh.staged_path !== state.staged_path) return;
  await writeState(
    {
      ...fresh,
      staged_version: undefined,
      staged_checksum: undefined,
      staged_path: undefined,
      staged_install_path: undefined,
      staged_from: undefined,
      swap_attempts: undefined,
    },
    file,
  );
}

/** Argv marker for the detached child this spawns. `index.ts` checks for exactly this string as
 * the very first thing in `main`, before anything else runs - imported from here rather than
 * duplicated, so the two can't drift apart. */
export const BACKGROUND_UPDATE_FLAG = "--internal-background-update";

function defaultSpawnBackgroundCheck(): void {
  Bun.spawn([process.execPath, BACKGROUND_UPDATE_FLAG], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    // All this child does is fetch a public release asset and stage it - it has no use for a
    // credential, and it outlives the process that spawned it. See `envForSubprocess`.
    env: envForSubprocess(),
  }).unref();
}

export interface TriggerDeps {
  cfg: { auto_update?: AutoUpdate };
  env?: EnvSource;
  execPath?: string;
  stateFile?: string;
  /** Injectable for tests; defaults to the real, current time. */
  now?: string;
  spawn?: () => void;
}

/** Claims the window by writing `last_checked` *before* spawning, so invocations racing inside it
 * see it claimed and skip. Read-then-write with no cross-process lock, so it makes a double spawn
 * rare rather than impossible. A failed check waits for the next window. Fails open. */
export async function maybeSpawnBackgroundCheck(deps: TriggerDeps): Promise<void> {
  const file = deps.stateFile ?? stateFilePath();
  try {
    if (deps.cfg.auto_update === "off") return;
    const env = deps.env ?? process.env;
    if (isPinned(env)) return;
    // A base-URL override leaves `resolveTargetTag` with no tag to compare, so `stageUpdate` can
    // never conclude "already up to date" and stages every time. `gusto upgrade` wants exactly that
    // - installing unconditionally is the point of the override - but unattended it is a loop:
    // download, stage, rename an identical build over itself, repeat next window. Leave that
    // override to the explicit command.
    if (env.GUSTO_CLI_BASE_URL !== undefined && env.GUSTO_CLI_BASE_URL.length > 0) return;
    // Integrity rather than convergence: the child inherits this, so a stage built from a fork
    // passes every downstream check (it carries that fork's own SHA256SUMS) and a later ordinary
    // invocation installs it. Nothing records where the bytes came from. Re-checked in
    // `runBackgroundCheck`, which is reachable without going through here.
    if (env.GUSTO_CLI_REPO !== undefined && env.GUSTO_CLI_REPO.length > 0) return;
    // The child is a re-exec of *this* executable, so that's what has to be a `gusto` binary -
    // under `bun run dev` it's the developer's `bun`, and `bun --internal-background-update` never
    // reaches index.ts's flag check. Asked of execPath directly rather than via
    // `resolveTargetPath`, which answers "what should an upgrade replace" and stops looking at
    // execPath at all once GUSTO_INSTALL_DIR is set - see `isSelfExecutable`.
    if (!isSelfExecutable(deps.execPath ?? process.execPath)) return;

    const state = await readState(file);
    // A previous check already staged something that's just waiting on a swap (most likely one
    // that keeps failing - disk full, perms). Checking again would call stageUpdate a second time,
    // whose preflightStagingPath treats the still-good, still-verified file from the first check as
    // a crashed-run stray and deletes it. Nothing to do here until that stage resolves one way or
    // another - swapStagedUpdate owns clearing it, not this function.
    if (state.staged_version !== undefined) return;
    const nowIso = deps.now ?? new Date().toISOString();
    if (state.last_checked !== undefined) {
      // `age >= 0` matters as much as the NaN guard: a `last_checked` in the future - clock skew on
      // a fresh VM, or a config dir restored from a machine ahead in time - makes a negative age
      // satisfy `< STALE_MS` and suppress every check until wall-clock time catches up, with
      // nothing to recover it since the write below is only reached once this gate passes. Falling
      // through instead rewrites the field to now, so a skewed clock costs one early check.
      const age = Date.parse(nowIso) - Date.parse(state.last_checked);
      if (!Number.isNaN(age) && age >= 0 && age < STALE_MS) return;
    }

    await writeState({ ...state, last_checked: nowIso }, file);
    (deps.spawn ?? defaultSpawnBackgroundCheck)();
  } catch {
    // Fail open.
  }
}

/** What the detached child spawned by `maybeSpawnBackgroundCheck` runs, end to end. Its stdio is
 * `/dev/null` by construction, so there is nothing to report to and nothing to wait for - success
 * persists a stage for a later invocation to swap in; anything else (already up to date, blocked,
 * a download/checksum failure) just exits with nothing recorded, silently. */
export async function runBackgroundCheck(
  deps: StageDeps & { stateFile?: string; configFile?: string } = { log: () => {} },
): Promise<void> {
  const file = deps.stateFile ?? stateFilePath();
  const env = deps.env ?? process.env;
  // `--internal-background-update` is a flag anyone can type and `index.ts` dispatches it upstream
  // of every other check, so guarding only the spawn left the origin guard describing an attack it
  // didn't prevent.
  //
  // `GUSTO_CLI_BASE_URL` is deliberately not refused here even though the trigger refuses it: with
  // a base URL there is no tag, so `to` is null, `staged_version` is never recorded, and the swap
  // returns at its first guard. It cannot produce an installable stage, and leaving it usable is
  // what lets the tests drive this offline.
  if (isPinned(env)) return;
  if (env.GUSTO_CLI_REPO !== undefined && env.GUSTO_CLI_REPO.length > 0) return;
  if (!isSelfExecutable(deps.execPath ?? process.execPath)) return;
  try {
    const result = await stageUpdate(deps);
    if (!result.ok || result.data.status !== "staged") return;

    // Config is re-read *after* the download rather than before it, because this process outlives
    // the invocation that spawned it - by minutes, on a slow link. `auto_update` can be turned off
    // in that window, including by the very command that spawned this child (the trigger runs
    // before dispatch, so it sees the pre-command value). Recording the stage anyway would leave a
    // release-sized binary that nothing will ever consume, since swapping is now disabled - and no
    // later `preflightStagingPath` runs to clear it either. So: clean up and record nothing.
    const cfg = await readConfigForBackgroundCheck(deps.configFile);
    if (cfg.auto_update === "off") {
      await unlinkIfStillOurs(result.data.staged_path, result.data.staged_checksum);
      return;
    }

    const state = await readState(file);
    await writeState(
      {
        ...state,
        staged_version: result.data.to ?? undefined,
        staged_checksum: result.data.staged_checksum,
        staged_path: result.data.staged_path,
        staged_install_path: result.data.install_path,
        staged_from: result.data.from ?? undefined,
      },
      file,
    );
  } catch {
    // Fail open.
  }
}

/** Removes a staged file we just wrote, but only if it's still the one we wrote. `stageAndFinalize`
 * has already closed the descriptor it verified through, so this re-opens and re-hashes: the
 * staging name is shared by every background check, and deleting on the path alone would take out
 * an overlapping check's in-flight download. Anything changed or missing is left alone. */
async function unlinkIfStillOurs(stagedPath: string | undefined, expected: string | undefined): Promise<void> {
  if (stagedPath === undefined || expected === undefined) return;
  try {
    const handle = await open(stagedPath, FS_CONST.O_RDONLY);
    try {
      const actual = createHash("sha256")
        .update(await handle.readFile())
        .digest("hex");
      if (actual !== expected) return;
      if (await stagingStillOurs(handle, stagedPath)) await unlink(stagedPath).catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // Gone or unreadable - nothing of ours to remove.
  }
}

/** The `auto_update` value as of right now, for the post-download re-check above. Reads the config
 * file directly rather than taking a `UserConfig` from the caller, because the whole point is to
 * see a write that landed after this process started. Unreadable or corrupt reads as unset, which
 * leaves the stage in place - the same fail-open direction as everything else here. */
async function readConfigForBackgroundCheck(configFile?: string): Promise<{ auto_update?: AutoUpdate }> {
  try {
    return await readConfig(configFile === undefined ? undefined : { dir: path.dirname(configFile), file: configFile });
  } catch {
    return {};
  }
}
