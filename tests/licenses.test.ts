import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isAllowed, isPackageRoot, licenseOf, licenseText, parseBunVersion } from "../scripts/licenses.ts";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = resolve(REPO, "scripts", "licenses.ts");

function runCli(args: string[], cwd: string = REPO): number {
  // exitCode is null when the process is killed by a signal; treat that as a
  // failure code so it never coincides with an expected 0/1/2.
  return Bun.spawnSync(["bun", SCRIPT, ...args], { cwd }).exitCode ?? -1;
}

function runCliStderr(args: string[], cwd: string = REPO): string {
  return Bun.spawnSync(["bun", SCRIPT, ...args], { cwd }).stderr.toString();
}

// Build a throwaway project the CLI can scan: workflows for bunVersion(), a root
// manifest, and installed packages under node_modules.
function makeProject(deps: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lic-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "  BUN_VERSION: 1.3.14\n");
  writeFileSync(join(dir, ".github", "workflows", "release.yml"), "  BUN_VERSION: 1.3.14\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", dependencies: deps }));
  return dir;
}

function addPackage(dir: string, folder: string, manifest: Record<string, unknown>): void {
  const pdir = join(dir, "node_modules", folder);
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(pdir, "LICENSE"), `${String(manifest.license ?? "license")} text`);
}

describe("licenseOf", () => {
  test("reads a plain SPDX string", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
  });

  test("reads the deprecated { type } object form", () => {
    expect(licenseOf({ license: { type: "BSD-3-Clause" } })).toBe("BSD-3-Clause");
  });

  test("joins the deprecated licenses[] array as an OR expression", () => {
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("MIT OR Apache-2.0");
  });

  test("returns UNKNOWN when no license field is present", () => {
    expect(licenseOf({ name: "x" })).toBe("UNKNOWN");
  });

  test("returns UNKNOWN for an empty object license", () => {
    expect(licenseOf({ license: {} })).toBe("UNKNOWN");
  });

  test("returns UNKNOWN for an empty licenses[] array", () => {
    expect(licenseOf({ licenses: [] })).toBe("UNKNOWN");
  });

  test("drops licenses[] entries that lack a type", () => {
    expect(licenseOf({ licenses: [{}, { type: "MIT" }] })).toBe("MIT");
  });
});

describe("isAllowed", () => {
  test("accepts allowlisted licenses regardless of case", () => {
    expect(isAllowed("MIT")).toBe(true);
    expect(isAllowed("apache-2.0")).toBe(true);
    expect(isAllowed("BlueOak-1.0.0")).toBe(true);
  });

  test("rejects copyleft licenses", () => {
    expect(isAllowed("GPL-3.0-only")).toBe(false);
    expect(isAllowed("LGPL-2.1")).toBe(false);
    expect(isAllowed("MPL-2.0")).toBe(false);
  });

  test("OR passes when any operand is allowed", () => {
    expect(isAllowed("(GPL-2.0-only OR MIT)")).toBe(true);
    expect(isAllowed("GPL-2.0-only OR LGPL-3.0")).toBe(false);
  });

  test("AND passes only when every operand is allowed", () => {
    expect(isAllowed("MIT AND Apache-2.0")).toBe(true);
    expect(isAllowed("MIT AND GPL-3.0-only")).toBe(false);
  });

  test("strips parentheses and a trailing + from the version", () => {
    expect(isAllowed("(MIT)")).toBe(true);
    expect(isAllowed("Apache-2.0+")).toBe(true);
  });

  test("rejects unknown, unlicensed, and non-SPDX strings", () => {
    expect(isAllowed("UNKNOWN")).toBe(false);
    expect(isAllowed("UNLICENSED")).toBe(false);
    expect(isAllowed("SEE LICENSE IN COPYING")).toBe(false);
    expect(isAllowed("")).toBe(false);
  });
});

describe("isPackageRoot", () => {
  test("accepts an unscoped package manifest", () => {
    expect(isPackageRoot("node_modules/commander/package.json")).toBe(true);
  });

  test("accepts a scoped package manifest", () => {
    expect(isPackageRoot("node_modules/@eslint/js/package.json")).toBe(true);
  });

  test("accepts a nested (non-hoisted) dependency manifest", () => {
    expect(isPackageRoot("node_modules/a/node_modules/b/package.json")).toBe(true);
  });

  test("rejects a sub-manifest inside a package", () => {
    expect(isPackageRoot("node_modules/foo/dist/package.json")).toBe(false);
  });
});

