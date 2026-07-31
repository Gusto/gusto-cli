import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";
import {
  assetBaseUrl,
  parseSha256Sums,
  platformAsset,
  preflightInstallDir,
  resolveTargetPath,
  resolveTargetTag,
  tagToVersion,
} from "./upgrade.ts";

const scratchDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
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

/** Bun's `typeof fetch` also carries `preconnect`, which a stub has no reason to implement.
 * Same single-cast shape test-support.ts uses for its ApiClient fetch stubs. */
function stubFetch(impl: (url: string | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

/** Narrow a helper's failure branch to the error result, so tests can assert on code/exitCode/hint. */
function failure(failed: { result: CommandResult<never> }) {
  if (failed.result.ok) throw new Error("expected a failure");
  return failed.result;
}

const repoFile = (name: string): Promise<string> => Bun.file(path.resolve(import.meta.dir, "..", "..", name)).text();

describe("platformAsset", () => {
  const EVERY_COMBO = [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ] as const;

  /** Every asset name platformAsset will ask for, across all four platform/arch combinations. */
  function acceptedAssets(): string[] {
    return EVERY_COMBO.map(([platform, arch]) => platformAsset(platform, arch)).flatMap((r) => (r.ok ? [r.asset] : []));
  }

  // The invariant that matters: upgrade asks for exactly the assets the release actually publishes.
  // Pinned against release.yml rather than a literal list here, so adding a platform (linux-arm64,
  // once there's a build for it) fails this test until platformAsset follows - otherwise upgrade
  // keeps rejecting a host the installer has started serving.
  test("accepts exactly the platforms release.yml publishes", async () => {
    const workflow = await repoFile(".github/workflows/release.yml");
    const line = /^\s*assets="(.+)"\s*$/m.exec(workflow);
    expect(line).not.toBeNull();
    const published = line![1]
      .split(/\s+/)
      .map((p) => path.basename(p))
      .filter((name) => name !== "SHA256SUMS");

    expect(acceptedAssets().sort()).toEqual(published.sort());
  });

  test("still matches the asset name install.sh builds", async () => {
    const script = await repoFile("install.sh");
    expect(script).toContain('asset="gusto-$os-$arch"');
    // The tokens install.sh maps uname output to, which are also what process.platform/arch yield.
    for (const token of ["darwin", "linux", 'arch="arm64"', 'arch="x64"']) {
      expect(script).toContain(token);
    }
  });

  test("rejects linux arm64, which has no prebuilt binary", () => {
    const result = platformAsset("linux", "arm64");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("unsupported_platform");
      expect(failure(result).error.message).toContain("Linux arm64");
    }
  });

  test("rejects an unsupported OS and an unsupported arch", () => {
    const os = platformAsset("sunos", "x64");
    expect(os.ok).toBe(false);
    if (!os.ok) expect(failure(os).error.message).toContain("unsupported OS: sunos");

    const arch = platformAsset("linux", "riscv64");
    expect(arch.ok).toBe(false);
    if (!arch.ok) expect(failure(arch).error.message).toContain("unsupported architecture: riscv64");
  });
});

describe("resolveTargetPath", () => {
  test("uses GUSTO_INSTALL_DIR when set", () => {
    const result = resolveTargetPath({ GUSTO_INSTALL_DIR: "/opt/tools/bin" }, "/anything/at/all");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetPath).toBe("/opt/tools/bin/gusto");
  });

  test("resolves the running binary through a symlink", () => {
    const dir = tmpDir("gusto-cli-upgrade-link-");
    const real = path.join(dir, "gusto");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    const link = path.join(dir, "gusto-link");
    symlinkSync(real, link);

    const result = resolveTargetPath({}, link);
    expect(result.ok).toBe(true);
    // realpath also canonicalizes /var -> /private/var on macOS, so compare basenames + dir.
    if (result.ok) expect(path.basename(result.targetPath)).toBe("gusto");
    if (result.ok) expect(result.targetPath).not.toBe(link);
  });

  test("refuses to replace an executable that isn't named gusto (the bun run dev case)", () => {
    const result = resolveTargetPath({}, "/usr/local/bin/bun");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("not_installed_binary");
      expect(failure(result).exitCode).toBe(ExitCode.Validation);
      expect(failure(result).error.message).toContain("/usr/local/bin/bun");
    }
  });

  test("flags the running executable as isSelf, and another install as not", () => {
    const dir = tmpDir("gusto-cli-upgrade-self-");
    const self = path.join(dir, "gusto");
    writeFileSync(self, "#!/bin/sh\n", { mode: 0o755 });

    // GUSTO_INSTALL_DIR naming the dir we're running from is still ourselves...
    const same = resolveTargetPath({ GUSTO_INSTALL_DIR: dir }, self);
    expect(same.ok && same.isSelf).toBe(true);

    // ...but naming a different install is not, and that's what stops VERSION standing in for it.
    const other = resolveTargetPath({ GUSTO_INSTALL_DIR: "/somewhere/else/bin" }, self);
    expect(other.ok && other.isSelf).toBe(false);

    const bare = resolveTargetPath({}, self);
    expect(bare.ok && bare.isSelf).toBe(true);
  });

  test("treats an empty GUSTO_INSTALL_DIR as unset", () => {
    const result = resolveTargetPath({ GUSTO_INSTALL_DIR: "" }, "/usr/local/bin/bun");
    expect(result.ok).toBe(false);
  });
});

