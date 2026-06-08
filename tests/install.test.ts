import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Server = ReturnType<typeof Bun.serve>;

const INSTALL_SH = path.resolve(import.meta.dir, "..", "install.sh");

// A stand-in for the real compiled binary: a tiny script that prints a version
// string, so the installer's `gusto --version` sanity check has something to run.
const FAKE_BINARY = '#!/bin/sh\necho "0.0.1"\n';
const FAKE_SHA256 = createHash("sha256").update(FAKE_BINARY).digest("hex");

// install.sh asks for one of these depending on the host it runs on. The fixture
// server serves the same fake binary for every target and lists them all in
// SHA256SUMS, so the test passes regardless of the runner's OS/arch.
const TARGETS = ["gusto-darwin-arm64", "gusto-darwin-x64", "gusto-linux-x64"];

interface Fixture {
  server: Server;
  baseUrl: string;
  home: string;
}

// opts.binaryBody overrides the served binary (SHA256SUMS is computed to match);
// opts.corruptBinary serves tampered bytes to force a checksum mismatch;
// opts.sha256sumsBody overrides the served SHA256SUMS.
function startFixture(opts: { corruptBinary?: boolean; sha256sumsBody?: string; binaryBody?: string } = {}): Fixture {
  const home = mkdtempSync(path.join(tmpdir(), "gusto-cli-install-"));
  const corruptBinary = opts.corruptBinary ?? false;
  const binaryBody = opts.binaryBody ?? FAKE_BINARY;
  const binaryHash = createHash("sha256").update(binaryBody).digest("hex");
  const sha256sumsBody = opts.sha256sumsBody ?? `${TARGETS.map((t) => `${binaryHash}  ${t}`).join("\n")}\n`;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const name = pathname.replace(/^\//, "");
      if (name === "SHA256SUMS") {
        return new Response(sha256sumsBody, { headers: { "content-type": "text/plain" } });
      }
      if (TARGETS.includes(name)) {
        const body = corruptBinary ? "tampered\n" : binaryBody;
        return new Response(body, { headers: { "content-type": "application/octet-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { server, baseUrl: `http://localhost:${server.port}`, home };
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Single launch path for install.sh. `env` is merged over a base PATH; callers
// supply HOME/SHELL/GUSTO_CLI_* as needed.
async function runScript(env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(["sh", INSTALL_SH], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runInstall(fixture: Fixture, env: Record<string, string> = {}): Promise<Run> {
  return runScript({ HOME: fixture.home, SHELL: "/bin/bash", GUSTO_CLI_BASE_URL: fixture.baseUrl, ...env });
}

// Write an executable shim into its own dir (kept out of $HOME so it doesn't
// pollute the install target) and return the dir to prepend to PATH.
function writeShim(name: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gusto-cli-shim-"));
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  return dir;
}

// Build a dir symlinking only the named tools, to use as the *entire* PATH.
// Lets a test run install.sh with a specific tool (e.g. sha256sum) absent.
function linkTools(names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gusto-cli-tools-"));
  for (const name of names) {
    const real = Bun.which(name);
    if (!real) throw new Error(`linkTools: required tool not found on PATH: ${name}`);
    symlinkSync(real, path.join(dir, name));
  }
  return dir;
}

// A `uname` shim body reporting a given machine (-m) and system (-s).
function unameShimBody(machine: string, system: string): string {
  return `#!/bin/sh\nif [ "$1" = "-m" ]; then echo ${machine}; else echo ${system}; fi\n`;
}

// A `uname` shim returned as a PATH prefix so a test can simulate any OS/arch.
function unamePath(machine: string, system: string): string {
  const shim = writeShim("uname", unameShimBody(machine, system));
  tempDirs.push(shim);
  return `${shim}:${process.env.PATH ?? ""}`;
}

let fixture: Fixture | undefined;
const tempDirs: string[] = [];
afterEach(() => {
  fixture?.server.stop(true);
  if (fixture?.home) rmSync(fixture.home, { recursive: true, force: true });
  // Reset so a test that doesn't create a fixture (e.g. the URL-construction tests)
  // doesn't make afterEach re-stop a stale, already-stopped server.
  fixture = undefined;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("install.sh", () => {
  test("downloads the binary, installs it to $HOME/.gusto/bin, and it runs", async () => {
    fixture = startFixture();
    const result = await runInstall(fixture);

    expect(result.exitCode).toBe(0);

    const installed = path.join(fixture.home, ".gusto", "bin", "gusto");
    expect(existsSync(installed)).toBe(true);

    // Executable bit is set.
    expect(statSync(installed).mode & 0o111).not.toBe(0);

    // The installed file is the real downloaded content and runs.
    const proc = Bun.spawn([installed, "--version"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe("0.0.1");
  });

  test("aborts without installing when the checksum does not match", async () => {
    fixture = startFixture({ corruptBinary: true });
    const result = await runInstall(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("checksum");

    const installed = path.join(fixture.home, ".gusto", "bin", "gusto");
    expect(existsSync(installed)).toBe(false);
  });

  test("rolls back the install when the binary fails its version check", async () => {
    // Passes the checksum but exits non-zero on `--version`.
    fixture = startFixture({ binaryBody: "#!/bin/sh\nexit 1\n" });
    const result = await runInstall(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("version");
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(false);
  });

  test("adds the bin dir to the shell profile, idempotently", async () => {
    fixture = startFixture();
    const profile = path.join(fixture.home, ".bashrc");

    await runInstall(fixture, { SHELL: "/bin/bash" });
    expect(existsSync(profile)).toBe(true);
    const after1 = readFileSync(profile, "utf8");
    expect(after1).toContain(".gusto/bin");

    // Running again must not append a duplicate PATH line.
    await runInstall(fixture, { SHELL: "/bin/bash" });
    const after2 = readFileSync(profile, "utf8");
    const exportLines = after2.split("\n").filter((l) => /^export PATH=.*\.gusto\/bin/.test(l));
    expect(exportLines).toHaveLength(1);
  });

  test("errors clearly on an unsupported architecture, installing nothing", async () => {
    fixture = startFixture();
    const result = await runInstall(fixture, { PATH: unamePath("riscv64", "Linux") });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported architecture: riscv64");
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(false);
  });

  test("errors clearly on an unsupported OS, installing nothing", async () => {
    fixture = startFixture();
    const result = await runInstall(fixture, { PATH: unamePath("x86_64", "SunOS") });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unsupported OS: SunOS");
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(false);
  });

  test("errors clearly on linux arm64, which has no prebuilt binary", async () => {
    fixture = startFixture();
    const result = await runInstall(fixture, { PATH: unamePath("aarch64", "Linux") });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("linux arm64");
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(false);
  });

  test("maps the amd64 arch alias to x64", async () => {
    fixture = startFixture();
    const result = await runInstall(fixture, { PATH: unamePath("amd64", "Linux") });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(true);
  });

  test("maps the x86_64 arch to x64", async () => {
    fixture = startFixture();
    const result = await runInstall(fixture, { PATH: unamePath("x86_64", "Linux") });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(true);
  });

  test("aborts when SHA256SUMS has no line for the asset", async () => {
    // SHA256SUMS lists a different asset only, so there's no line for this host's target.
    fixture = startFixture({ sha256sumsBody: `${FAKE_SHA256}  gusto-some-other-target\n` });

    const result = await runInstall(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no checksum");
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(false);
  });

  test("honors GUSTO_INSTALL_DIR", async () => {
    fixture = startFixture();
    const dest = path.join(fixture.home, "custom", "dir");
    const result = await runInstall(fixture, { GUSTO_INSTALL_DIR: dest });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(dest, "gusto"))).toBe(true);
  });

  test("does not touch the profile when the install dir is already on PATH", async () => {
    fixture = startFixture();
    const dest = path.join(fixture.home, ".gusto", "bin");
    const result = await runInstall(fixture, {
      SHELL: "/bin/bash",
      PATH: `${dest}:${process.env.PATH ?? ""}`,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(fixture.home, ".bashrc"))).toBe(false);
  });

  test("errors clearly when neither HOME nor GUSTO_INSTALL_DIR is set", async () => {
    fixture = startFixture();
    // Empty HOME is treated as unset by the script's guard.
    const result = await runInstall(fixture, { HOME: "" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HOME");
    expect(result.stderr.toLowerCase()).toContain("gusto_install_dir");
  });

  test("installs and warns to set PATH when GUSTO_INSTALL_DIR is set but HOME is empty", async () => {
    fixture = startFixture();
    const dest = path.join(fixture.home, "explicit-bin");
    const result = await runInstall(fixture, { GUSTO_INSTALL_DIR: dest, HOME: "" });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(dest, "gusto"))).toBe(true);
    expect(result.stderr.toLowerCase()).toContain("add");
    expect(result.stderr).toContain("PATH");
  });

  test("adds the bin dir to .zshrc for a zsh shell", async () => {
    fixture = startFixture();
    await runInstall(fixture, { SHELL: "/bin/zsh" });
    const profile = path.join(fixture.home, ".zshrc");
    expect(existsSync(profile)).toBe(true);
    expect(readFileSync(profile, "utf8")).toContain(".gusto/bin");
  });

  test("falls back to .profile for a non-bash/zsh shell", async () => {
    fixture = startFixture();
    await runInstall(fixture, { SHELL: "/bin/sh" });
    const profile = path.join(fixture.home, ".profile");
    expect(existsSync(profile)).toBe(true);
    expect(readFileSync(profile, "utf8")).toContain(".gusto/bin");
  });

  test("clears the macOS quarantine attribute via xattr on darwin", async () => {
    fixture = startFixture();
    // Force darwin + a fake xattr (recording its args) so the macOS-only branch
    // runs deterministically on any host, including the ubuntu CI runner.
    const bin = mkdtempSync(path.join(tmpdir(), "gusto-cli-xattr-"));
    tempDirs.push(bin);
    const marker = path.join(bin, "xattr-called");
    writeFileSync(path.join(bin, "uname"), unameShimBody("arm64", "Darwin"), { mode: 0o755 });
    writeFileSync(path.join(bin, "xattr"), `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 });

    const result = await runInstall(fixture, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain("com.apple.quarantine");
  });

  test("verifies the checksum with shasum when sha256sum is unavailable", async () => {
    fixture = startFixture();
    // PATH without sha256sum forces the `shasum -a 256` branch. A fake shasum keeps
    // the test independent of whether the runner ships a real one (ubuntu may not).
    const toolDir = linkTools(["sh", "uname", "mktemp", "curl", "awk", "grep", "mkdir", "mv", "chmod", "rm"]);
    writeFileSync(path.join(toolDir, "shasum"), `#!/bin/sh\necho "${FAKE_SHA256}  $3"\n`, { mode: 0o755 });
    tempDirs.push(toolDir);

    const result = await runInstall(fixture, { PATH: toolDir });
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(fixture.home, ".gusto", "bin", "gusto"))).toBe(true);
  });
});

describe("install.sh URL construction", () => {
  // Shadow `curl` with a shim that records its first URL arg and fails, so the
  // GitHub release URL install.sh builds (no GUSTO_CLI_BASE_URL) is observable
  // without a network call. Reuses runScript so there's one launch path.
  async function recordCurlUrl(env: Record<string, string>): Promise<string> {
    const home = mkdtempSync(path.join(tmpdir(), "gusto-cli-url-"));
    tempDirs.push(home);
    const log = path.join(home, "curl.log");
    const bin = mkdtempSync(path.join(tmpdir(), "gusto-cli-urlbin-"));
    tempDirs.push(bin);
    writeFileSync(path.join(bin, "curl"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    // Force a supported platform so the OS/arch guard never short-circuits before
    // curl runs - otherwise the log is never created (e.g. on a linux arm64 host).
    writeFileSync(path.join(bin, "uname"), unameShimBody("x86_64", "Linux"), { mode: 0o755 });
    await runScript({ PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, SHELL: "/bin/bash", ...env });
    if (!existsSync(log)) {
      throw new Error("recordCurlUrl: install.sh exited before invoking curl (no curl.log written)");
    }
    return readFileSync(log, "utf8");
  }

  test("builds the latest-release URL by default", async () => {
    expect(await recordCurlUrl({})).toContain(
      "https://github.com/Gusto/gusto-cli-public/releases/latest/download/gusto-",
    );
  });

  test("builds a pinned-version URL when GUSTO_CLI_VERSION is set", async () => {
    expect(await recordCurlUrl({ GUSTO_CLI_VERSION: "v1.2.3" })).toContain(
      "https://github.com/Gusto/gusto-cli-public/releases/download/v1.2.3/gusto-",
    );
  });

  test("builds the URL from GUSTO_CLI_REPO when set", async () => {
    expect(await recordCurlUrl({ GUSTO_CLI_REPO: "acme/widget" })).toContain(
      "https://github.com/acme/widget/releases/latest/download/gusto-",
    );
  });
});
