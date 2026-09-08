import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvSource } from "../lib/env.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import type { CommandContext } from "../lib/runner.ts";
import { captureSinks } from "../lib/test-support.ts";
import { upgradeHandler } from "./upgrade.ts";

// The three assets a real release publishes. The fixture serves the same fake binary for each and
// lists them all in SHA256SUMS, so a test can pin any platform without a matching host.
const TARGETS = ["gusto-darwin-arm64", "gusto-darwin-x64", "gusto-linux-x64"];

const NEW_BINARY = '#!/bin/sh\necho "0.2.0"\n';

/** A stub gusto binary reporting `version` - stands in for both the installed and served binaries. */
const stub = (version: string): string => `#!/bin/sh\necho "${version}"\n`;

interface Fixture {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  /** The install dir, with an existing `gusto` in it - the binary being replaced. */
  installDir: string;
  installed: string;
  /** Asset paths the fixture was asked for, in order. */
  requests: string[];
}

function startFixture(
  opts: {
    corruptBinary?: boolean;
    /** Bytes, not a string, so a test can serve a real executable image without re-encoding it. */
    binaryBody?: string | Uint8Array;
    sha256sumsBody?: string;
    missingAsset?: boolean;
    /** Serve assets as a 302 to this origin instead, for the redirect-scheme guard. */
    redirectAssetsTo?: string;
    /** Version the *already installed* binary reports. Null installs nothing, leaving the dir empty. */
    installedVersion?: string | null;
  } = {},
): Fixture {
  const binaryBody = opts.binaryBody ?? NEW_BINARY;
  const hash = createHash("sha256").update(binaryBody).digest("hex");
  const sha256sumsBody = opts.sha256sumsBody ?? `${TARGETS.map((t) => `${hash}  ${t}`).join("\n")}\n`;
  const requests: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, "");
      requests.push(name);
      if (opts.redirectAssetsTo !== undefined) {
        return new Response("", { status: 302, headers: { location: `${opts.redirectAssetsTo}/${name}` } });
      }
      if (name === "SHA256SUMS") {
        return new Response(sha256sumsBody, { headers: { "content-type": "text/plain" } });
      }
      if (TARGETS.includes(name) && opts.missingAsset !== true) {
        return new Response(opts.corruptBinary === true ? "tampered\n" : binaryBody, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const installDir = tmpDir("gusto-cli-upgrade-cmd-");
  const installed = path.join(installDir, "gusto");
  const installedVersion = opts.installedVersion === undefined ? "0.1.0" : opts.installedVersion;
  if (installedVersion !== null) writeFileSync(installed, stub(installedVersion), { mode: 0o755 });

  return { server, baseUrl: `http://localhost:${server.port}`, installDir, installed, requests };
}

const scratchDirs: string[] = [];
let fixture: Fixture | undefined;

/** Canonicalized, because that's the form upgrade resolves paths to and reports back - on macOS
 * `$TMPDIR` lives under a `/var -> /private/var` link. */
function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  fixture?.server.stop(true);
  fixture = undefined;
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()!;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already removed.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function flags(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return { agent: true, human: false, json: false, verbose: false, ...overrides };
}

/** Run the handler against the fixture. `pin` is GUSTO_CLI_VERSION, which resolves the target tag
 * without touching github.com. The version upgrade compares against is read from the installed
 * binary itself, so control it with startFixture's `installedVersion`. */
async function runUpgrade(
  fx: Fixture,
  opts: { force?: boolean; dryRun?: boolean; confirm?: boolean } = {},
  extra: {
    pin?: string;
    env?: EnvSource;
    platform?: string;
    arch?: string;
    versionOf?: (file: string) => Promise<string | null>;
  } = {},
) {
  const { sinks, stderr } = captureSinks();
  const ctx: CommandContext = { command: "gusto upgrade", globals: flags(), sinks };
  const env: EnvSource = {
    GUSTO_INSTALL_DIR: fx.installDir,
    GUSTO_CLI_BASE_URL: fx.baseUrl,
    GUSTO_CLI_VERSION: extra.pin ?? "v0.2.0",
    ...extra.env,
  };
  const result = await upgradeHandler(opts, {
    env,
    currentVersion: "0.1.0",
    platform: extra.platform ?? "linux",
    arch: extra.arch ?? "x64",
    ...(extra.versionOf === undefined ? {} : { versionOf: extra.versionOf }),
  })(ctx);
  return { result, stderr: stderr.buffer };
}

function installedVersion(fx: Fixture): string {
  return readFileSync(fx.installed, "utf8").includes("0.2.0") ? "0.2.0" : "0.1.0";
}

/** Staging files are dot-prefixed inside the install dir; none may survive a run. */
function leftoverStagingFiles(fx: Fixture): string[] {
  return readdirSync(fx.installDir).filter((f) => f.startsWith("."));
}

describe("upgradeHandler", () => {
  test("downloads, verifies, and replaces the binary", async () => {
    fixture = startFixture();
    const { result, stderr } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        status: "upgraded",
        from: "0.1.0",
        to: "0.2.0",
        asset: "gusto-linux-x64",
        install_path: fixture.installed,
        checksum: "verified",
      });
    }
    expect(installedVersion(fixture)).toBe("0.2.0");
    expect(statSync(fixture.installed).mode & 0o111).not.toBe(0);
    expect(leftoverStagingFiles(fixture)).toEqual([]);
    // Progress goes to stderr, never stdout.
    expect(stderr).toContain("checksum verified");
    expect(stderr).toContain(fixture.installed);
  });

  test("reports already-up-to-date as a success and downloads nothing", async () => {
    fixture = startFixture({ installedVersion: "0.2.0" });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "up_to_date", from: "0.2.0", to: "0.2.0" });
    expect(fixture.requests).toEqual([]);
  });

  // Reachable whenever GUSTO_INSTALL_DIR names an install other than the running one.
  test("compares against the installed binary, not the running process", async () => {
    fixture = startFixture({ installedVersion: "0.0.1" });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "upgraded", from: "0.0.1", to: "0.2.0" });
    expect(installedVersion(fixture)).toBe("0.2.0");
  });

  test("installs, and reports from: null, when the target dir holds no binary yet", async () => {
    fixture = startFixture({ installedVersion: null });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "upgraded", from: null, to: "0.2.0" });
    expect(installedVersion(fixture)).toBe("0.2.0");
  });

  test("does not treat two unknown versions as a match", async () => {
    // No pin, so the target version is unknown under the base-url override; nothing is installed,
    // so the current version is unknown too. Two nulls must not read as up-to-date.
    fixture = startFixture({ installedVersion: null });
    const { result } = await runUpgrade(fixture, { confirm: true }, { env: { GUSTO_CLI_VERSION: "" } });

    expect(result.ok).toBe(true);
    // `to` starts unknown and is filled in from the installed binary's own --version afterwards.
    if (result.ok) expect(result.data).toMatchObject({ status: "upgraded", from: null, to: "0.2.0" });
    expect(installedVersion(fixture)).toBe("0.2.0");
  });

  test("--force reinstalls even when already up to date", async () => {
    fixture = startFixture({ installedVersion: "0.2.0" });
    const { result } = await runUpgrade(fixture, { confirm: true, force: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { status: string }).status).toBe("upgraded");
    expect(fixture.requests).toContain("gusto-linux-x64");
  });

  test("honors a GUSTO_CLI_VERSION pin, including a downgrade", async () => {
    // Serve a 0.0.9 build and pin to it while running 0.1.0.
    fixture = startFixture({ binaryBody: '#!/bin/sh\necho "0.0.9"\n' });
    const { result } = await runUpgrade(fixture, { confirm: true }, { pin: "v0.0.9" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "upgraded", from: "0.1.0", to: "0.0.9" });
  });

  test("aborts on a checksum mismatch, leaving the installed binary untouched", async () => {
    fixture = startFixture({ corruptBinary: true });
    const before = readFileSync(fixture.installed);
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("checksum_mismatch");
      // Exit 1 is the integrity contract: a caller should read it as permanent, not retry it.
      expect(result.exitCode).toBe(ExitCode.General);
      expect(result.error.message).toContain("nothing was changed");
    }
    expect(readFileSync(fixture.installed)).toEqual(before);
    expect(leftoverStagingFiles(fixture)).toEqual([]);
  });

  test("aborts when SHA256SUMS has no line for the asset", async () => {
    fixture = startFixture({ sha256sumsBody: "aaa  gusto-some-other-target\n" });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("checksum_missing");
      expect(result.exitCode).toBe(ExitCode.General);
    }
    expect(installedVersion(fixture)).toBe("0.1.0");
  });

  // Both cases matter because they fail differently: the second makes Bun.spawn throw ENOEXEC
  // rather than exit non-zero, which without the catch escapes as internal_error.
  test.each([
    ["a binary that runs but exits non-zero", "#!/bin/sh\nexit 1\n"],
    ["bytes that aren't executable at all", "not an executable\n"],
  ])("aborts on %s", async (_label, binaryBody) => {
    fixture = startFixture({ binaryBody });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("binary_check_failed");
      expect(result.exitCode).toBe(ExitCode.General);
    }
    expect(installedVersion(fixture)).toBe("0.1.0");
    expect(leftoverStagingFiles(fixture)).toEqual([]);
  });

  test("surfaces a download failure as a network error", async () => {
    fixture = startFixture({ missingAsset: true });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("download_failed");
      expect(result.exitCode).toBe(ExitCode.Network);
    }
  });

  test("blocks an agent-mode run without --confirm, before downloading anything", async () => {
    fixture = startFixture();
    const { result } = await runUpgrade(fixture, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("confirmation_required");
      expect(result.exitCode).toBe(ExitCode.Blocked);
      expect(result.error.message).toContain(fixture.installed);
    }
    expect(fixture.requests).toEqual([]);
    expect(installedVersion(fixture)).toBe("0.1.0");
  });

  test("--dry-run reports availability with no download and no --confirm", async () => {
    fixture = startFixture();
    const { result } = await runUpgrade(fixture, { dryRun: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "available", from: "0.1.0", to: "0.2.0" });
    expect(fixture.requests).toEqual([]);
    expect(installedVersion(fixture)).toBe("0.1.0");
    // Not just "downloaded nothing" - the disk is untouched. Asserting only the former is what let
    // a `mkdir` above the gate go unnoticed.
    expect(readdirSync(fixture.installDir)).toEqual(["gusto"]);
  });

  // Both of these ran the install dir's `mkdir` before deciding not to upgrade: `--dry-run` says it
  // reports "without downloading or replacing anything", and a blocked write is meant to stop
  // instead of executing. Creating directories is not nothing.
  test.each([
    ["--dry-run", { dryRun: true }, "available"],
    ["a run blocked for want of --confirm", {}, "confirmation_required"],
  ])("leaves a missing install dir uncreated: %s", async (_label, opts, expected) => {
    fixture = startFixture();
    const missing = path.join(fixture.installDir, "not", "yet", "bin");
    const { result } = await runUpgrade(fixture, opts, { env: { GUSTO_INSTALL_DIR: missing } });

    if (result.ok) {
      expect((result.data as { status: string }).status).toBe(expected);
      // Honest about the state rather than inventing a permission problem: nothing is installed there.
      expect((result.data as { from: string | null }).from).toBeNull();
    } else {
      expect(result.error.code).toBe(expected);
      expect(result.exitCode).toBe(ExitCode.Blocked);
    }
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(path.join(fixture.installDir, "not"))).toBe(false);
    expect(fixture.requests).toEqual([]);
  });

  // A stray file where the install dir belongs can never become a directory on its own, so both a
  // preview and a gated run must say so rather than promising an upgrade that can't happen. The
  // agent-mode case returning this instead of `confirmation_required` is what proves the refusal
  // lands before the gate.
  test.each([
    ["a file, --dry-run", { dryRun: true }, "file"],
    ["a file, agent mode without --confirm", {}, "file"],
    ["a dangling symlink, --dry-run", { dryRun: true }, "dangling"],
    ["a dangling symlink, agent mode without --confirm", {}, "dangling"],
  ] as const)("refuses what can never be an install dir: %s", async (_label, opts, kind) => {
    fixture = startFixture();
    const stray = path.join(fixture.installDir, "stray");
    if (kind === "dangling") symlinkSync(path.join(fixture.installDir, "never-existed"), stray);
    else writeFileSync(stray, "#!/bin/sh\n", { mode: 0o755 });

    const { result } = await runUpgrade(fixture, opts, { env: { GUSTO_INSTALL_DIR: stray } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Not `confirmation_required`, which is what proves the refusal lands before the gate.
      expect(result.error.code).toBe("install_dir_not_a_directory");
      expect(result.exitCode).toBe(ExitCode.Validation);
    }
    expect(fixture.requests).toEqual([]);
    expect(lstatSync(stray).isSymbolicLink()).toBe(kind === "dangling");
  });

  // The pre-gate check reads permissions off the nearest existing ancestor, so an install dir that
  // can never be created is refused before the gate - and without creating anything on the way.
  test.skipIf(process.getuid?.() === 0)("refuses an install dir whose parent is not writable", async () => {
    fixture = startFixture();
    const locked = path.join(fixture.installDir, "locked");
    mkdirSync(locked, { mode: 0o500 });
    const { result } = await runUpgrade(
      fixture,
      { confirm: true },
      { env: { GUSTO_INSTALL_DIR: path.join(locked, "bin") } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("install_dir_not_writable");
      expect(result.exitCode).toBe(ExitCode.Blocked);
      expect(result.error.message).toContain("is not writable");
    }
    expect(fixture.requests).toEqual([]);
  });

  test("refuses a read-only install dir without downloading", async () => {
    if (process.getuid?.() === 0) return;
    fixture = startFixture();
    chmodSync(fixture.installDir, 0o500);
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("install_dir_not_writable");
      expect(result.exitCode).toBe(ExitCode.Blocked);
    }
    expect(fixture.requests).toEqual([]);
  });

  test("refuses a package-manager-managed install", async () => {
    fixture = startFixture();
    const { result } = await runUpgrade(
      fixture,
      { confirm: true },
      { env: { GUSTO_INSTALL_DIR: "/opt/homebrew/bin" } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("managed_install");
    expect(fixture.requests).toEqual([]);
  });

  test("refuses an unsupported platform before touching the network", async () => {
    fixture = startFixture();
    const { result } = await runUpgrade(fixture, { confirm: true }, { platform: "linux", arch: "arm64" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_platform");
    expect(fixture.requests).toEqual([]);
  });

  // The fallback an operator or agent follows when the automated path can't finish. Which failures
  // carry it is the whole point: the installer fetches the same release by a different route, so it
  // routes around a flaky network but is useless against a checksum mismatch and harmful on a
  // package-managed install. A hint that can't work is worse than none - an agent will follow it.
  // Rendering is not retested here: output.test.ts already pins `hint` reaching stderr in both agent
  // and human mode, so these assert the envelope carries the right hint and let that composition be.
  describe("recovery hints", () => {
    const installerHint = "install.sh";

    test("a network failure points at the installer, which retries where this doesn't", async () => {
      fixture = startFixture({ missingAsset: true });
      const { result } = await runUpgrade(fixture, { confirm: true });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("download_failed");
        expect(result.error.hint).toContain(installerHint);
      }
    });

    // Reinstalling reruns the identical verification against the identical bytes, so pointing there
    // would be a loop with no exit. Naming a version is the only move that changes the input.
    test.each([
      ["a corrupt asset", { corruptBinary: true }, "checksum_mismatch"],
      ["no checksum line", { sha256sumsBody: "aaa  gusto-other\n" }, "checksum_missing"],
      ["a build that won't run", { binaryBody: "not an executable\n" }, "binary_check_failed"],
    ])("an integrity failure points at pinning, not reinstalling: %s", async (_label, opts, code) => {
      fixture = startFixture(opts);
      const { result } = await runUpgrade(fixture, { confirm: true });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.hint).toContain("GUSTO_CLI_VERSION");
        expect(result.error.hint).not.toContain(installerHint);
      }
    });

    // The installer drops a binary in ~/.gusto/bin and puts it on PATH, which would shadow the
    // managed one - so this failure must never suggest it. Same for a platform with no build at all:
    // no route fetches a binary that was never published.
    test.each([
      ["a package-managed install", { GUSTO_INSTALL_DIR: "/opt/homebrew/bin" }, {}, "managed_install"],
      ["an unsupported platform", {}, { platform: "linux", arch: "arm64" }, "unsupported_platform"],
    ])("offers no reinstall where it cannot help: %s", async (_label, env, hostOverrides, code) => {
      fixture = startFixture();
      const { result } = await runUpgrade(fixture, { confirm: true }, { env, ...hostOverrides });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.hint).toBeUndefined();
      }
    });

    // Separate from the two above because it needs something on disk. install.sh runs `mkdir -p` on
    // the same GUSTO_INSTALL_DIR, so the stray file blocks it exactly as it blocks us - its own
    // `mktemp -d` staging is beside the point. Exit 7 rather than 8 already says nobody's retry
    // will help here, so a hint offering one would have contradicted the code beside it.
    test("offers no reinstall where it cannot help: a file where the install dir belongs", async () => {
      fixture = startFixture();
      const stray = path.join(fixture.installDir, "not-a-dir");
      writeFileSync(stray, "in the way\n");

      const { result } = await runUpgrade(fixture, { confirm: true }, { env: { GUSTO_INSTALL_DIR: stray } });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("install_dir_not_a_directory");
        expect(result.error.hint).toBeUndefined();
      }
    });
  });

  // install.sh's `--proto-redir "=https"`: the initial scheme is loose so GUSTO_CLI_BASE_URL can be
  // http for tests and staging, but the hop we don't choose can't land on http. The redirect target
  // here serves a perfectly good, correctly-checksummed asset - the scheme alone is the refusal.
  test("refuses to install bytes from a redirect that leaves https", async () => {
    const elsewhere = startFixture();
    try {
      fixture = startFixture({ redirectAssetsTo: elsewhere.baseUrl });
      const before = readFileSync(fixture.installed);
      const { result } = await runUpgrade(fixture, { confirm: true });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("insecure_redirect");
        expect(result.exitCode).toBe(ExitCode.General);
      }
      expect(readFileSync(fixture.installed)).toEqual(before);
      expect(leftoverStagingFiles(fixture)).toEqual([]);
    } finally {
      elsewhere.server.stop(true);
    }
  });

  // Every other case stages a shell script, which cannot catch this: Linux refuses to execute a file
  // anyone holds open for writing (ETXTBSY), and that applies to the executable image, not to a
  // script's interpreter - so holding the wrong kind of descriptor across the exec-check passes a
  // script and breaks every real upgrade. Linux-only on both counts: it is where the hazard is, and
  // macOS SIGKILLs a copied platform-signed binary like /bin/echo, which would fail for its own
  // unrelated reason.
  test.skipIf(process.platform !== "linux" || !existsSync("/bin/echo"))(
    "exec-checks a real executable image, not just a script",
    async () => {
      fixture = startFixture({ binaryBody: new Uint8Array(readFileSync("/bin/echo")) });
      const { result } = await runUpgrade(fixture, { confirm: true });

      expect(result.ok).toBe(true);
      if (result.ok) expect((result.data as { status: string }).status).toBe("upgraded");
      expect(leftoverStagingFiles(fixture)).toEqual([]);
    },
  );

  // Losing a race used to report `binary_check_failed` - the other run's preflight had unlinked our
  // staging file, so the exec-check found nothing to run and the code blamed the release. The other
  // run is simulated by swapping the staging file out at exactly that moment; the point is that
  // both the message and the rename decision key off file identity, not mere presence.
  test("reports a lost race as such, not as a corrupt release artifact", async () => {
    fixture = startFixture();
    const staged = path.join(fixture.installDir, ".gusto-upgrade");
    const before = readFileSync(fixture.installed);

    const { result } = await runUpgrade(
      fixture,
      { confirm: true },
      {
        versionOf: async (file) => {
          if (file !== staged) return "0.1.0";
          rmSync(staged);
          writeFileSync(staged, "another run's download", { mode: 0o755 });
          return null;
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("staging_path_blocked");
      expect(result.exitCode).toBe(ExitCode.Blocked);
      expect(result.error.message).toContain("another `gusto upgrade`");
    }
    // The other run's staging file is theirs: not installed, and not cleaned up on our way out.
    expect(readFileSync(fixture.installed)).toEqual(before);
    expect(readFileSync(staged, "utf8")).toBe("another run's download");
  });

  // Nothing used to check this: the write reached Bun.write as a raw EISDIR after the whole asset
  // had downloaded, surfaced as internal_error, and never cleared - so every later run repeated it.
  test("refuses a blocked staging path before downloading, leaving it alone", async () => {
    fixture = startFixture();
    const staged = path.join(fixture.installDir, ".gusto-upgrade");
    mkdirSync(staged);

    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("staging_path_blocked");
      expect(result.exitCode).toBe(ExitCode.Blocked);
    }
    expect(fixture.requests).toEqual([]);
    expect(statSync(staged).isDirectory()).toBe(true);
    expect(installedVersion(fixture)).toBe("0.1.0");
  });

  // Bun.write follows a symlink, so without the guard the release bytes land in the link's target,
  // chmod widens that file to 0755, and the rename moves the link itself onto the install path.
  test("refuses a symlinked staging path rather than writing through it", async () => {
    fixture = startFixture();
    const victim = path.join(fixture.installDir, "someone-elses-file");
    writeFileSync(victim, "private", { mode: 0o600 });
    symlinkSync(victim, path.join(fixture.installDir, ".gusto-upgrade"));

    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("staging_path_blocked");
    expect(readFileSync(victim, "utf8")).toBe("private");
    expect(statSync(victim).mode & 0o777).toBe(0o600);
    expect(installedVersion(fixture)).toBe("0.1.0");
  });

  // install.sh does `mkdir -p "$INSTALL_DIR"`; without it this reported install_dir_not_writable.
  test("creates an install dir that doesn't exist yet", async () => {
    fixture = startFixture({ installedVersion: null });
    const fresh = path.join(fixture.installDir, "nested", "bin");
    const { result } = await runUpgrade(fixture, { confirm: true }, { env: { GUSTO_INSTALL_DIR: fresh } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "upgraded", from: null });
    expect(existsSync(path.join(fresh, "gusto"))).toBe(true);
  });

  // The only invocation a real user makes - no GUSTO_INSTALL_DIR, upgrading the running binary -
  // and the one every other test here opts out of by setting the env var. The compiled-in version
  // standing in for the installed one is exactly what keeps this path free of an extra spawn, so
  // the spy going uncalled is the assertion, not a detail.
  test("upgrades the running binary using its own version, without spawning it", async () => {
    fixture = startFixture();
    const selfDir = tmpDir("gusto-cli-upgrade-self-");
    const self = path.join(selfDir, "gusto");
    writeFileSync(self, stub("0.1.0"), { mode: 0o755 });

    let versionOfCalls = 0;
    const { sinks } = captureSinks();
    const ctx: CommandContext = { command: "gusto upgrade", globals: flags(), sinks };
    const result = await upgradeHandler(
      { dryRun: true },
      {
        env: { GUSTO_CLI_BASE_URL: fixture.baseUrl, GUSTO_CLI_VERSION: "v0.2.0" },
        currentVersion: "0.1.0",
        execPath: self,
        platform: "linux",
        arch: "x64",
        versionOf: async () => {
          versionOfCalls += 1;
          return "0.0.0";
        },
      },
    )(ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ status: "available", from: "0.1.0", to: "0.2.0", install_path: self });
    }
    expect(versionOfCalls).toBe(0);
  });

  // SIGINT is the realistic way one gets stranded: index.ts's handler calls process.exit, which
  // doesn't unwind the finally block guarding the staging write.
  test("reuses a staging file stranded by an interrupted earlier run", async () => {
    fixture = startFixture();
    const stale = path.join(fixture.installDir, ".gusto-upgrade");
    writeFileSync(stale, "half a download");

    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(installedVersion(fixture)).toBe("0.2.0");
    expect(leftoverStagingFiles(fixture)).toEqual([]);
  });

  test("does not gate in human mode - the operator at the TTY is the approval", async () => {
    fixture = startFixture();
    const { sinks } = captureSinks();
    const ctx: CommandContext = { command: "gusto upgrade", globals: flags({ agent: false, human: true }), sinks };
    const result = await upgradeHandler(
      {},
      {
        env: {
          GUSTO_INSTALL_DIR: fixture.installDir,
          GUSTO_CLI_BASE_URL: fixture.baseUrl,
          GUSTO_CLI_VERSION: "v0.2.0",
        },
        currentVersion: "0.1.0",
        platform: "linux",
        arch: "x64",
      },
    )(ctx);

    expect(result.ok).toBe(true);
    expect(installedVersion(fixture)).toBe("0.2.0");
  });

  test("renders a human summary for each outcome", async () => {
    fixture = startFixture();
    const upgraded = await runUpgrade(fixture, { confirm: true });
    if (upgraded.result.ok) expect(upgraded.result.human?.()).toBe("upgraded gusto 0.1.0 -> 0.2.0");

    fixture.server.stop(true);
    fixture = startFixture({ installedVersion: "0.2.0" });
    const current = await runUpgrade(fixture, { confirm: true });
    if (current.result.ok) expect(current.result.human?.()).toBe("already up to date (0.2.0)");

    fixture.server.stop(true);
    fixture = startFixture({ installedVersion: "0.1.0" });
    const preview = await runUpgrade(fixture, { dryRun: true });
    if (preview.result.ok) expect(preview.result.human?.()).toBe("upgrade available: 0.1.0 -> 0.2.0");

    fixture.server.stop(true);
    fixture = startFixture({ installedVersion: null });
    const absent = await runUpgrade(fixture, { dryRun: true });
    if (absent.result.ok) expect(absent.result.human?.()).toBe("upgrade available: not installed -> 0.2.0");
  });
});
