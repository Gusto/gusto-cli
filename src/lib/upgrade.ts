import { constants as FS_CONST, realpathSync } from "node:fs";
import { access, chmod, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EnvSource } from "./env.ts";
import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";
import { VERSION } from "./version.ts";

/** In-place self-update for the compiled binary.
 *
 * This re-implements the contract of `install.sh` - same `gusto-$os-$arch` asset names, same
 * `SHA256SUMS` verification, same `GUSTO_CLI_*` / `GUSTO_INSTALL_DIR` overrides - rather than
 * shelling out to the script. The reason is the envelope: `gusto upgrade` has to report
 * "already up to date" as a success, name the resolved version, and fail cleanly on a read-only
 * install dir, none of which a `curl | sh` pipeline can hand back as structured data.
 *
 * The duplication that buys is narrow and pinned by tests: the platform-token mapping and asset
 * names are asserted against the same three targets `tests/install.test.ts` serves. */

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

export interface UpgradeResult {
  /** `up_to_date` - nothing to do. `available` - a `--dry-run` preview. `upgraded` - binary replaced. */
  status: "up_to_date" | "available" | "upgraded";
  /** The version this process is running, i.e. VERSION from `src/lib/version.ts`. */
  from: string;
  /** The version resolved from the release, without the tag's `v` prefix. Null only when a
   * `GUSTO_CLI_BASE_URL` override makes the origin's version unknowable ahead of the download. */
  to: string | null;
  asset: string;
  install_path: string;
  /** Present on `upgraded`: the downloaded bytes matched their SHA256SUMS line. */
  checksum?: "verified";
}

/** A CommandResult-returning failure, mirroring config.ts's `requireValidKey` shape so callers
 * can `if (!x.ok) return x.result`. */
type Failed = { ok: false; result: CommandResult<never> };

function fail(code: string, message: string, exitCode: ExitCodeValue = ExitCode.General, hint?: string): Failed {
  const error = hint === undefined ? { code, message } : { code, message, hint };
  return { ok: false, result: { ok: false, exitCode, error } };
}

/** `gusto-$os-$arch` for the host, matching the release assets `.github/workflows/release.yml`
 * publishes. `process.platform`/`process.arch` already yield the tokens the assets are named with
 * (`darwin`, `linux`, `arm64`, `x64`), so unlike install.sh there's no `uname` aliasing to do -
 * only validation, including the explicit linux-arm64 gap that has no prebuilt binary. */
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

/** The binary this upgrade replaces: `$GUSTO_INSTALL_DIR/gusto` when set, otherwise the running
 * executable with symlinks resolved (so a `~/.local/bin/gusto` link upgrades its target, not itself).
 *
 * The basename guard is load-bearing. Under `bun run dev -- upgrade` the running executable is the
 * developer's `bun`, and replacing that with a gusto build would be a genuinely destructive
 * surprise - so a resolved path that isn't named `gusto` is refused rather than overwritten. */
export function resolveTargetPath(
  env: EnvSource,
  execPath: string = process.execPath,
): { ok: true; targetPath: string } | Failed {
  const installDir = env.GUSTO_INSTALL_DIR;
  if (installDir !== undefined && installDir.length > 0) {
    return { ok: true, targetPath: path.join(installDir, BINARY_NAME) };
  }
  let resolved: string;
  try {
    resolved = realpathSync(execPath);
  } catch {
    resolved = execPath;
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
  return { ok: true, targetPath: resolved };
}

/** Strip a tag's leading `v` so a release tag compares against `package.json`'s version. */
export function tagToVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/** The release tag to install, or null when the origin makes it unknowable up front.
 *
 * `GUSTO_CLI_VERSION` pins verbatim (a `v`-prefixed tag, as install.sh expects) and needs no
 * network. Otherwise the tag comes from GitHub's `/releases/latest` redirect: the Location header
 * carries `/releases/tag/v0.2.0`. That's deliberately not `api.github.com` - the redirect needs no
 * auth and has no 60-requests-per-hour cap, so `gusto upgrade` can't start failing for anyone
 * behind a busy NAT. A `GUSTO_CLI_BASE_URL` override (tests, staging) has no release to resolve,
 * hence null - the caller installs unconditionally in that case. */
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

/** Base URL the asset and its SHA256SUMS are fetched from.
 *
 * With a resolved tag this uses the explicit `/releases/download/$tag/` form rather than
 * install.sh's `/releases/latest/download/`, so the bytes come from the same release the version
 * comparison was made against - a release cut between the lookup and the download can't leave us
 * installing one version while reporting another. */
export function assetBaseUrl(env: EnvSource, tag: string | null): string {
  const override = env.GUSTO_CLI_BASE_URL;
  if (override !== undefined && override.length > 0) return override.replace(/\/+$/, "");
  const repo = env.GUSTO_CLI_REPO !== undefined && env.GUSTO_CLI_REPO.length > 0 ? env.GUSTO_CLI_REPO : DEFAULT_REPO;
  if (tag === null) return `https://github.com/${repo}/releases/latest/download`;
  return `https://github.com/${repo}/releases/download/${tag}`;
}

/** The expected hash for `asset` from a SHA256SUMS body, or null when it has no line for it.
 * Matches on the whole second field, like install.sh's `awk '$2 == a'`, so a sibling asset whose
 * name shares a prefix can't satisfy the lookup. */
export function parseSha256Sums(text: string, asset: string): string | null {
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 2 && fields[1] === asset) return fields[0] ?? null;
  }
  return null;
}

