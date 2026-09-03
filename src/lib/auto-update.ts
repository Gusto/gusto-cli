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

/** How many times the swap will retry one stage before dropping it.
 *
 * A rename can fail transiently (a full disk, a permission that gets fixed), which is worth a
 * retry rather than a fresh multi-MB download. But "retry" can't mean forever: nothing else clears
 * a pending stage - `maybeSpawnBackgroundCheck` returns early while one is set - so an install dir
 * that stays unwritable would leave every later invocation opening the staged binary and hashing
 * tens of MB on the startup path before failing the same rename again. That startup cost is the
 * thing this design works hardest to avoid, so the retries are counted and bounded. */
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

  // Written to a sibling and renamed over, rather than truncated in place. `Bun.write` is
  // open(O_TRUNC) then write, and `readState` maps both an empty file and a parse failure to `{}` -
  // "nothing has happened yet" - which it cannot tell from a real first run. So a file left
  // truncated by a Ctrl-C or a kill mid-write didn't just lose the pending stage: the next
  // `maybeSpawnBackgroundCheck` read `{}`, wrote `{...{}, last_checked}`, and permanently erased
  // the entry pointing at a verified release-sized binary, which then sat orphaned in the install
  // dir forever. `rename` is atomic, so every reader now sees either the whole old file or the
  // whole new one. Same discipline `stageAndFinalize` uses for the binary itself.
  // Unique per call, not per process: two writes overlapping inside one process would otherwise
  // share a temp path, and the first `rename` to land would leave the second with nothing to
  // rename. Both callers in the `preAction` hook write this file.
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

