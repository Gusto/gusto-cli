import { constants as FS_CONST, realpathSync } from "node:fs";
import { access, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EnvSource } from "./env.ts";
import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";
import { VERSION } from "./version.ts";

/** In-place self-update. Re-implements `install.sh`'s contract rather than shelling out to it,
 * because a `curl | sh` pipeline can't hand back the structured result the envelope needs - see
 * `ARCHITECTURE.md` under `lib/upgrade.ts`. `upgrade.test.ts` pins the asset names against
 * `install.sh` so the two can't drift. */

const DEFAULT_REPO = "Gusto/gusto-cli";
const BINARY_NAME = "gusto";

/** Set on the exec-check child `defaultVersionOf` spawns, and nowhere else. The binary being
 * checked is a real `gusto` build, so running it - even just for `--version` - runs its own
 * `main()` for real. Without this, that nested run's own auto-update wiring (`lib/auto-update.ts`)
 * reads the same `update-state.toml` the outer call is in the middle of acting on, which can
 * delete the very file being verified out from under it. `index.ts` checks this env var before
 * doing anything auto-update-related, and it alone - not argv, so it can't collide with a real
 * `--version` invocation the way a second argv flag would. */
export const SKIP_AUTO_UPDATE_ENV = "GUSTO_INTERNAL_SKIP_AUTO_UPDATE";

/** Path prefixes owned by a package manager. Replacing a binary under one of these leaves the
 * manager's metadata describing a version that's no longer on disk, and the next `brew upgrade`
 * silently reverts us - so refuse and name the tool that should be doing the update instead. */
const MANAGED_PREFIXES: readonly { prefix: string; manager: string }[] = [
  { prefix: "/opt/homebrew/", manager: "Homebrew" },
  { prefix: "/usr/local/Cellar/", manager: "Homebrew" },
  { prefix: "/home/linuxbrew/", manager: "Homebrew" },
  { prefix: "/nix/store/", manager: "Nix" },
];

/** The way out when this command can't finish: the installer fetches the same release from the same
 * origin, but by a different route - no tag lookup (it uses `/latest/download/`), `curl --retry 3
 * --retry-all-errors` instead of one attempt, and its own `mktemp -d` staging rather than this
 * install dir. So it routes around a flaky network or a wedged install path, which is exactly where
 * it's offered below and nowhere else.
 *
 * Deliberately *not* attached to every failure. A hint that can't work is worse than none: it sends
 * an agent round a loop it can't exit, and this command is largely driven by agents. See the call
 * sites for which failures earn it and which get better-targeted advice instead. */
const REINSTALL_HINT = "Reinstall instead: curl -fsSL https://cli.gusto.com/install.sh | sh";

/** For integrity failures, where reinstalling is the one thing that cannot help: install.sh verifies
 * the same asset against the same `SHA256SUMS`, so it fails identically. Naming a version is the
 * only move that changes the input. */
const PIN_HINT =
  "If it recurs, the release asset may be bad - pin a known-good version: " +
  "GUSTO_CLI_VERSION=v0.0.0 gusto upgrade --confirm";

/** One fixed name rather than a per-run one: a run interrupted past the point of no return (SIGKILL,
 * or SIGINT, which `index.ts` turns into a `process.exit` that skips the cleanup below) strands this
 * file, and a fixed name means the next run clears it instead of leaving another one behind. What
 * makes that safe is `preflightStagingPath` plus the `O_EXCL` create - see both. */
const STAGING_NAME = `.${BINARY_NAME}-upgrade`;

/** Deadlines, so a connection that opens and then stalls can't hang `gusto upgrade` with no
 * envelope and no exit code. The download's is generous because release assets run to tens of MB
 * over whatever link the user has; the lookup is a single redirect and the exec check is a
 * `--version` print, so both are short. */
const LOOKUP_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const EXEC_CHECK_TIMEOUT_MS = 30_000;
const QUARANTINE_TIMEOUT_MS = 10_000;

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export interface UpgradeResult {
  /** `available` is the `--dry-run` preview. `staged` is `stageUpdate`'s result: a verified binary
   * sits at `staged_path`, not yet swapped onto `install_path`. */
  status: "up_to_date" | "available" | "upgraded" | "staged";
  /** The version at `install_path`, or null when nothing runnable is installed there yet. */
  from: string | null;
  /** The release's version, `v` prefix stripped. Null only when a `GUSTO_CLI_BASE_URL` override
   * leaves the origin's version unknowable before the download. */
  to: string | null;
  asset: string;
  install_path: string;
  checksum?: "verified";
  /** Present only when `status === "staged"`: where the verified binary sits, and its checksum, so
   * a later swap (a different process, possibly hours later) can re-verify before installing it. */
  staged_path?: string;
  staged_checksum?: string;
}

/** Failure shape mirroring config.ts's `requireValidKey`, so callers can `if (!x.ok) return x.result`. */
type Failed = { ok: false; result: CommandResult<never> };

function fail(code: string, message: string, exitCode: ExitCodeValue = ExitCode.General, hint?: string): Failed {
  const error = hint === undefined ? { code, message } : { code, message, hint };
  return { ok: false, result: { ok: false, exitCode, error } };
}

