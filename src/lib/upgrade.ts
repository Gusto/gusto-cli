import { constants as FS_CONST, realpathSync } from "node:fs";
import { access, chmod, rename, unlink } from "node:fs/promises";
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

/** Path prefixes owned by a package manager. Replacing a binary under one of these leaves the
 * manager's metadata describing a version that's no longer on disk, and the next `brew upgrade`
 * silently reverts us - so refuse and name the tool that should be doing the update instead. */
const MANAGED_PREFIXES: readonly { prefix: string; manager: string }[] = [
  { prefix: "/opt/homebrew/", manager: "Homebrew" },
  { prefix: "/usr/local/Cellar/", manager: "Homebrew" },
  { prefix: "/home/linuxbrew/", manager: "Homebrew" },
  { prefix: "/nix/store/", manager: "Nix" },
];

const REINSTALL_HINT = "Reinstall instead: curl -fsSL https://cli.gusto.com/install.sh | sh";

/** One fixed name rather than a per-run one: a run interrupted past the point of no return (SIGKILL,
 * or SIGINT, which `index.ts` turns into a `process.exit` that skips the cleanup below) strands this
 * file, and a fixed name means the next run overwrites it instead of leaving another one behind. */
const STAGING_NAME = `.${BINARY_NAME}-upgrade`;

export interface UpgradeResult {
  /** `available` is the `--dry-run` preview. */
  status: "up_to_date" | "available" | "upgraded";
  /** The version at `install_path`, or null when nothing runnable is installed there yet. */
  from: string | null;
  /** The release's version, `v` prefix stripped. Null only when a `GUSTO_CLI_BASE_URL` override
   * leaves the origin's version unknowable before the download. */
  to: string | null;
  asset: string;
  install_path: string;
  checksum?: "verified";
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

/** Symlinks are resolved so a `~/.local/bin/gusto` link upgrades its target, not itself.
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
    const targetPath = path.join(installDir, BINARY_NAME);
    return { ok: true, targetPath, isSelf: canonical(targetPath) === resolved };
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
    res = await fetchImpl(url, { redirect: "manual" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail("release_lookup_failed", `could not reach ${url}: ${detail}`, ExitCode.Network);
  }
  const location = res.headers.get("location");
  const tag = location === null ? null : /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
  if (tag === null || tag === undefined) {
    return fail(
      "release_lookup_failed",
      `could not determine the latest release from ${url} (HTTP ${res.status}). ` +
        `Pin a version with GUSTO_CLI_VERSION=v0.0.0 to bypass the lookup.`,
      ExitCode.Network,
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

/** Runs before anything is downloaded. Checks the *directory*, not the file, because that's what
 * `rename` needs write+execute on - a read-only file in a writable dir replaces fine. */
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
  try {
    await access(dir, FS_CONST.W_OK | FS_CONST.X_OK);
  } catch {
    return fail(
      "install_dir_not_writable",
      `cannot write to ${dir}, so ${targetPath} can't be replaced. Nothing was changed.`,
      ExitCode.Blocked,
      REINSTALL_HINT,
    );
  }
  return { ok: true };
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

/** Gating the install on this means a build that segfaults never becomes the live binary.
 *
 * Wrapped because a file that isn't a valid executable at all - the shape a truncated or garbage
 * download actually takes - makes `Bun.spawn` *throw* ENOEXEC rather than exit non-zero. Letting
 * that escape would surface as `internal_error` with a raw posix_spawn message instead of the
 * `binary_check_failed` the caller can act on. */
export async function defaultVersionOf(file: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([file, "--version"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const version = out.trim();
    return version.length > 0 ? version : null;
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
    await proc.exited;
  } catch {
    // No xattr on PATH, or the attribute was never set. Neither blocks the upgrade.
  }
}

/** The installed version for display, when there may not be an installed binary at all. */
function describeFrom(from: string | null): string {
  return from ?? "not installed";
}

async function download(fetchImpl: typeof fetch, url: string): Promise<{ ok: true; bytes: Uint8Array } | Failed> {
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail("download_failed", `could not download ${url}: ${detail}`, ExitCode.Network);
  }
  if (!res.ok) {
    return fail("download_failed", `could not download ${url}: HTTP ${res.status}`, ExitCode.Network);
  }
  return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** The step order below is deliberate, not incidental: every cheap failure resolves before a byte is
 * fetched, the bytes are checksummed before they are ever written, and the file they're written to
 * is exec-checked before the swap. Replacing the binary this process is currently executing is safe
 * on Unix - the running image keeps its own inode. */
export async function performUpgrade(opts: UpgradeOpts, deps: UpgradeDeps): Promise<CommandResult<UpgradeResult>> {
  const {
    gate,
    log,
    env = process.env as EnvSource,
    currentVersion = VERSION,
    fetchImpl = fetch,
    execPath = process.execPath,
    platform = process.platform,
    arch = process.arch,
    versionOf = defaultVersionOf,
    stripQuarantine = defaultStripQuarantine,
  } = deps;

  const assetResult = platformAsset(platform, arch);
  if (!assetResult.ok) return assetResult.result;
  const { asset } = assetResult;

  const pathResult = resolveTargetPath(env, execPath);
  if (!pathResult.ok) return pathResult.result;
  const { targetPath, isSelf } = pathResult;

  const preflight = await preflightInstallDir(targetPath);
  if (!preflight.ok) return preflight.result;

  const tagResult = await resolveTargetTag(env, fetchImpl);
  if (!tagResult.ok) return tagResult.result;
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
      ok: true,
      data: { status: "up_to_date", ...base },
      human: () => `already up to date (${targetVersion})`,
    };
  }

  if (opts.dryRun === true) {
    return {
      ok: true,
      data: { status: "available", ...base },
      human: () => `upgrade available: ${describeFrom(from)} -> ${targetVersion ?? "unknown"}`,
    };
  }

  const gated = gate(`replacing the gusto binary at ${targetPath}`);
  if (gated) return gated;

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
      error: { code: "checksum_missing", message: `no checksum for ${asset} in SHA256SUMS; nothing was changed` },
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
      },
    };
  }
  log("checksum verified");

  // Stage inside the install dir, not $TMPDIR: same filesystem is what makes the final rename an
  // atomic swap rather than a copy that can be observed half-written.
  const staged = path.join(path.dirname(targetPath), STAGING_NAME);
  try {
    await Bun.write(staged, binary.bytes);
    await chmod(staged, 0o755);
    await stripQuarantine(staged);

    const reported = await versionOf(staged);
    if (reported === null) {
      return {
        ok: false,
        exitCode: ExitCode.General,
        error: {
          code: "binary_check_failed",
          message: `the downloaded ${asset} failed \`--version\`; discarded it and left ${targetPath} in place`,
        },
      };
    }

    await rename(staged, targetPath);
    log(`installed ${targetPath}`);
    return {
      ok: true,
      data: { status: "upgraded", ...base, to: reported, checksum: "verified" },
      human: () => `upgraded gusto ${describeFrom(from)} -> ${reported}`,
    };
  } finally {
    // Only present if we bailed before the rename; unlink is a no-op otherwise.
    await unlink(staged).catch(() => {});
  }
}