/** Runs from the `preAction` hook in `index.ts` - after the config read and after commander has
 * resolved which command matched, but before that command's own handler, which is what keeps the
 * swap off the mid-command path. Not every invocation reaches it: `upgrade` is excluded,
 * `--help`/`--version`/an invalid command never dispatch a handler at all, and the exec-check child
 * skips the hook entirely via `GUSTO_INTERNAL_SKIP_AUTO_UPDATE`. Cheap in the common
 * case (nothing staged): one small file read, no network, no hashing. Only when a background check
 * previously staged something does this re-verify and install it - see `lib/upgrade.ts`'s
 * `stageUpdate` for how it got there. The guardrails that matter: never mid-command (this runs
 * before the handler), the pin (checked below), a stale/mismatched stage (discarded, not installed),
 * and a failed rename (left for the next invocation to retry). Always fails open - an
 * update-subsystem bug must never block the command the caller actually wants. */
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

    // Derived, never read from the state file. A background check only ever stages one place - a
    // sibling of the install target - so the recorded path carries no information this doesn't.
    // Taking it from the file instead made it an arbitrary-path primitive: everything downstream
    // that looks like verification is self-referential, because whoever writes `staged_path` also
    // writes the `staged_checksum` it gets compared against. With local write access to the config
    // dir, that turned "drop a 0755 file anywhere" into "the next gusto invocation installs it as
    // gusto", announced as a routine auto-update. Deriving it costs nothing and removes the
    // primitive outright, so the state file stops being a trust boundary.
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

    // Opened once and held for the rest of this function. `BACKGROUND_STAGING_NAME` keeps
    // `gusto upgrade` out of this path entirely, but it is still a fixed name shared by every
    // background check, and two of those can overlap - see `maybeSpawnBackgroundCheck`, which
    // narrows that race without closing it. So everything below acts on *this descriptor*: the
    // bytes are hashed off it and its identity is re-checked before the path is touched, which is
    // what stops unverified bytes reaching the live binary or another check's in-flight download
    // being deleted by us. Same reasoning (and the same `stagingStillOurs`) as `lib/upgrade.ts`.
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
        // The file at the staging path is not the one we staged. The state entry goes, the file
        // stays: an overlapping background check may own it now, deleting it would sabotage that
        // run, and `preflightStagingPath` already clears a genuine stray next time anything stages
        // here.
        //
        // Reported in every mode, unlike the routine success notice below, because a failing disk
        // and real tampering both look exactly like this and swallowing it in agent mode would let
        // either recur forever. `loadConfig`'s corrupt-config warning sets the precedent: stderr
        // with no mode check, stdout still a clean envelope.
        //
        // Deliberately worded as an observation rather than an accusation. An earlier version said
        // this could only mean the file changed underneath the one process that writes it, which
        // isn't true: the staging name is shared by every background check and two of those can
        // overlap (see the `open` above), so a second check replacing the first's file reaches here
        // too. That's benign, and a notice telling an operator to treat it as tampering when the
        // likeliest cause is a race is worse than no notice. The path is named so there is
        // something to go and look at, and the next line says what to do about it.
        // noboost - the XSS rule matches `.write(` with interpolation; this is a terminal stream in
        // a CLI with no web surface, and every value here comes from our own 0600 state file.
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

      // The checksum above proves integrity - these are the bytes that were staged - but says
      // nothing about freshness. If the live binary changed since the stage was made, installing it
      // now is a downgrade dressed up as an upgrade: the installer stages through its own temp dir
      // (`install.sh`), so a `curl | sh` reinstall to a newer release leaves the staged file and
      // this state entry perfectly intact, and the next invocation would rename the older staged
      // build over the newer installed one while announcing the stale `from -> to` pair.
      //
      // Free when `isSelf` - this process *is* the binary at `targetPath`, so its compiled-in
      // version is the installed one. Otherwise it costs a subprocess spawn, which is worth paying
      // rather than skipping the check: by this point the whole staged binary has already been read
      // and sha256'd, so the spawn is cheaper than what just ran, and `resolveUpgradeTarget` pays
      // exactly this spawn on the same `!isSelf` path to work out `from` to begin with. Skipping it
      // would leave the same downgrade wide open on the other path - reachable whenever
      // `GUSTO_INSTALL_DIR` names a second install, which the README documents as supported.
      //
      // Bounded by `SWAP_EXEC_CHECK_TIMEOUT_MS` rather than the 30s `gusto upgrade` allows a
      // just-downloaded build, because this one runs before the handler of a command nobody
      // invoked to upgrade anything: a target that blocks on init - a wedged build, a stale mount
      // at `GUSTO_INSTALL_DIR` - would otherwise add half a minute to an ordinary `gusto whoami`.
      //
      // Which makes this deadline shorter than the one the stage was recorded under:
      // `resolveUpgradeTarget` probes the same target for `staged_from` with the 30s default. A
      // target that answers between the two - a cold release-sized binary on a network-mounted
      // `GUSTO_INSTALL_DIR` is the realistic one - would therefore stage against a real version and
      // then fail its own freshness check: the stage discarded, a notice claiming "nothing
      // runnable" about a binary that is installed and runnable, and the same release downloaded
      // again next window. So a spawn the deadline killed counts as "not determined this time"
      // rather than as a mismatch - the stage is kept and one bounded attempt is spent, exactly
      // like a rename that failed for a reason that might not repeat. A target that never answers
      // in time still runs out of attempts and is dropped, so nothing lingers.
      //
      // Both sides normalise to `undefined` for "nothing runnable installed", so a stage made when
      // the target was empty still installs into an empty target.
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

/** One more bounded go at a stage this invocation couldn't resolve either way: a rename that
 * failed for a reason that might not repeat, or a freshness probe its own deadline killed. Below
 * the cap the stage and its file are kept and the count climbs, so the next invocation gets another
 * go at bytes already on disk instead of a fresh multi-MB download. Not free, though, which is why
 * the count is bounded at all: the retry re-opens and re-hashes the whole staged binary on the
 * startup path, and a probe the deadline killed waits out `SWAP_EXEC_CHECK_TIMEOUT_MS` again first.
 * One deadline per invocation is still all an ordinary command pays - the bound `upgrade.ts`
 * justifies the short deadline with - and the cap is what stops it being paid invocation after
 * invocation. At the cap both go, because nothing else ever clears a pending stage -
 * `maybeSpawnBackgroundCheck` returns early while one is set.
 *
 * `readState` accepts any string for `swap_attempts`, so the parse has to survive whatever is in
 * the file. A non-numeric value would make every comparison here false and write `String(NaN)`
 * back; a negative one parses fine and is worse, since `attempts >= MAX_SWAP_ATTEMPTS` then stays
 * false for longer than anyone will run this. Either way the cap would never fire and the startup
 * re-hash would go on forever, which is the cost this counter exists to bound - hence a positive
 * integer or nothing. */
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