describe("tagToVersion", () => {
  test("strips a leading v and leaves a bare version alone", () => {
    expect(tagToVersion("v0.2.0")).toBe("0.2.0");
    expect(tagToVersion("0.2.0")).toBe("0.2.0");
  });
});

describe("resolveTargetTag", () => {
  test("honors a GUSTO_CLI_VERSION pin without any network call", async () => {
    let called = false;
    const result = await resolveTargetTag(
      { GUSTO_CLI_VERSION: "v1.2.3" },
      stubFetch(() => {
        called = true;
        throw new Error("should not fetch");
      }),
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tag).toBe("v1.2.3");
  });

  test("treats the literal 'latest' pin as unpinned and resolves it", async () => {
    const result = await resolveTargetTag(
      { GUSTO_CLI_VERSION: "latest" },
      stubFetch(async () => redirectTo("https://github.com/Gusto/gusto-cli/releases/tag/v0.9.1")),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tag).toBe("v0.9.1");
  });

  test("reports an unknown tag under a GUSTO_CLI_BASE_URL override", async () => {
    const result = await resolveTargetTag(
      { GUSTO_CLI_BASE_URL: "http://localhost:1234" },
      stubFetch(() => {
        throw new Error("should not fetch");
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tag).toBeNull();
  });

  test("reads the tag out of the /releases/latest redirect", async () => {
    const seen: string[] = [];
    const result = await resolveTargetTag(
      {},
      stubFetch(async (url, init) => {
        seen.push(String(url));
        expect(init?.redirect).toBe("manual");
        return redirectTo("https://github.com/Gusto/gusto-cli/releases/tag/v0.2.0");
      }),
    );
    expect(seen).toEqual(["https://github.com/Gusto/gusto-cli/releases/latest"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tag).toBe("v0.2.0");
  });

  test("honors GUSTO_CLI_REPO in the lookup URL", async () => {
    const seen: string[] = [];
    await resolveTargetTag(
      { GUSTO_CLI_REPO: "acme/widget" },
      stubFetch(async (url) => {
        seen.push(String(url));
        return redirectTo("https://github.com/acme/widget/releases/tag/v3.0.0");
      }),
    );
    expect(seen[0]).toBe("https://github.com/acme/widget/releases/latest");
  });

  test("fails on a network error, as a network exit code", async () => {
    const result = await resolveTargetTag(
      {},
      stubFetch(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("release_lookup_failed");
      expect(failure(result).exitCode).toBe(ExitCode.Network);
    }
  });

  test("fails when the response carries no parseable tag", async () => {
    const result = await resolveTargetTag(
      {},
      stubFetch(async () => new Response("", { status: 404 })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("release_lookup_failed");
      expect(failure(result).error.message).toContain("GUSTO_CLI_VERSION");
    }
  });
});

/** A 302 whose Location a caller is expected to read rather than follow. */
function redirectTo(location: string): Response {
  return new Response("", { status: 302, headers: { location } });
}

describe("assetBaseUrl", () => {
  test("pins the resolved tag rather than using /releases/latest/download", () => {
    expect(assetBaseUrl({}, "v0.2.0")).toBe("https://github.com/Gusto/gusto-cli/releases/download/v0.2.0");
  });

  test("falls back to /releases/latest/download when the tag is unknown", () => {
    expect(assetBaseUrl({}, null)).toBe("https://github.com/Gusto/gusto-cli/releases/latest/download");
  });

  test("honors GUSTO_CLI_REPO", () => {
    expect(assetBaseUrl({ GUSTO_CLI_REPO: "acme/widget" }, "v1.0.0")).toBe(
      "https://github.com/acme/widget/releases/download/v1.0.0",
    );
  });

  test("GUSTO_CLI_BASE_URL wins and loses any trailing slash", () => {
    expect(assetBaseUrl({ GUSTO_CLI_BASE_URL: "http://localhost:8787/" }, "v0.2.0")).toBe("http://localhost:8787");
  });
});

describe("parseSha256Sums", () => {
  const body = ["aaa  gusto-darwin-arm64", "bbb  gusto-darwin-x64", "ccc  gusto-linux-x64", ""].join("\n");

  test("returns the hash for an exact asset name", () => {
    expect(parseSha256Sums(body, "gusto-darwin-x64")).toBe("bbb");
  });

  test("returns null when the asset has no line", () => {
    expect(parseSha256Sums(body, "gusto-linux-arm64")).toBeNull();
  });

  test("does not prefix-match a sibling asset", () => {
    expect(parseSha256Sums("aaa  gusto-darwin-arm64-debug\n", "gusto-darwin-arm64")).toBeNull();
  });

  test("tolerates the single-space and tab separators sha256sum can emit", () => {
    expect(parseSha256Sums("aaa gusto-linux-x64\n", "gusto-linux-x64")).toBe("aaa");
    expect(parseSha256Sums("aaa\tgusto-linux-x64\n", "gusto-linux-x64")).toBe("aaa");
  });
});

describe("preflightInstallDir", () => {
  test("passes for a writable dir", async () => {
    const dir = tmpDir("gusto-cli-upgrade-ok-");
    expect((await preflightInstallDir(path.join(dir, "gusto"))).ok).toBe(true);
  });

  test("refuses a Homebrew-managed path, naming the manager", async () => {
    const result = await preflightInstallDir("/opt/homebrew/bin/gusto");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("managed_install");
      expect(failure(result).exitCode).toBe(ExitCode.Blocked);
      expect(failure(result).error.message).toContain("Homebrew");
    }
  });

  test("refuses a Nix store path", async () => {
    const result = await preflightInstallDir("/nix/store/abc123-gusto/bin/gusto");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failure(result).error.message).toContain("Nix");
  });

  test.skipIf(process.getuid?.() === 0)("refuses a dir it can't write to, with a reinstall hint", async () => {
    const dir = tmpDir("gusto-cli-upgrade-ro-");
    chmodSync(dir, 0o500);
    const result = await preflightInstallDir(path.join(dir, "gusto"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("install_dir_not_writable");
      expect(failure(result).exitCode).toBe(ExitCode.Blocked);
      expect(failure(result).error.hint).toContain("install.sh");
    }
  });
});
