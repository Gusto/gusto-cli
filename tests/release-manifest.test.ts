import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReleaseManifest, verifyReleaseManifest } from "../scripts/release-manifest.ts";

const VERSION = "1.2.3";
const COMMIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOTES_SHA256 = "cad65eaf35378a2f44b112e194ccf0fb36cf80a3110eaab28d43d41075d85f99";
const MANIFEST_SHA256 = "53ed2d5652d071d8761d4c003611d96223dffc74fce3915010e9d0322613aaed";
const CHECKSUMS =
  "e6434014e9900ac13eb58b5d1ef5bc887bd66d2a272ae40984fe75869fa871f1  gusto-darwin-arm64\n" +
  "7e9b3b91360014f96508eb6ce2b805ee79d78875ac1f234f5713dbfb54ce1b67  gusto-darwin-x64\n" +
  "01d1d5273ee989b05c546bd8d8afe5643d20c6bd24ec672cd385a767e5f0d857  gusto-linux-x64\n";
const NOTES = "## [1.2.3](https://github.com/Gusto/gusto-cli/compare/v1.2.2...v1.2.3)\n\n- Fix output.\n";
const EXPECTED_MANIFEST = `{
  "schemaVersion": 1,
  "version": "1.2.3",
  "commitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "releaseNotesSha256": "cad65eaf35378a2f44b112e194ccf0fb36cf80a3110eaab28d43d41075d85f99",
  "assets": {
    "SHA256SUMS": {
      "sha256": "785b56cbba4e52699a003e6283988679dbef6020116fa24798ced411f5d5713d",
      "size": 250
    },
    "gusto-darwin-arm64": {
      "sha256": "e6434014e9900ac13eb58b5d1ef5bc887bd66d2a272ae40984fe75869fa871f1",
      "size": 13
    },
    "gusto-darwin-x64": {
      "sha256": "7e9b3b91360014f96508eb6ce2b805ee79d78875ac1f234f5713dbfb54ce1b67",
      "size": 11
    },
    "gusto-linux-x64": {
      "sha256": "01d1d5273ee989b05c546bd8d8afe5643d20c6bd24ec672cd385a767e5f0d857",
      "size": 10
    },
    "release-notes.md": {
      "sha256": "cad65eaf35378a2f44b112e194ccf0fb36cf80a3110eaab28d43d41075d85f99",
      "size": 86
    }
  }
}
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { artifact: string; root: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "release-manifest-")));
  roots.push(root);
  const artifact = path.join(root, "artifact");
  mkdirSync(artifact);
  writeFileSync(path.join(artifact, "gusto-darwin-arm64"), "darwin arm64\n");
  writeFileSync(path.join(artifact, "gusto-darwin-x64"), "darwin x64\n");
  writeFileSync(path.join(artifact, "gusto-linux-x64"), "linux x64\n");
  writeFileSync(path.join(artifact, "SHA256SUMS"), CHECKSUMS);
  writeFileSync(path.join(artifact, "release-notes.md"), NOTES);
  return { artifact, root };
}

function identity() {
  return { version: VERSION, commitSha: COMMIT_SHA, releaseNotesSha256: NOTES_SHA256 };
}

function createFixtureManifest(artifact: string): void {
  createReleaseManifest(artifact, identity());
}

function readManifest(artifact: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(artifact, "release-manifest.json"), "utf8")) as Record<string, unknown>;
}

function writeCanonicalManifest(artifact: string, manifest: Record<string, unknown>): void {
  writeFileSync(path.join(artifact, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("release manifest", () => {
  test("creates deterministic schema-1 bytes from literal payload hashes and verifies them", () => {
    const first = fixture().artifact;
    const second = fixture().artifact;

    const created = createReleaseManifest(first, identity());
    createReleaseManifest(second, identity());

    expect(readFileSync(path.join(first, "release-manifest.json"), "utf8")).toBe(EXPECTED_MANIFEST);
    expect(readFileSync(path.join(second, "release-manifest.json"), "utf8")).toBe(EXPECTED_MANIFEST);
    expect(created.releaseManifestSha256).toBe(MANIFEST_SHA256);
    expect(verifyReleaseManifest(first, identity())).toEqual(created);
  });

  test("rejects an unexpected artifact file", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    writeFileSync(path.join(artifact, "extra.txt"), "unexpected\n");

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/exact filenames/);
  });

  test("rejects a missing artifact file", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    unlinkSync(path.join(artifact, "gusto-linux-x64"));

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/exact filenames/);
  });

  test("rejects a symlinked payload even when it resolves to matching bytes outside the artifact", () => {
    const { artifact, root } = fixture();
    createFixtureManifest(artifact);
    const outside = path.join(root, "outside-binary");
    writeFileSync(outside, "linux x64\n");
    unlinkSync(path.join(artifact, "gusto-linux-x64"));
    symlinkSync(outside, path.join(artifact, "gusto-linux-x64"));

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/regular file/);
  });

  test("rejects an artifact directory reached through a symlink", () => {
    const { artifact, root } = fixture();
    createFixtureManifest(artifact);
    const linked = path.join(root, "linked-artifact");
    symlinkSync(artifact, linked);

    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(() => verifyReleaseManifest(linked, identity())).toThrow(/directory.*symlink/i);
  });

  test("rejects an artifact directory beneath a symlinked parent", () => {
    const { artifact, root } = fixture();
    createFixtureManifest(artifact);
    const linkedParent = path.join(root, "linked-parent");
    symlinkSync(root, linkedParent);
    const linkedArtifact = path.join(linkedParent, "artifact");

    expect(lstatSync(linkedArtifact).isSymbolicLink()).toBe(false);
    expect(() => verifyReleaseManifest(linkedArtifact, identity())).toThrow(/directory.*symlink/i);
  });

  test("rejects a path-escaping manifest asset key", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    const manifest = readManifest(artifact);
    const assets = manifest.assets as Record<string, unknown>;
    assets["../release-notes.md"] = assets["release-notes.md"];
    delete assets["release-notes.md"];
    writeCanonicalManifest(artifact, manifest);

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/asset filenames/);
  });

  test("rejects payload bytes whose direct hash no longer matches", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    writeFileSync(path.join(artifact, "gusto-linux-x64"), "Linux x64\n");

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/hash/);
  });

  test("rejects checksum entries that disagree even when SHA256SUMS itself matches its manifest hash", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    const alteredChecksums =
      "0000000000000000000000000000000000000000000000000000000000000000  gusto-darwin-arm64\n" +
      "7e9b3b91360014f96508eb6ce2b805ee79d78875ac1f234f5713dbfb54ce1b67  gusto-darwin-x64\n" +
      "01d1d5273ee989b05c546bd8d8afe5643d20c6bd24ec672cd385a767e5f0d857  gusto-linux-x64\n";
    writeFileSync(path.join(artifact, "SHA256SUMS"), alteredChecksums);
    const manifest = readManifest(artifact);
    const assets = manifest.assets as Record<string, { sha256: string; size: number }>;
    assets.SHA256SUMS = {
      sha256: "42f42a5d544cc08f4d4f35bdfd51ea55691e3b65f99ff2e7ff73c9c5f8a2cbfd",
      size: 250,
    };
    writeCanonicalManifest(artifact, manifest);

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/checksum.*gusto-darwin-arm64/i);
  });

  test("rejects an incorrect manifest size independently of the hash", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    const manifest = readManifest(artifact);
    const assets = manifest.assets as Record<string, { sha256: string; size: number }>;
    assets["gusto-linux-x64"]!.size = 11;
    writeCanonicalManifest(artifact, manifest);

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/size/);
  });

  test("rejects mismatched sealed version, source SHA, and release-notes hash", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);

    expect(() => verifyReleaseManifest(artifact, { ...identity(), version: "1.2.4" })).toThrow(/version/);
    expect(() =>
      verifyReleaseManifest(artifact, { ...identity(), commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    ).toThrow(/commit SHA/);
    expect(() =>
      verifyReleaseManifest(artifact, {
        ...identity(),
        releaseNotesSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }),
    ).toThrow(/release-notes hash/);
  });

  test("rejects semantically equivalent manifest JSON with non-canonical bytes", () => {
    const { artifact } = fixture();
    createFixtureManifest(artifact);
    const file = path.join(artifact, "release-manifest.json");
    writeFileSync(file, readFileSync(file, "utf8").trimEnd());

    expect(() => verifyReleaseManifest(artifact, identity())).toThrow(/canonical/);
  });
});