/** `process.platform`/`process.arch` already yield the tokens the release assets are named with, so
 * unlike install.sh there's no `uname` aliasing to do - only validation. */
export function platformAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): { ok: true; asset: string } | Failed {
  if (platform !== "darwin" && platform !== "linux") {
    return fail("unsupported_platform", `unsupported OS: ${platform} (supported: macOS, Linux)`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    return fail("unsupported_platform", `unsupported architecture: ${arch} (supported: arm64, x64)`);
  }
  if (platform === "linux" && arch === "arm64") {
    return fail("unsupported_platform", "unsupported platform: Linux arm64 (supported: macOS arm64/x64, Linux x64)");
  }
  return { ok: true, asset: `${BINARY_NAME}-${platform}-${arch}` };
}

/** `realpathSync` that degrades to its input, for paths that may not exist yet. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Symlinks are resolved so a `~/.local/bin/gusto` link upgrades its target, not itself. Both
 * branches canonicalize, because everything downstream reasons about the resolved path: the
 * managed-install prefixes are matched against it (an Intel Homebrew install reached through
 * `GUSTO_INSTALL_DIR=/usr/local/bin` has to fail the same way one reached through `execPath` does),
 * `from` is read off it, and it's what `rename` lands on.
 *
 * The basename guard is load-bearing: under `bun run dev -- upgrade` the running executable is the
 * developer's `bun`, and replacing that would be a destructive surprise.
 *
 * `isSelf` distinguishes upgrading ourselves from upgrading some other install that
 * `GUSTO_INSTALL_DIR` named. Only in the first case is this process's compiled-in `VERSION` the
 * version of the file being replaced. */
export function resolveTargetPath(
  env: EnvSource,
  execPath: string = process.execPath,
): { ok: true; targetPath: string; isSelf: boolean } | Failed {
  const resolved = canonical(execPath);
  const installDir = env.GUSTO_INSTALL_DIR;
  if (installDir !== undefined && installDir.length > 0) {
    const targetPath = canonical(path.join(installDir, BINARY_NAME));
    return { ok: true, targetPath, isSelf: targetPath === resolved };
  }
  if (path.basename(resolved) !== BINARY_NAME) {
    return fail(
      "not_installed_binary",
      `\`gusto upgrade\` replaces an installed gusto binary, but this process is running as ` +
        `${resolved}. That's the from-source path (\`bun run dev\`) - rebuild with \`bun run build\` ` +
        `instead, or set GUSTO_INSTALL_DIR to name the binary to replace.`,
      ExitCode.Validation,
    );
  }
  return { ok: true, targetPath: resolved, isSelf: true };
}

/** Strip a tag's leading `v` so a release tag compares against `package.json`'s version. */
export function tagToVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** The release tag to install, or null when a `GUSTO_CLI_BASE_URL` override leaves nothing to
 * resolve (the caller then installs unconditionally).
 *
 * The tag comes from the `/releases/latest` redirect's Location header rather than
 * `api.github.com`: no auth, and no 60-requests-per-hour cap to start failing behind a busy NAT.
 * A `GUSTO_CLI_VERSION` pin is used verbatim, so it must carry the `v` install.sh expects. */
export async function resolveTargetTag(
  env: EnvSource,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; tag: string | null } | Failed> {
  const pinned = env.GUSTO_CLI_VERSION;
  if (pinned !== undefined && pinned.length > 0 && pinned !== "latest") return { ok: true, tag: pinned };
  if (env.GUSTO_CLI_BASE_URL !== undefined && env.GUSTO_CLI_BASE_URL.length > 0) return { ok: true, tag: null };

  const repo = env.GUSTO_CLI_REPO !== undefined && env.GUSTO_CLI_REPO.length > 0 ? env.GUSTO_CLI_REPO : DEFAULT_REPO;
  const url = `https://github.com/${repo}/releases/latest`;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch (err) {
    if (isTimeout(err)) {
      return fail(
        "release_lookup_timed_out",
        `${url} did not respond within ${LOOKUP_TIMEOUT_MS}ms`,
        ExitCode.Timeout,
        REINSTALL_HINT,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail("release_lookup_failed", `could not reach ${url}: ${detail}`, ExitCode.Network, REINSTALL_HINT);
  }
  const location = res.headers.get("location");
  const tag = location === null ? null : /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
  if (tag === null || tag === undefined) {
    return fail(
      "release_lookup_failed",
      `could not determine the latest release from ${url} (HTTP ${res.status}). ` +
        `Pin a version with GUSTO_CLI_VERSION=v0.0.0 to bypass the lookup.`,
      ExitCode.Network,
      REINSTALL_HINT,
    );
  }
  return { ok: true, tag: decodeURIComponent(tag) };
}

/** A known tag uses the explicit `/releases/download/$tag/` form rather than install.sh's
 * `/releases/latest/download/`, so a release cut between the lookup and the download can't leave us
 * installing one version while reporting another. */
export function assetBaseUrl(env: EnvSource, tag: string | null): string {
  const override = env.GUSTO_CLI_BASE_URL;
  if (override !== undefined && override.length > 0) return override.replace(/\/+$/, "");
  const repo = env.GUSTO_CLI_REPO !== undefined && env.GUSTO_CLI_REPO.length > 0 ? env.GUSTO_CLI_REPO : DEFAULT_REPO;
  if (tag === null) return `https://github.com/${repo}/releases/latest/download`;
  return `https://github.com/${repo}/releases/download/${tag}`;
}

/** Matches the whole second field, like install.sh's `awk '$2 == a'`, so a sibling asset whose name
 * shares a prefix can't satisfy the lookup. Null when SHA256SUMS has no line for `asset`. */
export function parseSha256Sums(text: string, asset: string): string | null {
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2 && fields[1] === asset) return fields[0] ?? null;
  }
  return null;
}

/** The closest existing ancestor of `dir` - `dir` itself when it already exists. That's where a
 * `mkdir -p` would land its first new component, so it decides whether the install can happen, and
 * reading it mutates nothing.
 *
 * "Existing" deliberately means any file type, not just a directory. A regular file sitting where a
 * directory belongs is a reason to refuse, not a reason to keep walking past it to some grandparent
 * that happens to be writable - the caller checks the type.
 *
 * The probe is `lstat`, which does *not* follow symlinks, and that is load-bearing. `access` follows,
 * so a dangling symlink reads as absent and the walk steps straight past it to the healthy
 * grandparent - and then every check downstream inspects a directory that isn't where the install
 * would go. A link with nothing at the other end is something that exists and that `mkdir` will
 * refuse, so the walk has to stop on it. The returned stats are the caller's too, since it needs the
 * type and there's no reason to ask twice. */
async function nearestExistingPath(
  dir: string,
): Promise<{ path: string; info: Awaited<ReturnType<typeof lstat>> } | null> {
  let current = dir;
  for (;;) {
    try {
      return { path: current, info: await lstat(current) };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Errnos where the symlink itself is the problem and removing it is the only fix: nothing at the
 * other end, a non-directory component along the way, or a cycle. Everything else - `EACCES` from a
 * directory in the target path that denies search, an unmounted mountpoint - is about the *state* of
 * a link that may be perfectly correct, and a chmod or a remount changes it. */
const BROKEN_LINK_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/** Whether the anchor can serve as the install directory, and if not, whose fault that is.
 *
 * The two `*stat` calls here and in the walk want opposite link semantics, on purpose. The walk uses
 * `lstat` so a dangling link stops it; this one *follows*, because a link pointing at a real
 * directory is a perfectly good install dir and `mkdir -p` is happy with it. Swap either and it
 * breaks: `lstat` here refuses a working symlinked install, `access`/`stat` in the walk lets a broken
 * one through.
 *
 * Failing to follow is not on its own evidence of a broken link, which is the distinction this
 * returns three states for. A link to a real directory behind an unreadable parent fails `stat` with
 * `EACCES` exactly as a dangling one fails with `ENOENT`; collapsing both into "not a directory"
 * tells someone to delete a correct symlink to fix a permission problem elsewhere. An unrecognized
 * errno is treated as `unreadable` so the advice stays non-destructive. */
async function classifyAnchor(anchor: {
  path: string;
  info: Awaited<ReturnType<typeof lstat>>;
}): Promise<"directory" | "not-a-directory" | "unreadable"> {
  if (!anchor.info.isSymbolicLink()) return anchor.info.isDirectory() ? "directory" : "not-a-directory";
  try {
    return (await stat(anchor.path)).isDirectory() ? "directory" : "not-a-directory";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && BROKEN_LINK_ERRNOS.has(code) ? "not-a-directory" : "unreadable";
  }
}

/** Runs before anything is downloaded *and* before the confirm gate, so it only reads. Checks the
 * *directory*, not the file, because that's what `rename` needs write+execute on - a read-only file
 * in a writable dir replaces fine.
 *
 * A directory that doesn't exist yet is not a failure here: `ensureInstallDir` creates it after the
 * gate, the way install.sh does. So the permission question is asked of the nearest ancestor that
 * does exist. Asking it of `dir` would turn a first install into a bogus `install_dir_not_writable`
 * - ENOENT reported as a permission problem an agent might retry, which it never can. */
export async function preflightInstallDir(targetPath: string): Promise<{ ok: true } | Failed> {
  const dir = path.dirname(targetPath);
  const managed = MANAGED_PREFIXES.find((m) => targetPath.startsWith(m.prefix));
  if (managed) {
    return fail(
      "managed_install",
      `${targetPath} is managed by ${managed.manager}. Update it with ${managed.manager} instead, ` +
        `so its metadata stays in step with what's on disk.`,
      ExitCode.Blocked,
    );
  }
  const anchor = await nearestExistingPath(dir);
  if (anchor === null) {
    return fail(
      "install_dir_not_writable",
      `cannot reach any existing parent of ${dir}, so ${targetPath} can't be installed. Nothing was changed.`,
      ExitCode.Blocked,
      REINSTALL_HINT,
    );
  }

  // Type before permissions, because `access` ignores file type: a regular file with mode 0755
  // satisfies W_OK|X_OK just as a directory does, and would sail through the check below only to
  // fail as a bare ENOTDIR from `mkdir` after the gate.
  const anchorKind = await classifyAnchor(anchor);

  if (anchorKind === "unreadable") {
    // Blocked, not Validation, and pointedly *not* "remove or rename": the link may well be correct,
    // with the problem somewhere in the path it points at. A chmod or a remount fixes this, which is
    // exactly the "precondition might later be met" that exit 8 means.
    return fail(
      "install_dir_not_writable",
      `cannot resolve what ${anchor.path} points at, so ${targetPath} can't be installed - something ` +
        `along its target path denies access, or the volume holding it isn't mounted. Check ` +
        `permissions on the target rather than removing ${anchor.path}. Nothing was changed.`,
      ExitCode.Blocked,
      REINSTALL_HINT,
    );
  }

  if (anchorKind === "not-a-directory") {
    // Validation, not Blocked: exit 8 tells an agent the precondition might later be met on its own,
    // and neither a stray file nor a broken link removes itself. Someone has to.
    //
    // And no reinstall hint, for the same reason: install.sh runs `mkdir -p` against this very path,
    // so it fails on the stray file exactly as we do. Its separate `mktemp -d` staging doesn't help -
    // the blockage is the install directory, which the installer still has to create.
    const kind = anchor.info.isSymbolicLink()
      ? "is a symlink that doesn't resolve to a directory"
      : "is not a directory";
    const what = anchor.path === dir ? `${dir} ${kind}` : `${anchor.path} ${kind}, so ${dir} can't be created`;
    return fail(
      "install_dir_not_a_directory",
      `${what}, so ${targetPath} can't be installed. Remove or rename ${anchor.path}, or point ` +
        `GUSTO_INSTALL_DIR at a different directory. Nothing was changed.`,
      ExitCode.Validation,
    );
  }

  try {
    await access(anchor.path, FS_CONST.W_OK | FS_CONST.X_OK);
  } catch {
    const because =
      anchor.path === dir ? `cannot write to ${dir}` : `cannot create ${dir}: ${anchor.path} is not writable`;
    return fail(
      "install_dir_not_writable",
      `${because}, so ${targetPath} can't be replaced. Nothing was changed.`,
      ExitCode.Blocked,
      REINSTALL_HINT,
    );
  }
  return { ok: true };
}

/** The mutating half of the install-dir preflight, split out so it can sit *below* the confirm gate:
 * `--dry-run` and a run refused for want of `--confirm` must leave the disk exactly as they found
 * it, and creating directories is not nothing. install.sh does `mkdir -p "$INSTALL_DIR"`, so a
 * first install into a directory that doesn't exist yet works here too.
 *
 * `preflightInstallDir` has already vetted the permissions this needs, so a failure here is a race
 * or something genuinely odd rather than the common case. */
export async function ensureInstallDir(targetPath: string): Promise<{ ok: true } | Failed> {
  const dir = path.dirname(targetPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(
      "install_dir_not_writable",
      `cannot create ${dir}, so ${targetPath} can't be installed: ${detail}. Nothing was changed.`,
      ExitCode.Blocked,
      REINSTALL_HINT,
    );
  }
  return { ok: true };
}

/** What sits at the staging path decides whether this run can stage at all, so it is settled here -
 * before tens of MB are downloaded - rather than at the write.
 *
 * A regular file is a strand from an interrupted run, and clearing it is the whole point of the
 * fixed name. Anything else is refused rather than written through: a directory or a root-owned
 * leftover would otherwise surface as a raw errno from the middle of the upgrade and never
 * self-heal, and a symlink is worse - `Bun.write` follows one, so the release bytes would land in
 * the link's target, `chmod` would widen *that* file to 0755, and the `rename` would move the link
 * itself onto the install path. */
export async function preflightStagingPath(staged: string): Promise<{ ok: true } | Failed> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(staged);
  } catch {
    return { ok: true };
  }
  if (!info.isFile()) {
    return fail(
      "staging_path_blocked",
      `${staged} exists and is not a regular file, so the download can't be staged there. ` +
        `Remove it and retry; nothing was changed.`,
      ExitCode.Blocked,
    );
  }
  try {
    await unlink(staged);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(
      "staging_path_blocked",
      `could not clear the leftover staging file ${staged}: ${detail}. Nothing was changed.`,
      ExitCode.Blocked,
    );
  }
  return { ok: true };
}

/** Whether the staging path still holds the exact file we created.
 *
 * A fixed staging name is shared, so a concurrent run's own preflight will clear ours out from
 * under us mid-upgrade. Without this check that shows up as a lie: the exec-check finds nothing to
 * run and the code blames the release artifact, or the `rename` moves whatever the other run left
 * there - bytes this process never checksummed. There's no lock to take (POSIX advisory locks
 * aren't exposed here), but identity is enough to refuse rather than guess.
 *
 * Identity is read off our own still-open descriptor, not off the path. Comparing inode numbers
 * alone would be wrong: ext4 hands a just-freed inode straight back to the next create in the same
 * directory, so an unlink-then-recreate can land the other run's file on our number. `nlink` can't
 * be spoofed that way - once our file is unlinked, our descriptor reports zero links no matter
 * what has since been created at the path.
 *
 * Both halves are needed. `nlink` alone still reads as ours after a successful `rename` (the file
 * is simply at its new name), and the `lstat` alone is the inode-reuse trap. Together: our file is
 * still linked, and the staging path is still where it's linked. The identity is `(dev, ino)`, not
 * `ino` alone - the same pair the create-time check compares, since an inode number only identifies
 * a file within its filesystem.
 *
 * The descriptor held *across the exec-check* must be read-only. Linux refuses to execute a file
 * that anyone holds open for writing (`ETXTBSY`), so keeping the write handle open that long would
 * break every real upgrade there while passing here, since the tests stage shell scripts and
 * `ETXTBSY` applies to the executable image, not to a script's interpreter. The staging-write
 * cleanup passes its writer, which runs nothing and closes immediately after. */
async function stagingStillOurs(handle: Awaited<ReturnType<typeof open>>, staged: string): Promise<boolean> {
  try {
    const ours = await handle.stat();
    if (ours.nlink === 0) return false;
    const atPath = await lstat(staged);
    return atPath.ino === ours.ino && atPath.dev === ours.dev;
  } catch {
    return false;
  }
}

function concurrentUpgrade(staged: string, targetPath: string): CommandResult<never> {
  return fail(
    "staging_path_blocked",
    `another \`gusto upgrade\` replaced the staging file at ${staged} while this one was running, ` +
      `so the verified download can't be installed. ${targetPath} is unchanged; retry once the ` +
      `other run finishes.`,
    ExitCode.Blocked,
  ).result;
}

export interface UpgradeOpts {
  force?: boolean;
  dryRun?: boolean;
}

export interface UpgradeDeps {
  /** The agent-mode `--confirm` gate, called just before the first byte is downloaded. Returns a
   * Blocked result to abort, or null to proceed. */
  gate: (description: string) => CommandResult<never> | null;
  /** Routed to stderr by the command, so stdout stays a single envelope. */
  log: (line: string) => void;
  /** Everything below defaults to the real process/host. Tests override to stay off the network
   * and, critically, off the test runner's own executable. */
  env?: EnvSource;
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  execPath?: string;
  platform?: string;
  arch?: string;
  /** Resolves to the version `<file> --version` reports, or null if it won't run. */
  versionOf?: (file: string) => Promise<string | null>;
  stripQuarantine?: (file: string) => Promise<void>;
}

/** `stageUpdate` never confirms with anyone - it's the unattended half of auto-update - so it takes
 * every `UpgradeDeps` field except the confirm `gate`. */
export type StageDeps = Omit<UpgradeDeps, "gate">;

/** Gating the install on this means a build that segfaults never becomes the live binary.
 *
 * Wrapped because a file that isn't a valid executable at all - the shape a truncated or garbage
 * download actually takes - makes `Bun.spawn` *throw* ENOEXEC rather than exit non-zero. Letting
 * that escape would surface as `internal_error` with a raw posix_spawn message instead of the
 * `binary_check_failed` the caller can act on.
 *
 * Killed on a deadline for the same reason: this is where a just-fetched artifact runs, and one
 * that blocks on init would otherwise hang the upgrade with a staged 0755 file in the install dir.
 * A build that won't print its version inside the deadline is a build we won't install, so the
 * timeout reads as the same null every other bad artifact does. */
export async function defaultVersionOf(file: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([file, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, [SKIP_AUTO_UPDATE_ENV]: "1" },
    });
    const deadline = setTimeout(() => proc.kill("SIGKILL"), EXEC_CHECK_TIMEOUT_MS);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) return null;
      const version = out.trim();
      return version.length > 0 ? version : null;
    } finally {
      clearTimeout(deadline);
    }
  } catch {
    return null;
  }
}