/** Clears the staged_* fields of the stage `state` observed, and re-reads first so a concurrent
 * `last_checked` update (from `maybeSpawnBackgroundCheck`) survives rather than being written back
 * stale.
 *
 * The equality check catches a *different* stage having replaced ours in the window, but it can't
 * catch a *duplicate* one: `staged_path` is the fixed `BACKGROUND_STAGING_NAME` derived from the
 * install dir, and `staged_version` is whatever the newest release is - both identical for any two
 * concurrent checks, and so is `staged_checksum`, since the bytes are the same. Distinguishing
 * those would take a per-stage nonce, which isn't worth carrying: the cost of losing that race is
 * one orphaned staged file and one more 24h window, not a bad install. */
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

/** Claims the check (writes `last_checked` synchronously) *before* spawning anything, so
 * invocations racing within the same window - the common case, an agent firing several commands
 * in a loop - see it claimed and skip: the fix for the thundering-herd failure mode a naive
 * "check then spawn" has. This is a plain read-then-write with no cross-process lock, so it can't
 * guarantee *exactly* one spawn under a true simultaneous race (two invocations landing within the
 * same read-then-write instant); it only has to make that rare rather than routine. A failed
 * background check is not retried before the next 24h window either; that's an accepted trade-off
 * for staying simple. Fails open, like `swapStagedUpdate`. */
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
    // Same reasoning, but for integrity rather than convergence. `envForSubprocess` hands the whole
    // environment to the detached child, so a single `GUSTO_CLI_REPO=someone/fork gusto whoami`
    // would stage a binary from that origin - checksummed against *that* repo's own `SHA256SUMS`,
    // so every integrity check downstream passes - and a later ordinary invocation with no override
    // set would rename it over the live binary and report it as an auto-update. Nothing in the
    // staged state records where the bytes came from, and it shouldn't have to: an origin override
    // is an explicit thing someone typed, so it belongs to `gusto upgrade` and never to the
    // unattended path.
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
  // Re-asserted here, not just in `maybeSpawnBackgroundCheck`, because this is reachable without
  // going through it: `--internal-background-update` is a flag anyone can type and `index.ts`
  // dispatches it upstream of every other check. Without the repo check,
  // `GUSTO_CLI_REPO=someone/fork gusto --internal-background-update` stages that fork's binary with
  // a complete state entry - checksummed against the fork's own SHA256SUMS, so nothing downstream
  // can tell it apart - and the next ordinary invocation with no override set installs it over the
  // live binary and calls it a routine auto-update. Guarding only the spawn left that guard
  // describing an attack it didn't actually prevent.
  //
  // `GUSTO_CLI_BASE_URL` is deliberately *not* refused here, even though the trigger refuses it.
  // The trigger's reason is convergence, not integrity: with a base URL there's no tag to compare,
  // so an unattended check would re-stage the same bytes every window forever. It can't produce an
  // installable stage either way - `resolveTargetTag` returns a null tag, so `to` is null,
  // `staged_version` is never recorded, and `swapStagedUpdate` returns at its first guard. Leaving
  // it usable is what lets the test suite drive this against a local server offline.
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

/** Removes a staged file we just wrote, but only if it's still the one we wrote.
 *
 * By this point `stageAndFinalize` has closed the descriptor it verified through, so there is no
 * handle left to check identity against - the checksum is the only thing tying this path to our
 * bytes. `BACKGROUND_STAGING_NAME` is shared by every background check, so without the re-hash a
 * check that overlapped ours would have its in-flight download deleted here and then fail with a
 * `staging_path_blocked`. Anything unreadable, changed, or missing is left alone. */
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