describe("parseBunVersion", () => {
  test("returns the version when ci.yml and release.yml agree", () => {
    expect(parseBunVersion("BUN_VERSION: 1.3.14", "env:\n  BUN_VERSION: 1.3.14")).toBe("1.3.14");
  });

  test("throws when the two workflows disagree", () => {
    expect(() => parseBunVersion("BUN_VERSION: 1.3.14", "BUN_VERSION: 1.2.0")).toThrow(/mismatch/);
  });

  test("throws when a version is missing", () => {
    expect(() => parseBunVersion("BUN_VERSION: 1.3.14", "nothing here")).toThrow();
  });
});

describe("licenseText", () => {
  test("throws when a directory has no license file", () => {
    expect(() => licenseText(resolve(import.meta.dir, "does-not-exist"))).toThrow();
  });

  test("skips an empty file and falls back to the next candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "lictext-"));
    writeFileSync(join(dir, "LICENSE"), "   \n");
    writeFileSync(join(dir, "LICENSE.md"), "real license body");
    expect(licenseText(dir)).toBe("real license body");
  });

  test("reads an alternative license filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "lictext-"));
    writeFileSync(join(dir, "COPYING"), "copying terms");
    expect(licenseText(dir)).toBe("copying terms");
  });
});

describe("run (CLI dispatch)", () => {
  test("audit exits 0 on the current tree", () => {
    expect(runCli(["audit"])).toBe(0);
  });

  test("--check exits 0 when NOTICES is current", () => {
    expect(runCli(["--check"])).toBe(0);
  });

  test("an unknown mode exits 2", () => {
    expect(runCli(["bogus"])).toBe(2);
  });

  test("defaults to audit when no mode is given", () => {
    expect(runCli([])).toBe(0);
  });
});

describe("audit over a fixture tree", () => {
  test("passes when every installed package is permissive", () => {
    const dir = makeProject();
    addPackage(dir, "ok-dep", { name: "ok-dep", version: "1.0.0", license: "MIT" });
    expect(runCli(["audit"], dir)).toBe(0);
  });

  test("fails on a copyleft dependency", () => {
    const dir = makeProject();
    addPackage(dir, "bad-dep", { name: "bad-dep", version: "1.0.0", license: "GPL-3.0-only" });
    expect(runCli(["audit"], dir)).toBe(1);
  });

  test("still flags a package with no name field", () => {
    const dir = makeProject();
    // A nameless manifest must not be skipped, or its license escapes the audit.
    addPackage(dir, "anon", { version: "1.0.0", license: "GPL-3.0-only" });
    expect(runCli(["audit"], dir)).toBe(1);
  });

  test("aborts on a corrupt manifest rather than skipping it", () => {
    const dir = makeProject();
    mkdirSync(join(dir, "node_modules", "corrupt"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "corrupt", "package.json"), "{ not json");
    expect(runCli(["audit"], dir)).not.toBe(0);
  });

  test("scans same-named packages in different paths independently", () => {
    const dir = makeProject();
    // A permissive copy at the top level must not mask a copyleft copy nested
    // deeper - dir-keying keeps both, so the GPL one is still flagged.
    addPackage(dir, "dup", { name: "dup", version: "1.0.0", license: "MIT" });
    addPackage(dir, "host/node_modules/dup", { name: "dup", version: "1.0.0", license: "GPL-3.0-only" });
    expect(runCli(["audit"], dir)).toBe(1);
  });

  test("fails when a declared dependency is not installed", () => {
    const dir = makeProject({ ghost: "1.0.0" });
    expect(runCli(["notices"], dir)).not.toBe(0);
  });

  test("names the parent when a transitive dependency is missing", () => {
    const dir = makeProject({ parent: "1.0.0" });
    // parent is installed but declares an uninstalled transitive dep.
    addPackage(dir, "parent", { name: "parent", version: "1.0.0", license: "MIT", dependencies: { kid: "1.0.0" } });
    const err = runCliStderr(["notices"], dir);
    expect(err).toContain("kid");
    expect(err).toContain("required by parent");
  });

  test("notices round-trips and --check detects drift", () => {
    const dir = makeProject({ "ok-dep": "1.0.0" });
    addPackage(dir, "ok-dep", { name: "ok-dep", version: "1.0.0", license: "MIT" });
    expect(runCli(["notices"], dir)).toBe(0);
    expect(runCli(["--check"], dir)).toBe(0);
    writeFileSync(join(dir, "NOTICES"), "stale\n");
    expect(runCli(["--check"], dir)).toBe(1);
  });
});
