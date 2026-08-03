import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";
import {
  assetBaseUrl,
  parseSha256Sums,
  platformAsset,
  preflightInstallDir,
  preflightStagingPath,
  resolveTargetPath,
  resolveTargetTag,
  tagToVersion,
} from "./upgrade.ts";

const scratchDirs: string[] = [];

/** Canonicalized, because that's the form `resolveTargetPath` reports back - on macOS `$TMPDIR`
 * lives under a `/var -> /private/var` link. */
function tmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
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

  // The shape that matters: /usr/local/bin/gusto is a symlink into the Cellar on an Intel Homebrew
  // install, so leaving the GUSTO_INSTALL_DIR join unresolved would clear the managed-install guard
  // and replace the link - and report `from` off a file it didn't touch.
  test("resolves a GUSTO_INSTALL_DIR path through a symlink, like the execPath branch", () => {
    const dir = tmpDir("gusto-cli-upgrade-dirlink-");
    const real = path.join(dir, "gusto-real");
    writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(real, path.join(dir, "gusto"));

    const result = resolveTargetPath({ GUSTO_INSTALL_DIR: dir }, "/anything/at/all");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targetPath).toBe(real);
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

  // install.sh's `mkdir -p "$INSTALL_DIR"`. Without it a first install into a dir that doesn't
  // exist yet fails ENOENT and reports as "not writable", which is a different problem.
  test("creates the install dir when it doesn't exist yet", async () => {
    const dir = path.join(tmpDir("gusto-cli-upgrade-mkdir-"), "nested", "bin");
    expect((await preflightInstallDir(path.join(dir, "gusto"))).ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)("names the real problem when the dir can't be created", async () => {
    const parent = tmpDir("gusto-cli-upgrade-nomkdir-");
    chmodSync(parent, 0o500);
    const result = await preflightInstallDir(path.join(parent, "bin", "gusto"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("install_dir_not_writable");
      expect(failure(result).error.message).toContain("cannot create");
    }
  });
});

describe("preflightStagingPath", () => {
  test("passes when nothing is there", async () => {
    const dir = tmpDir("gusto-cli-staging-clear-");
    expect((await preflightStagingPath(path.join(dir, ".gusto-upgrade"))).ok).toBe(true);
  });

  // The fixed staging name only bounds strays at one file if the next run can actually clear it.
  test("clears a regular file stranded by an interrupted run", async () => {
    const dir = tmpDir("gusto-cli-staging-strand-");
    const staged = path.join(dir, ".gusto-upgrade");
    writeFileSync(staged, "half a download");

    expect((await preflightStagingPath(staged)).ok).toBe(true);
    expect(existsSync(staged)).toBe(false);
  });

  // A directory here used to reach Bun.write as a raw EISDIR after the whole asset had downloaded,
  // and nothing cleared it, so every later run repeated the download and died the same way.
  test("refuses a directory, before anything is downloaded", async () => {
    const dir = tmpDir("gusto-cli-staging-dir-");
    const staged = path.join(dir, ".gusto-upgrade");
    mkdirSync(staged);

    const result = await preflightStagingPath(staged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failure(result).error.code).toBe("staging_path_blocked");
      expect(failure(result).exitCode).toBe(ExitCode.Blocked);
    }
    expect(existsSync(staged)).toBe(true);
  });

  // Bun.write follows a symlink: the release bytes would land in the link's target, chmod would
  // widen that file to 0755, and the rename would move the link itself onto the install path.
  test("refuses a symlink rather than writing through it", async () => {
    const dir = tmpDir("gusto-cli-staging-link-");
    const victim = path.join(dir, "someone-elses-file");
    writeFileSync(victim, "private", { mode: 0o600 });
    const staged = path.join(dir, ".gusto-upgrade");
    symlinkSync(victim, staged);

    const result = await preflightStagingPath(staged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failure(result).error.code).toBe("staging_path_blocked");
    expect(readFileSync(victim, "utf8")).toBe("private");
    expect(statSync(victim).mode & 0o777).toBe(0o600);
  });
});