/** The darwin binaries can't carry a stapled notarization ticket (a bare Mach-O isn't stapleable),
 * so Gatekeeper checks online and a quarantine xattr can block first run. `fetch` doesn't set that
 * attribute the way a browser download does, making this belt-and-braces - hence silent on failure. */
export async function defaultStripQuarantine(file: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const proc = Bun.spawn(["xattr", "-d", "com.apple.quarantine", file], { stdout: "ignore", stderr: "ignore" });
    // Deadline for the same reason every other wait here has one: this is best-effort, so it must
    // never be the thing that hangs the upgrade with no envelope.
    const deadline = setTimeout(() => proc.kill("SIGKILL"), QUARANTINE_TIMEOUT_MS);
    try {
      await proc.exited;
    } finally {
      clearTimeout(deadline);
    }
  } catch {
    // No xattr on PATH, or the attribute was never set. Neither blocks the upgrade.
  }
}

/** The installed version for display, when there may not be an installed binary at all. */
function describeFrom(from: string | null): string {
  return from ?? "not installed";
}

/** install.sh passes `--proto-redir "=https"`: the *initial* scheme is deliberately unrestricted so
 * `GUSTO_CLI_BASE_URL` can point at http for tests and staging, but a redirect can't land on http.
 * Carry that over, since a redirect is the hop we don't choose. `res.url` is the final URL after
 * any redirects, so a scheme change shows up there. */
