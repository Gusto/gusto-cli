import { describe, expect, test } from "bun:test";
import type { ReleaseManifest, ReleaseObservation } from "../scripts/release-manifest.ts";
import {
  classifyPublicationState,
  selectUniqueRelease,
  verifyCandidateArtifactMetadata,
} from "../scripts/release-manifest.ts";

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

const ARTIFACT_IDENTITY = {
  version: "1.2.3",
  commitSha: SHA,
  candidateRunId: "12345",
  artifactId: "67890",
  artifactDigest: "b".repeat(64),
  runSha: "c".repeat(40),
};

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 67890,
    name: `release-candidate-1.2.3-${SHA}`,
    expired: false,
    created_at: "2026-08-25T12:00:00Z",
    expires_at: "2026-09-01T12:00:00Z",
    digest: `sha256:${"b".repeat(64)}`,
    workflow_run: {
      id: 12345,
      head_sha: "c".repeat(40),
    },
    ...overrides,
  };
}

function metadata(
  listArtifact: Record<string, unknown> = artifact(),
  detailArtifact: Record<string, unknown> = artifact(),
) {
  return verifyCandidateArtifactMetadata(
    { total_count: 1, artifacts: [listArtifact] },
    detailArtifact,
    ARTIFACT_IDENTITY,
    new Date("2026-08-27T12:00:00Z"),
  );
}

