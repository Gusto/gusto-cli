import { createHash } from "node:crypto";
import { lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { AutoUpdate } from "./config.ts";
import { configPaths } from "./config.ts";
import type { EnvSource } from "./env.ts";
import type { OutputMode, StreamSinks } from "./output.ts";
import { resolveTargetPath, type StageDeps, stageUpdate } from "./upgrade.ts";

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
}

const STALE_MS = 24 * 60 * 60 * 1000;

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
    const parsed = parse(text) as Record<string, unknown>;
    const out: UpdateState = {};
    for (const key of [
      "last_checked",
      "staged_version",
      "staged_checksum",
      "staged_path",
      "staged_install_path",
      "staged_from",
    ] as const) {
      if (typeof parsed[key] === "string") out[key] = parsed[key] as string;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeState(state: UpdateState, file: string = stateFilePath()): Promise<void> {
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) if (v !== undefined) out[k] = v;
  await Bun.write(file, stringify(out));
  await chmod(file, 0o600);
}

/** `"latest"` is deliberately excluded, matching `resolveTargetTag` in `lib/upgrade.ts` - the same
 * env var has to mean the same thing (no pin, resolve the real latest release) on both the
 * interactive and background paths, or `GUSTO_CLI_VERSION=latest` silently disables auto-update
 * while `gusto upgrade` reads it as "check normally". */
function isPinned(env: EnvSource): boolean {
  const value = env.GUSTO_CLI_VERSION;
  return value !== undefined && value.length > 0 && value !== "latest";
}

export interface SwapDeps {
  cfg: { auto_update?: AutoUpdate };
  env?: EnvSource;
  execPath?: string;
  stateFile?: string;
  sinks: StreamSinks;
  mode: OutputMode;
}

/** Runs at the very top of every invocation, before the command dispatches. Cheap in the common
 * case (nothing staged): one small file read, no network, no hashing. Only when a background check
 * previously staged something does this re-verify and install it - see `lib/upgrade.ts`'s
 * `stageUpdate` for how it got there, and the ticket guardrails this maps to a fix for each of:
 * never mid-command (this runs before dispatch), the pin (checked below), a stale/mismatched stage
 * (discarded, not installed), and a failed rename (left for the next invocation to retry). Always
 * fails open - an update-subsystem bug must never block the command the caller actually wants. */
export async function swapStagedUpdate(deps: SwapDeps): Promise<void> {
  const file = deps.stateFile ?? stateFilePath();
  try {
    const state = await readState(file);
    if (state.staged_version === undefined || state.staged_path === undefined) return;

    // Opting out silences both the update and the notice - including a stage a background check
    // left behind before the opt-out. Leave it exactly as it is, same as the pin below: turning
    // auto_update back on later still finds it there.
    if (deps.cfg.auto_update === "off") return;

    const env = deps.env ?? (process.env as EnvSource);
    // The pin means "never auto-update" - leave the stage exactly as it is so a later invocation,
    // once the pin is gone, can still pick it up.
    if (isPinned(env)) return;

    const pathResult = resolveTargetPath(env, deps.execPath ?? process.execPath);
    if (!pathResult.ok) return;
    const { targetPath } = pathResult;

    // Staged for a different install target (GUSTO_INSTALL_DIR changed since) - stale, not ours to
    // install here. Discard rather than risk swapping a verified binary onto the wrong path.
    if (state.staged_install_path !== targetPath) {
      await discardStage(state, file);
      return;
    }

    const info = await lstat(state.staged_path).catch(() => null);
    if (info === null || !info.isFile()) {
      // Gone (a concurrent invocation already won the swap) or something odd sitting there -
      // either way it isn't a verified stage anymore.
      await discardStage(state, file);
      return;
    }

    const bytes = new Uint8Array(await Bun.file(state.staged_path).arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== state.staged_checksum) {
      await unlink(state.staged_path).catch(() => {});
      await discardStage(state, file);
      return;
    }

    try {
      await rename(state.staged_path, targetPath);
    } catch (err) {
      // The source vanished between our lstat and this rename - someone else won the race.
      // Anything else (disk full, perms changed) is transient: leave the stage for a retry.
      if ((err as { code?: unknown }).code === "ENOENT") await discardStage(state, file);
      return;
    }

    await discardStage(state, file);
    if (deps.mode === "human") {
      const from = state.staged_from ?? "unknown";
      deps.sinks.stderr.write(
        `gusto auto-updated: ${from} -> ${state.staged_version} (opt out: gusto config set auto_update off)\n`,
      );
    }
  } catch {
    // Fail open.
  }
}

/** Clears the staged_* fields of the exact stage `state` observed - but only if the state file
 * still holds that same stage. A concurrent process (a background check finishing, another
 * invocation's own discard) can write a different stage in the window between our read and this
 * write; re-reading and comparing first stops that write from being silently erased. Re-reads
 * rather than reusing `state` for everything else too, so a concurrent `last_checked` update
 * (from `maybeSpawnBackgroundCheck`) survives as well. */
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
  }).unref();
}

export interface TriggerDeps {
  cfg: { auto_update?: AutoUpdate };
  env?: EnvSource;
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
    const env = deps.env ?? (process.env as EnvSource);
    if (isPinned(env)) return;

    const state = await readState(file);
    // A previous check already staged something that's just waiting on a swap (most likely one
    // that keeps failing - disk full, perms). Checking again would call stageUpdate a second time,
    // whose preflightStagingPath treats the still-good, still-verified file from the first check as
    // a crashed-run stray and deletes it. Nothing to do here until that stage resolves one way or
    // another - swapStagedUpdate owns clearing it, not this function.
    if (state.staged_version !== undefined) return;
    const nowIso = deps.now ?? new Date().toISOString();
    if (state.last_checked !== undefined) {
      const age = Date.parse(nowIso) - Date.parse(state.last_checked);
      if (!Number.isNaN(age) && age < STALE_MS) return;
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
export async function runBackgroundCheck(deps: StageDeps & { stateFile?: string } = { log: () => {} }): Promise<void> {
  const file = deps.stateFile ?? stateFilePath();
  try {
    const result = await stageUpdate(deps);
    if (!result.ok || result.data.status !== "staged") return;

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