function redirectedToPlaintext(requested: string, final: string): boolean {
  if (final.length === 0) return false;
  try {
    const to = new URL(final);
    return to.href !== new URL(requested).href && to.protocol !== "https:";
  } catch {
    return false;
  }
}

/** The body read stays inside the try: a socket that dies partway through a multi-MB asset throws
 * here, not at the headers, and outside the try that lands as `internal_error` with a raw
 * "socket connection was closed" - a wifi drop reported as a bug in the CLI, and invisible to an
 * agent watching for the network exit code. */
async function download(fetchImpl: typeof fetch, url: string): Promise<{ ok: true; bytes: Uint8Array } | Failed> {
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      return fail("download_failed", `could not download ${url}: HTTP ${res.status}`, ExitCode.Network, REINSTALL_HINT);
    }
    if (redirectedToPlaintext(url, res.url)) {
      return fail(
        "insecure_redirect",
        `${url} redirected to ${res.url}, which is not https; refusing to install those bytes. ` +
          `Nothing was changed.`,
        ExitCode.General,
      );
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (isTimeout(err)) {
      return fail(
        "download_timed_out",
        `downloading ${url} exceeded ${DOWNLOAD_TIMEOUT_MS}ms`,
        ExitCode.Timeout,
        REINSTALL_HINT,
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    return fail("download_failed", `could not download ${url}: ${detail}`, ExitCode.Network, REINSTALL_HINT);
  }
  return { ok: true, bytes };
}

interface UpgradeTarget {
  asset: string;
  targetPath: string;
  from: string | null;
  tag: string | null;
  base: { from: string | null; to: string | null; asset: string; install_path: string };
}

type ResolvedTarget =
  | { done: CommandResult<UpgradeResult>; target?: undefined }
  | { done?: undefined; target: UpgradeTarget };

/** Everything through the up-to-date/dry-run decision - shared by `performUpgrade` and
 * `stageUpdate` so the two can never disagree about whether an update is needed. Returns either a
 * terminal result (`done`) or the resolved `target` to stage. */
async function resolveUpgradeTarget(
  opts: Pick<UpgradeOpts, "force" | "dryRun">,
  deps: Required<
    Pick<UpgradeDeps, "env" | "currentVersion" | "fetchImpl" | "execPath" | "platform" | "arch" | "versionOf">
  >,
): Promise<ResolvedTarget> {
  const { env, currentVersion, fetchImpl, execPath, platform, arch, versionOf } = deps;

  const assetResult = platformAsset(platform, arch);
  if (!assetResult.ok) return { done: assetResult.result };
  const { asset } = assetResult;

  const pathResult = resolveTargetPath(env, execPath);
  if (!pathResult.ok) return { done: pathResult.result };
  const { targetPath, isSelf } = pathResult;

  const preflight = await preflightInstallDir(targetPath);
  if (!preflight.ok) return { done: preflight.result };

  const tagResult = await resolveTargetTag(env, fetchImpl);
  if (!tagResult.ok) return { done: tagResult.result };
  const { tag } = tagResult;
  const targetVersion = tag === null ? null : tagToVersion(tag);

  // Only when the target is us can VERSION stand in for it (see `isSelf`), which also keeps the
  // common path free of an extra spawn. Null means nothing runnable is installed there.
  const from = isSelf ? currentVersion : await versionOf(targetPath);
  const base = { from, to: targetVersion, asset, install_path: targetPath };

  // A null on either side is "unknown", never a match: an unknown target version (a
  // `GUSTO_CLI_BASE_URL` origin) and an absent installed binary must both still install.
  if (targetVersion !== null && targetVersion === from && opts.force !== true) {
    return {
      done: { ok: true, data: { status: "up_to_date", ...base }, human: () => `already up to date (${targetVersion})` },
    };
  }

  if (opts.dryRun === true) {
    return {
      done: {
        ok: true,
        data: { status: "available", ...base },
        human: () => `upgrade available: ${describeFrom(from)} -> ${targetVersion ?? "unknown"}`,
      },
    };
  }

  return { target: { asset, targetPath, from, tag, base } };
}

/** What happens to the staged file once it's downloaded, checksummed, written, and exec-verified:
 * `performUpgrade` renames it into place immediately (`keep: false`); `stageUpdate` leaves it
 * sitting at `staged` for a later invocation's swap (`keep: true`). */
type Finalized = { keep: boolean; result: CommandResult<UpgradeResult> };

/** The step order below is deliberate, not incidental: every cheap failure resolves before a byte
 * is fetched, the bytes are checksummed before they are ever written, and the file they're written
 * to is exec-checked before `finalize` decides what happens to it. Shared by `performUpgrade` and
 * `stageUpdate` so the concurrency guards - the `O_EXCL` create, `stagingStillOurs`, the fixed
 * staging name's self-healing - can't drift between the interactive and unattended paths. */
async function stageAndFinalize(
  target: UpgradeTarget,
  deps: Required<Pick<UpgradeDeps, "log" | "env" | "fetchImpl" | "versionOf" | "stripQuarantine">>,
  finalize: (staged: string, reported: string, checksum: string) => Promise<Finalized>,
): Promise<CommandResult<UpgradeResult>> {
  const { log, env, fetchImpl, versionOf, stripQuarantine } = deps;
  const { asset, targetPath, tag } = target;

  // First mutation of the run, and deliberately the first thing past the gate (or, for
  // `stageUpdate`, the first thing at all - it has no gate to be past).
  const dirReady = await ensureInstallDir(targetPath);
  if (!dirReady.ok) return dirReady.result;

  // Stage inside the install dir, not $TMPDIR: same filesystem is what makes the final rename an
  // atomic swap rather than a copy that can be observed half-written. Same *directory*, in fact,
  // so the rename can't fail EXDEV however the install dir happens to be mounted.
  //
  // Settled here rather than at the write below, so a blocked staging path costs nothing instead of
  // surfacing after tens of MB are already downloaded. Not any earlier, because clearing a stranded
  // file is a mutation and `--dry-run` must leave the disk alone.
  const staged = path.join(path.dirname(targetPath), STAGING_NAME);
  const stagingPreflight = await preflightStagingPath(staged);
  if (!stagingPreflight.ok) return stagingPreflight.result;

  const baseUrl = assetBaseUrl(env, tag);
  log(`downloading ${asset} from ${baseUrl}`);
  const binary = await download(fetchImpl, `${baseUrl}/${asset}`);
  if (!binary.ok) return binary.result;
  const sums = await download(fetchImpl, `${baseUrl}/SHA256SUMS`);
  if (!sums.ok) return sums.result;

  const expected = parseSha256Sums(new TextDecoder().decode(sums.bytes), asset);
  if (expected === null) {
    return {
      ok: false,
      exitCode: ExitCode.General,
      error: {
        code: "checksum_missing",
        message: `no checksum for ${asset} in SHA256SUMS; nothing was changed`,
        hint: PIN_HINT,
      },
    };
  }
  const actual = createHash("sha256").update(binary.bytes).digest("hex");
  if (actual !== expected) {
    return {
      ok: false,
      exitCode: ExitCode.General,
      error: {
        code: "checksum_mismatch",
        message: `checksum mismatch for ${asset} (expected ${expected}, got ${actual}); nothing was changed`,
        hint: PIN_HINT,
      },
    };
  }
  log("checksum verified");

  // `O_EXCL` rather than a plain write, so between the staging preflight and here nothing can slip a
  // symlink or a directory in. It also turns two concurrent upgrades from a silent race - each
  // renaming whatever the other last left at the shared staging path - into a clean refusal for
  // the second one, with its install untouched.
  //
  // A read-only descriptor on the same file is then held open past the `rename`, because that is
  // what identifies our file for the rest of the run: see `stagingStillOurs`.
  // The create is its own `try`, narrowly. It is the only step here that a concurrent run explains -
  // `EEXIST` means someone else got the name - and blaming one for a disk that filled up mid-write
  // would send an operator looking for a second process that doesn't exist.
  let writer: Awaited<ReturnType<typeof open>>;
  try {
    writer = await open(staged, FS_CONST.O_WRONLY | FS_CONST.O_CREAT | FS_CONST.O_EXCL, 0o700);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Nothing to clean up: the create is what failed, so whatever is at `staged` isn't ours.
    return fail(
      "staging_path_blocked",
      `could not stage the verified download at ${staged}: ${detail}. ` +
        `Another \`gusto upgrade\` may be running. Nothing was changed.`,
      ExitCode.Blocked,
    ).result;
  }

  let ident: Awaited<ReturnType<typeof open>>;
  // One `try`, not two nested ones, so the `catch` runs while `writer` is still open - see there.
  try {
    const created = await writer.stat();
    await writer.write(binary.bytes);
    await writer.chmod(0o755);
    // Reopened rather than reused so the exec-check isn't blocked by our own write handle. The
    // reopen races the same concurrent run everything else here does, so it's checked against
    // the writer while both are open: our inode can't be recycled while the writer pins it, so
    // matching inodes prove the read handle is the file we just wrote.
    ident = await open(staged, FS_CONST.O_RDONLY);
    const reopened = await ident.stat();
    if (created.ino !== reopened.ino || created.dev !== reopened.dev) {
      await ident.close().catch(() => {});
      return concurrentUpgrade(staged, targetPath);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Ownership decides the cleanup, not presence. Past the `O_EXCL` create a half-written file is
    // ours to discard rather than leave for the next run's preflight - but a rival's preflight can
    // clear ours mid-write and create its own at the shared name, and unlinking by path would then
    // delete theirs while claiming to have discarded ours. Losing the race is the truer report.
    //
    // Asked of `writer`, which the `finally` below has not closed yet: a live descriptor is the
    // whole point, because it lets `stagingStillOurs` consult `nlink`. Comparing a stat snapshot
    // after the close would walk into the inode-reuse trap that function documents - ext4 hands the
    // freed inode straight to the rival's create, and their file would read as ours.
    if (!(await stagingStillOurs(writer, staged))) return concurrentUpgrade(staged, targetPath);
    await unlink(staged).catch(() => {});
    return fail(
      "staging_write_failed",
      `could not write the verified download to ${staged}: ${detail}. ` +
        `Discarded the partial file; ${targetPath} is unchanged.`,
      ExitCode.Blocked,
    ).result;
  } finally {
    await writer.close().catch(() => {});
  }

  // `false` for every failure branch below, exactly as before this function existed - the staged
  // file is discarded on any of them. Only `finalize` returning `keep: true` (`stageUpdate`'s
  // contract) leaves it on disk past this call.
  let keepStaged = false;
  try {
    await stripQuarantine(staged);

    // Checked before the artifact is blamed for anything: a lost race and a corrupt release both
    // make `--version` come back null, and "the release artifact is corrupt" is a bad thing to tell
    // someone whose only mistake was running two upgrades at once.
    const reported = await versionOf(staged);
    if (!(await stagingStillOurs(ident, staged))) return concurrentUpgrade(staged, targetPath);
    if (reported === null) {
      return {
        ok: false,
        exitCode: ExitCode.General,
        error: {
          code: "binary_check_failed",
          message: `the downloaded ${asset} failed \`--version\`; discarded it and left ${targetPath} in place`,
          hint: PIN_HINT,
        },
      };
    }

    // Again immediately before finalize, so what `finalize` acts on is what was checksummed. A
    // window remains between this check and the rename (for `performUpgrade`) - closing it needs
    // `renameat2`, which isn't reachable from here - but it shrinks from the whole exec-check to a
    // syscall apart.
    if (!(await stagingStillOurs(ident, staged))) return concurrentUpgrade(staged, targetPath);

    const finalized = await finalize(staged, reported, actual);
    keepStaged = finalized.keep;
    return finalized.result;
  } finally {
    // Only if the staging path is still our file: after a successful rename it isn't there at all,
    // and if a concurrent run has claimed the path since, that file is theirs to remove, not ours.
    // `keepStaged` skips this deliberately - `stageUpdate` leaves a verified file there on purpose.
    if (!keepStaged) {
      const ours = await stagingStillOurs(ident, staged);
      await ident.close().catch(() => {});
      if (ours) await unlink(staged).catch(() => {});
    } else {
      await ident.close().catch(() => {});
    }
  }
}

/** Replacing the binary this process is currently executing is safe on Unix - the running image
 * keeps its own inode - so renaming over it mid-command is not itself the hazard `stageUpdate`
 * exists to avoid. The hazard is unattended background writes; see `lib/auto-update.ts`. */
export async function performUpgrade(opts: UpgradeOpts, deps: UpgradeDeps): Promise<CommandResult<UpgradeResult>> {
  const {
    gate,
    log,
    env = process.env,
    currentVersion = VERSION,
    fetchImpl = fetch,
    execPath = process.execPath,
    platform = process.platform,
    arch = process.arch,
    versionOf = defaultVersionOf,
    stripQuarantine = defaultStripQuarantine,
  } = deps;

  const resolved = await resolveUpgradeTarget(opts, {
    env,
    currentVersion,
    fetchImpl,
    execPath,
    platform,
    arch,
    versionOf,
  });
  if (resolved.done) return resolved.done;
  const { target } = resolved;

  const gated = gate(`replacing the gusto binary at ${target.targetPath}`);
  if (gated) return gated;

  return stageAndFinalize(target, { log, env, fetchImpl, versionOf, stripQuarantine }, async (staged, reported) => {
    try {
      await rename(staged, target.targetPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        keep: false,
        result: fail(
          "install_failed",
          `the download verified, but moving it into place at ${target.targetPath} failed: ${detail}. ` +
            `${target.targetPath} is unchanged.`,
          ExitCode.General,
          REINSTALL_HINT,
        ).result,
      };
    }
    log(`installed ${target.targetPath}`);
    return {
      keep: false,
      result: {
        ok: true,
        data: { status: "upgraded", ...target.base, to: reported, checksum: "verified" },
        human: () => `upgraded gusto ${describeFrom(target.from)} -> ${reported}`,
      },
    };
  });
}

/** The unattended half of auto-update: resolves, downloads, checksums, and exec-verifies exactly
 * like `performUpgrade`, but never renames - the verified binary is left at `staged_path` for a
 * later invocation's `swapStagedUpdate` (see `lib/auto-update.ts`) to install. No `gate`: this path
 * only runs from a detached background process, which has no one to confirm with. No `force`/
 * `dryRun`: neither concept applies to a check nobody asked for by name. */
export async function stageUpdate(deps: StageDeps): Promise<CommandResult<UpgradeResult>> {
  const {
    log,
    env = process.env,
    currentVersion = VERSION,
    fetchImpl = fetch,
    execPath = process.execPath,
    platform = process.platform,
    arch = process.arch,
    versionOf = defaultVersionOf,
    stripQuarantine = defaultStripQuarantine,
  } = deps;

  const resolved = await resolveUpgradeTarget(
    {},
    { env, currentVersion, fetchImpl, execPath, platform, arch, versionOf },
  );
  if (resolved.done) return resolved.done;
  const { target } = resolved;

  return stageAndFinalize(
    target,
    { log, env, fetchImpl, versionOf, stripQuarantine },
    async (staged, reported, checksum) => ({
      keep: true,
      result: {
        ok: true,
        data: { status: "staged", ...target.base, to: reported, staged_path: staged, staged_checksum: checksum },
        human: () => `update staged: ${describeFrom(target.from)} -> ${reported}`,
      },
    }),
  );
}
