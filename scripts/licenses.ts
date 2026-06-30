#!/usr/bin/env bun
// Audit dependency licenses and keep NOTICES current.
//
//   bun run scripts/licenses.ts audit     # fail on any non-allowlisted license
//   bun run scripts/licenses.ts notices   # regenerate the NOTICES file
//   bun run scripts/licenses.ts --check   # audit + verify NOTICES has no drift
//
// The audit walks the whole installed tree (prod + dev) so a copyleft dep can't
// slip in via tooling. NOTICES only documents what actually ships in the
// compiled binary: the npm runtime deps plus the bundled Bun runtime.

import { Glob } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// SPDX ids permissive enough to redistribute under Apache-2.0. Compared
// case-insensitively. Anything outside this set fails the audit for a human to
// review (a real copyleft dep, or a license string we don't recognize yet).
const ALLOWED = new Set(
  ["0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MIT", "Unlicense"].map(
    (id) => id.toLowerCase(),
  ),
);

const NOTICES_PATH = "NOTICES";
const BUN_LICENSE_URL = (version: string) => `https://github.com/oven-sh/bun/blob/bun-v${version}/LICENSE.md`;

export interface Pkg {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }>;
  dependencies?: Record<string, string>;
}

export function licenseOf(pkg: Pkg): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
    return pkg.license.type;
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => l.type).filter((t): t is string => !!t);
    if (types.length) return types.join(" OR ");
  }
  return "UNKNOWN";
}

// Evaluate an SPDX expression against the allowlist. Handles flat OR/AND and
// parentheses: an OR passes if any operand passes, an AND only if all do.
export function isAllowed(expr: string): boolean {
  const cleaned = expr.replace(/[()]/g, " ").trim();
  if (!cleaned || /^(unknown|unlicensed|see\s+license)/i.test(cleaned)) {
    return false;
  }
  return cleaned
    .split(/\s+OR\s+/i)
    .some((group) => group.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim().replace(/\+$/, "").toLowerCase())));
}

// True only for a package's own manifest: an immediate child of node_modules
// (or node_modules/@scope). Excludes sub-manifests like dist/package.json.
export function isPackageRoot(rel: string): boolean {
  const seg = rel.split("/");
  const parent = seg[seg.length - 3];
  if (parent === "node_modules") return true;
  if (parent?.startsWith("@") && seg[seg.length - 4] === "node_modules") return true;
  return false;
}

interface Found {
  id: string;
  version: string;
  license: string;
  dir: string;
}

// Read a file, failing with the offending path instead of a bare IO error.
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Failed to read ${path}`, { cause: e });
  }
}

function writeText(path: string, content: string): void {
  try {
    writeFileSync(path, content);
  } catch (e) {
    throw new Error(`Failed to write ${path}`, { cause: e });
  }
}

// Parse a package.json, failing with the offending path. A corrupt manifest
// aborts the audit rather than being skipped: silently dropping a package could
// let an unvetted license through, which is exactly what this guards against.
function readManifest(path: string): Pkg {
  try {
    return JSON.parse(readText(path)) as Pkg;
  } catch (e) {
    throw new Error(`Failed to parse ${path}`, { cause: e });
  }
}

function toFound(pkg: Pkg, dir: string): Found {
  return { id: pkg.name ?? dir, version: pkg.version ?? "", license: licenseOf(pkg), dir };
}

function scanInstalled(): Found[] {
  const found = new Map<string, Found>();
  for (const rel of new Glob("node_modules/**/package.json").scanSync(".")) {
    if (!isPackageRoot(rel)) continue;
    const dir = dirname(rel);
    // Key by install directory, which is unique per package. Keying by name (or
    // dropping nameless packages) would let two packages collide and silently
    // remove one from the audit - a license could escape that way.
    found.set(dir, toFound(readManifest(rel), dir));
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function audit(): number {
  const installed = scanInstalled();
  const violations = installed.filter((p) => !isAllowed(p.license));

  const tally = new Map<string, number>();
  for (const p of installed) tally.set(p.license, (tally.get(p.license) ?? 0) + 1);
  console.log(`Scanned ${installed.length} installed packages:`);
  for (const [lic, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${lic}`);
  }

  if (violations.length === 0) {
    console.log("\nAll licenses are on the allowlist.");
    return 0;
  }
  console.error(`\n${violations.length} package(s) with a non-allowlisted license:`);
  for (const v of violations) {
    console.error(`  ${v.id}@${v.version}  ${v.license}  (${v.dir})`);
  }
  console.error(
    "\nReview the license, then either add it to the allowlist in scripts/licenses.ts\n" +
      "or remove/replace the dependency.",
  );
  return 1;
}

