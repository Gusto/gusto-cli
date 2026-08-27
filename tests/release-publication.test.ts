import { describe, expect, test } from "bun:test";
import type { ReleaseManifest, ReleaseObservation } from "../scripts/release-manifest.ts";
import { classifyPublicationState } from "../scripts/release-manifest.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOTES = "## [1.2.3](https://github.com/Gusto/gusto-cli/compare/v1.2.2...v1.2.3)\n\n- Fix output.\n";
const MANIFEST: ReleaseManifest = {
  schemaVersion: 1,
  version: "1.2.3",
  commitSha: SHA,
  releaseNotesSha256: "cad65eaf35378a2f44b112e194ccf0fb36cf80a3110eaab28d43d41075d85f99",
  assets: {
    SHA256SUMS: { sha256: "785b56cbba4e52699a003e6283988679dbef6020116fa24798ced411f5d5713d", size: 250 },
    "gusto-darwin-arm64": {
      sha256: "e6434014e9900ac13eb58b5d1ef5bc887bd66d2a272ae40984fe75869fa871f1",
      size: 13,
    },
    "gusto-darwin-x64": {
      sha256: "7e9b3b91360014f96508eb6ce2b805ee79d78875ac1f234f5713dbfb54ce1b67",
      size: 11,
    },
    "gusto-linux-x64": {
      sha256: "01d1d5273ee989b05c546bd8d8afe5643d20c6bd24ec672cd385a767e5f0d857",
      size: 10,
    },
    "release-notes.md": {
      sha256: "cad65eaf35378a2f44b112e194ccf0fb36cf80a3110eaab28d43d41075d85f99",
      size: 86,
    },
  },
};

const PUBLIC_ASSETS = [
  {
    name: "gusto-linux-x64",
    size: 10,
    sha256: "01d1d5273ee989b05c546bd8d8afe5643d20c6bd24ec672cd385a767e5f0d857",
  },
  {
    name: "SHA256SUMS",
    size: 250,
    sha256: "785b56cbba4e52699a003e6283988679dbef6020116fa24798ced411f5d5713d",
  },
  {
    name: "gusto-darwin-x64",
    size: 11,
    sha256: "7e9b3b91360014f96508eb6ce2b805ee79d78875ac1f234f5713dbfb54ce1b67",
  },
  {
    name: "gusto-darwin-arm64",
    size: 13,
    sha256: "e6434014e9900ac13eb58b5d1ef5bc887bd66d2a272ae40984fe75869fa871f1",
  },
];

function release(overrides: Partial<NonNullable<ReleaseObservation["release"]>> = {}) {
  return {
    tagName: "v1.2.3",
    name: "v1.2.3",
    body: NOTES,
    draft: false,
    prerelease: false,
    assets: PUBLIC_ASSETS,
    ...overrides,
  };
}

function classify(observation: ReleaseObservation) {
  return classifyPublicationState(MANIFEST, NOTES, observation);
}

describe("publication state", () => {
  test("classifies absence of both tag and Release as clear", () => {
    expect(classify({ tagTargetSha: null, release: null })).toEqual({ kind: "clear" });
  });

  test("classifies an exact target tag without a Release as tag-only", () => {
    expect(classify({ tagTargetSha: SHA, release: null })).toEqual({ kind: "tag-only" });
  });

  test("classifies a Release without a resolvable tag as release-only", () => {
    expect(classify({ tagTargetSha: null, release: release() })).toEqual({ kind: "release-only" });
  });

  test("treats an exact existing publication as an idempotent retry regardless of asset order", () => {
    expect(classify({ tagTargetSha: SHA, release: release() })).toEqual({ kind: "already-published" });
  });

  test("rejects a tag whose resolved commit target differs", () => {
    expect(
      classify({
        tagTargetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        release: release(),
      }),
    ).toEqual({ kind: "mismatch", reason: "target" });
  });

  test("rejects any Release body byte mismatch", () => {
    expect(classify({ tagTargetSha: SHA, release: release({ body: NOTES.trimEnd() }) })).toEqual({
      kind: "mismatch",
      reason: "body",
    });
  });

  test.each([
    ["missing", PUBLIC_ASSETS.slice(1)],
    [
      "unexpected",
      [
        ...PUBLIC_ASSETS,
        {
          name: "release-notes.md",
          size: 86,
          sha256: "cad65eaf35378a2f44b112e194ccf0fb36cf80a3110eaab28d43d41075d85f99",
        },
      ],
    ],
    ["wrong hash", PUBLIC_ASSETS.map((asset, index) => (index === 0 ? { ...asset, sha256: "0".repeat(64) } : asset))],
    ["wrong size", PUBLIC_ASSETS.map((asset, index) => (index === 0 ? { ...asset, size: asset.size + 1 } : asset))],
  ])("rejects %s existing Release assets", (_label, assets) => {
    expect(classify({ tagTargetSha: SHA, release: release({ assets }) })).toEqual({
      kind: "mismatch",
      reason: "assets",
    });
  });

  test.each([
    ["tag name", { tagName: "v1.2.4" }],
    ["title", { name: "Release 1.2.3" }],
    ["draft state", { draft: true }],
    ["prerelease state", { prerelease: true }],
  ])("rejects mismatched Release %s", (_label, override) => {
    expect(classify({ tagTargetSha: SHA, release: release(override) })).toEqual({
      kind: "mismatch",
      reason: "release",
    });
  });
});