function release(overrides: Partial<NonNullable<ReleaseObservation["release"]>> = {}) {
  return {
    tagName: "v1.2.3",
    targetCommitish: SHA,
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
    expect(classify({ tagTargetSha: null, tagObjectType: null, release: null })).toEqual({ kind: "clear" });
  });

  test("classifies an exact target tag without a Release as tag-only", () => {
    expect(classify({ tagTargetSha: SHA, tagObjectType: "commit", release: null })).toEqual({ kind: "tag-only" });
  });

  test("classifies a Release without a resolvable tag as release-only", () => {
    expect(classify({ tagTargetSha: null, tagObjectType: null, release: release() })).toEqual({
      kind: "release-only",
    });
  });

  test("classifies an exact empty draft as resumable with every sealed asset missing", () => {
    expect(
      classify({
        tagTargetSha: null,
        tagObjectType: null,
        release: release({ draft: true, assets: [] }),
      }),
    ).toEqual({
      kind: "draft-incomplete",
      missingAssets: ["SHA256SUMS", "gusto-darwin-arm64", "gusto-darwin-x64", "gusto-linux-x64"],
    });
  });

  test("classifies an exact partial draft as resumable without replacing uploaded bytes", () => {
    expect(
      classify({
        tagTargetSha: null,
        tagObjectType: null,
        release: release({ draft: true, assets: PUBLIC_ASSETS.slice(0, 2) }),
      }),
    ).toEqual({
      kind: "draft-incomplete",
      missingAssets: ["gusto-darwin-arm64", "gusto-darwin-x64"],
    });
  });

  test("classifies a complete exact draft as ready to publish", () => {
    expect(classify({ tagTargetSha: null, tagObjectType: null, release: release({ draft: true }) })).toEqual({
      kind: "draft-ready",
    });
  });

  test.each([
    ["wrong target", { targetCommitish: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    ["wrong body", { body: NOTES.trimEnd() }],
    ["unexpected asset", { assets: [...PUBLIC_ASSETS, { name: "extra", size: 1, sha256: "0".repeat(64) }] }],
    ["wrong existing bytes", { assets: [{ ...PUBLIC_ASSETS[0], sha256: "0".repeat(64) }] }],
  ])("rejects a draft with %s", (_label, override) => {
    expect(
      classify({ tagTargetSha: null, tagObjectType: null, release: release({ draft: true, ...override }) }),
    ).toEqual({ kind: "mismatch", reason: expect.any(String) });
  });

  test("treats an exact existing publication as an idempotent retry regardless of asset order", () => {
    expect(classify({ tagTargetSha: SHA, tagObjectType: "commit", release: release() })).toEqual({
      kind: "already-published",
    });
  });

  test("rejects an annotated tag even when it resolves to the exact source commit", () => {
    expect(classify({ tagTargetSha: SHA, tagObjectType: "tag", release: release() })).toEqual({
      kind: "mismatch",
      reason: "tag",
    });
  });

  test("rejects a tag whose resolved commit target differs", () => {
    expect(
      classify({
        tagTargetSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tagObjectType: "commit",
        release: release(),
      }),
    ).toEqual({ kind: "mismatch", reason: "target" });
  });

  test("rejects any Release body byte mismatch", () => {
    expect(
      classify({ tagTargetSha: SHA, tagObjectType: "commit", release: release({ body: NOTES.trimEnd() }) }),
    ).toEqual({
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
    expect(classify({ tagTargetSha: SHA, tagObjectType: "commit", release: release({ assets }) })).toEqual({
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
    expect(classify({ tagTargetSha: SHA, tagObjectType: "commit", release: release(override) })).toEqual({
      kind: "mismatch",
      reason: "release",
    });
  });
});

describe("candidate artifact metadata", () => {
  test("accepts matching list/detail metadata with an unexpired exact seven-day lifetime", () => {
    expect(metadata()).toEqual({
      id: "67890",
      name: `release-candidate-1.2.3-${SHA}`,
      digest: `sha256:${"b".repeat(64)}`,
      candidateRunId: "12345",
      runSha: "c".repeat(40),
      createdAt: "2026-08-25T12:00:00Z",
      expiresAt: "2026-09-01T12:00:00Z",
    });
  });

  test.each([
    ["missing creation time", { created_at: null }, /created_at/],
    ["malformed creation time", { created_at: "2026-02-30T12:00:00Z" }, /created_at/],
    ["non-UTC expiry", { expires_at: "2026-09-01T12:00:00+01:00" }, /expires_at/],
    ["past expiry", { expires_at: "2026-08-27T12:00:00Z" }, /expired/],
    ["future creation", { created_at: "2026-08-28T12:00:00Z" }, /future/],
    ["nonpositive lifetime", { expires_at: "2026-08-25T12:00:00Z" }, /after.*created/i],
    ["long lifetime", { expires_at: "2026-09-01T12:00:01Z" }, /seven days/],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => metadata(artifact(overrides), artifact(overrides))).toThrow(message);
  });

  test("rejects list/detail timestamp disagreement", () => {
    expect(() => metadata(artifact(), artifact({ expires_at: "2026-09-01T11:59:59Z" }))).toThrow(
      /list and detail metadata disagree/,
    );
  });

  test("requires the list response to contain the sole exact artifact", () => {
    expect(() =>
      verifyCandidateArtifactMetadata(
        { total_count: 2, artifacts: [artifact()] },
        artifact(),
        ARTIFACT_IDENTITY,
        new Date("2026-08-27T12:00:00Z"),
      ),
    ).toThrow(/sole artifact/);
  });
});

describe("draft Release discovery", () => {
  const draft = { id: 41, tag_name: "v1.2.3", draft: true };
  const published = { id: 42, tag_name: "v1.2.3", draft: false };

  test("finds a draft in the authenticated releases listing when the published tag endpoint is absent", () => {
    expect(selectUniqueRelease([[draft], []], null, "v1.2.3")).toEqual({ releaseId: "41", published: false });
  });

  test("requires the published tag endpoint and releases listing to identify the same unique Release", () => {
    expect(selectUniqueRelease([[published], []], published, "v1.2.3")).toEqual({
      releaseId: "42",
      published: true,
    });
  });

  test("rejects published endpoint and listing disagreement about draft state", () => {
    expect(() => selectUniqueRelease([[{ ...published, draft: true }], []], published, "v1.2.3")).toThrow(/disagrees/i);
  });

  test("fails closed when duplicate drafts use the same tag", () => {
    expect(() => selectUniqueRelease([[draft, { ...draft, id: 43 }], []], null, "v1.2.3")).toThrow(
      /multiple Releases/i,
    );
  });

  test("fails closed when the bounded listing cannot prove uniqueness", () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      tag_name: `v0.0.${index + 1}`,
      draft: true,
    }));
    expect(() => selectUniqueRelease([fullPage, fullPage, fullPage], null, "v1.2.3")).toThrow(/bounded/i);
  });
});
