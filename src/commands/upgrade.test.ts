import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const OLD_BINARY = '#!/bin/sh\necho "0.1.0"\n';

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
  opts: { corruptBinary?: boolean; binaryBody?: string; sha256sumsBody?: string; missingAsset?: boolean } = {},
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
  writeFileSync(installed, OLD_BINARY, { mode: 0o755 });

  return { server, baseUrl: `http://localhost:${server.port}`, installDir, installed, requests };
}

const scratchDirs: string[] = [];
let fixture: Fixture | undefined;

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
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

/** Run the handler against the fixture. `version` is the version the *current* binary reports;
 * `pin` is GUSTO_CLI_VERSION, which resolves the target tag without touching github.com. */
async function runUpgrade(
  fx: Fixture,
  opts: { force?: boolean; dryRun?: boolean; confirm?: boolean } = {},
  extra: { version?: string; pin?: string; env?: EnvSource; platform?: string; arch?: string } = {},
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
    currentVersion: extra.version ?? "0.1.0",
    platform: extra.platform ?? "linux",
    arch: extra.arch ?? "x64",
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
    fixture = startFixture();
    const { result } = await runUpgrade(fixture, { confirm: true }, { version: "0.2.0" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ status: "up_to_date", from: "0.2.0", to: "0.2.0" });
    expect(fixture.requests).toEqual([]);
    expect(installedVersion(fixture)).toBe("0.1.0");
  });

  test("--force reinstalls even when already up to date", async () => {
    fixture = startFixture();
    const { result } = await runUpgrade(fixture, { confirm: true, force: true }, { version: "0.2.0" });

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
      expect(result.error.message).toContain("nothing was changed");
    }
    expect(readFileSync(fixture.installed)).toEqual(before);
    expect(leftoverStagingFiles(fixture)).toEqual([]);
  });

  test("aborts when SHA256SUMS has no line for the asset", async () => {
    fixture = startFixture({ sha256sumsBody: "aaa  gusto-some-other-target\n" });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("checksum_missing");
    expect(installedVersion(fixture)).toBe("0.1.0");
  });

  test("aborts when the downloaded binary fails its --version check", async () => {
    fixture = startFixture({ binaryBody: "#!/bin/sh\nexit 1\n" });
    const { result } = await runUpgrade(fixture, { confirm: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("binary_check_failed");
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
    fixture = startFixture();
    const current = await runUpgrade(fixture, { confirm: true }, { version: "0.2.0" });
    if (current.result.ok) expect(current.result.human?.()).toBe("already up to date (0.2.0)");

    const preview = await runUpgrade(fixture, { dryRun: true });
    if (preview.result.ok) expect(preview.result.human?.()).toBe("upgrade available: 0.1.0 -> 0.2.0");
  });
});