// Production-dependency closure: what `bun build --compile` actually bundles.
function bundledDeps(): Found[] {
  const root = readManifest("package.json");
  const seen = new Map<string, Found>();
  const queue = Object.keys(root.dependencies ?? {});
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const dir = join("node_modules", name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) {
      throw new Error(`Bundled dependency not installed: ${name}`);
    }
    const pkg = readManifest(manifest);
    seen.set(name, toFound(pkg, dir));
    queue.push(...Object.keys(pkg.dependencies ?? {}));
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function licenseText(dir: string): string {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const text = readText(p).trim();
    // An empty/whitespace-only file would silently produce a blank notice, so
    // keep looking and fail loudly if no candidate has real content.
    if (text) return text;
  }
  throw new Error(`No non-empty license file found in ${dir}`);
}

// release.yml builds the shipped binary, so its Bun version is what NOTICES must
// document; ci.yml must agree or the audited and released runtimes differ.
export function parseBunVersion(ciYml: string, releaseYml: string): string {
  const re = /BUN_VERSION:\s*([0-9]+\.[0-9]+\.[0-9]+)/;
  const ci = ciYml.match(re)?.[1];
  const release = releaseYml.match(re)?.[1];
  if (!ci || !release) {
    throw new Error("Could not read BUN_VERSION from the workflow files.");
  }
  if (ci !== release) {
    throw new Error(`BUN_VERSION mismatch: ci.yml has ${ci}, release.yml has ${release}.`);
  }
  return ci;
}

function bunVersion(): string {
  return parseBunVersion(readText(".github/workflows/ci.yml"), readText(".github/workflows/release.yml"));
}

function renderNotices(): string {
  const version = bunVersion();
  const sep = "-".repeat(79);
  const parts: string[] = [
    "gusto-cli - Third-Party Notices",
    "===============================",
    "",
    "The gusto-cli binary is distributed under the Apache License 2.0 (see LICENSE).",
    "It is built with `bun build --compile`, which bundles the Bun runtime and the",
    "npm runtime dependencies below into a single executable. This file lists the",
    "third-party components distributed in that binary and their licenses.",
    "",
    "Development-only dependencies (linter, type checker, test tooling) are not",
    "distributed and are not listed here.",
    "",
    "This file is generated. Run `bun run license:notices` to regenerate it and",
    "`bun run license:check` to verify it is current.",
    "",
    "",
    sep,
    "npm runtime dependencies",
    sep,
    "",
  ];

  for (const dep of bundledDeps()) {
    parts.push(`### ${dep.id} ${dep.version} - ${dep.license}`, "", licenseText(dep.dir), "", "");
  }

  parts.push(
    sep,
    "Bun runtime (bundled via `bun build --compile`)",
    sep,
    "",
    `The compiled binary embeds the Bun runtime, version ${version}. Bun itself is`,
    "MIT-licensed and statically links a number of third-party libraries, including",
    "some under the GNU LGPL v2.1 (JavaScriptCore and TinyCC). These libraries are",
    "included unmodified as part of the standard Bun runtime.",
    "",
    "For components offered under a choice of a permissive or a copyleft license, the",
    "permissive option is elected (Zstandard under BSD; picohttpparser under MIT).",
    "",
    "The full list of Bun's bundled components and their license texts is published",
    "with the runtime at:",
    "",
    `  ${BUN_LICENSE_URL(version)}`,
    "",
    "LGPL-2.1 compliance: gusto-cli's own source is publicly available under the",
    "Apache License 2.0 (this repository), the Bun runtime is bundled unmodified, and",
    "the source for the LGPL-licensed components is published by the Bun project and",
    "its upstreams. Together these let a recipient obtain, modify, and rebuild the",
    "LGPL-covered components, as LGPL-2.1 requires.",
    "",
  );

  return parts.join("\n");
}

function writeNotices(): number {
  writeText(NOTICES_PATH, renderNotices());
  console.log(`Wrote ${NOTICES_PATH}.`);
  return 0;
}

function checkNotices(): number {
  const expected = renderNotices();
  const actual = existsSync(NOTICES_PATH) ? readText(NOTICES_PATH) : "";
  if (actual === expected) {
    console.log("NOTICES is up to date.");
    return 0;
  }
  console.error("NOTICES is out of date. Run `bun run license:notices` and commit the result.");
  return 1;
}

function run(mode: string): number {
  switch (mode) {
    case "audit":
      return audit();
    case "notices":
      return writeNotices();
    case "--check": {
      // Run both so a failing audit doesn't hide NOTICES drift (and vice versa).
      const audited = audit();
      const noticed = checkNotices();
      return audited || noticed;
    }
    default:
      console.error(`Unknown mode: ${mode}. Use audit | notices | --check.`);
      return 2;
  }
}

// Only run the CLI when executed directly, so tests can import the helpers.
if (import.meta.main) {
  process.exit(run(process.argv[2] ?? "audit"));
}