/** Reject an install dir we can't atomically swap a file into, before anything is downloaded.
 * `rename` needs write+execute on the *directory*, not the file - a read-only file in a writable
 * dir replaces fine, and a writable file in a locked dir does not. */
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
  /** Called just before the first byte is written, with a description of the write. Returns a
   * Blocked result to abort (the agent-mode `--confirm` gate) or null to proceed. */
  gate: (description: string) => CommandResult<never> | null;
  /** Progress lines, one per step. Routed to stderr by the command so stdout stays an envelope. */
  log: (line: string) => void;
  /** Everything below defaults to the real process/host. Tests override to stay off the network
   * and, critically, off the test runner's own executable. */
  env?: EnvSource;
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  execPath?: string;
  platform?: string;
  arch?: string;
  /** Run `<file> --version`; resolves to the reported version, or null if the binary won't run. */
  versionOf?: (file: string) => Promise<string | null>;
  /** Best-effort macOS quarantine strip. No-op elsewhere. */
  stripQuarantine?: (file: string) => Promise<void>;
}

/** Default `versionOf`: the new binary has to run and report a version before it's installed,
 * so a build that segfaults or was truncated past its checksum never becomes the live binary. */
export async function defaultVersionOf(file: string): Promise<string | null> {
  const proc = Bun.spawn([file, "--version"], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  const version = out.trim();
  return version.length > 0 ? version : null;
}

/** Default `stripQuarantine`: the release's darwin binaries are Developer ID signed but can't carry
 * a stapled notarization ticket (a bare Mach-O isn't stapleable), so Gatekeeper checks online and a
 * quarantine xattr can block first run. `fetch` doesn't set the attribute the way a browser download
 * does, so this is belt-and-braces - and deliberately silent on failure. */
export async function defaultStripQuarantine(file: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const proc = Bun.spawn(["xattr", "-d", "com.apple.quarantine", file], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // No xattr on PATH, or the attribute was never set. Neither blocks the upgrade.
  }
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

/** Resolve, verify, and atomically install the latest (or pinned) release.
 *
 * Ordering is the whole safety argument: everything that can fail cheaply - path resolution,
 * writability, version lookup - runs before a single byte is fetched, and the downloaded bytes are
 * checksummed and exec-checked in a staging file before the swap. The swap itself is one
 * `rename(2)` within the install dir, which is atomic and leaves no window where `gusto` is absent
 * or non-executable. On Unix that also means replacing the binary this very process is executing is
 * safe - the running image keeps its own inode. */
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
  const { targetPath } = pathResult;

  const preflight = await preflightInstallDir(targetPath);
  if (!preflight.ok) return preflight.result;

  const tagResult = await resolveTargetTag(env, fetchImpl);
  if (!tagResult.ok) return tagResult.result;
  const { tag } = tagResult;
  const targetVersion = tag === null ? null : tagToVersion(tag);

  const base = { from: currentVersion, to: targetVersion, asset, install_path: targetPath };

  if (targetVersion === currentVersion && opts.force !== true) {
    return {
      ok: true,
      data: { status: "up_to_date", ...base },
      human: () => `already up to date (${currentVersion})`,
    };
  }

  if (opts.dryRun === true) {
    return {
      ok: true,
      data: { status: "available", ...base },
      human: () => `upgrade available: ${currentVersion} -> ${targetVersion ?? "unknown"}`,
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
  const staged = path.join(path.dirname(targetPath), `.${BINARY_NAME}-upgrade-${process.pid}`);
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
      human: () => `upgraded gusto ${currentVersion} -> ${reported}`,
    };
  } finally {
    // Only present if we bailed before the rename; unlink is a no-op otherwise.
    await unlink(staged).catch(() => {});
  }
}
