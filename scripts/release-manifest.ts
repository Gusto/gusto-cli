import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const PAYLOAD_NAMES = [
  "SHA256SUMS",
  "gusto-darwin-arm64",
  "gusto-darwin-x64",
  "gusto-linux-x64",
  "release-notes.md",
] as const;
const BINARY_NAMES = ["gusto-darwin-arm64", "gusto-darwin-x64", "gusto-linux-x64"] as const;
const PUBLIC_ASSET_NAMES = ["SHA256SUMS", "gusto-darwin-arm64", "gusto-darwin-x64", "gusto-linux-x64"] as const;
const MANIFEST_NAME = "release-manifest.json";
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const decoder = new TextDecoder("utf-8", { fatal: true });

type PayloadName = (typeof PAYLOAD_NAMES)[number];
type PublicAssetName = (typeof PUBLIC_ASSET_NAMES)[number];

export interface ReleaseIdentity {
  version: string;
  commitSha: string;
  releaseNotesSha256: string;
}

export interface ReleaseAssetRecord {
  sha256: string;
  size: number;
}

export interface ReleaseManifest extends ReleaseIdentity {
  schemaVersion: 1;
  assets: Record<PayloadName, ReleaseAssetRecord>;
}

export interface ManifestVerification {
  manifest: ReleaseManifest;
  releaseManifestSha256: string;
}

export interface PublishedAsset extends ReleaseAssetRecord {
  name: string;
}

export interface PublishedRelease {
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: PublishedAsset[];
}

export interface ReleaseObservation {
  tagTargetSha: string | null;
  tagObjectType: "commit" | "tag" | null;
  release: PublishedRelease | null;
}

export interface CandidateArtifactIdentity {
  version: string;
  commitSha: string;
  candidateRunId: string;
  artifactId: string;
  artifactDigest: string;
  runSha: string;
}

export interface VerifiedCandidateArtifactMetadata {
  id: string;
  name: string;
  digest: string;
  candidateRunId: string;
  runSha: string;
  createdAt: string;
  expiresAt: string;
}

export interface SelectedRelease {
  releaseId: string | null;
  published: boolean;
}

export type PublicationState =
  | { kind: "clear" }
  | { kind: "draft-incomplete"; missingAssets: PublicAssetName[] }
  | { kind: "draft-ready" }
  | { kind: "already-published" }
  | { kind: "tag-only" }
  | { kind: "release-only" }
  | { kind: "mismatch"; reason: "tag" | "target" | "body" | "assets" | "release" };

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertStableVersion(version: string): void {
  const match = STABLE_SEMVER.exec(version);
  if (match === null || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error("Version must be a stable semantic version");
  }
}

function assertFullSha(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function assertPositiveId(value: string, label: string): void {
  if (!POSITIVE_ID.test(value)) throw new Error(`${label} must be a positive decimal ID`);
}

function assertIdentity(identity: ReleaseIdentity): void {
  assertStableVersion(identity.version);
  assertFullSha(identity.commitSha, "Commit SHA");
  assertSha256(identity.releaseNotesSha256, "Release-notes hash");
}

function exactKeys(actual: string[], expected: readonly string[]): boolean {
  const sorted = [...actual].sort();
  return sorted.length === expected.length && sorted.every((value, index) => value === expected[index]);
}

function artifactDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(resolved) !== resolved) {
    throw new Error("Artifact directory must be a real directory, not a symlink");
  }
  return resolved;
}

function assertExactDirectoryEntries(directory: string, expected: readonly string[]): void {
  if (!exactKeys(readdirSync(directory), expected)) {
    throw new Error(`Artifact directory must contain the exact filenames: ${expected.join(", ")}`);
  }
}

function readRegularFile(directory: string, name: string): Buffer {
  const file = path.join(directory, name);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} must be a regular file, not a symlink`);
  const realDirectory = realpathSync(directory);
  if (realpathSync(file) !== path.join(realDirectory, name)) {
    throw new Error(`${name} path must not escape the artifact directory`);
  }
  return readFileSync(file);
}

function strictText(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} must be UTF-8 text`);
  }
  if (value.includes("\0")) throw new Error(`${label} must be UTF-8 text without NUL bytes`);
  return value;
}

function payloadRecords(directory: string): Record<PayloadName, ReleaseAssetRecord> {
  return Object.fromEntries(
    PAYLOAD_NAMES.map((name) => {
      const bytes = readRegularFile(directory, name);
      return [name, { sha256: sha256(bytes), size: bytes.byteLength }];
    }),
  ) as Record<PayloadName, ReleaseAssetRecord>;
}

function parseChecksums(bytes: Uint8Array): Record<(typeof BINARY_NAMES)[number], string> {
  const text = strictText(bytes, "SHA256SUMS");
  if (text.includes("\r") || !text.endsWith("\n")) {
    throw new Error("SHA256SUMS must use LF lines with a trailing newline");
  }
  const lines = text.slice(0, -1).split("\n");
  const entries: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
    if (match === null) throw new Error("SHA256SUMS contains a malformed checksum line");
    const [, digest, name] = match;
    if (name === undefined || digest === undefined || entries[name] !== undefined) {
      throw new Error("SHA256SUMS contains a duplicate or malformed filename");
    }
    entries[name] = digest;
  }
  if (!exactKeys(Object.keys(entries), BINARY_NAMES)) {
    throw new Error(`SHA256SUMS must contain the exact binary filenames: ${BINARY_NAMES.join(", ")}`);
  }
  return entries as Record<(typeof BINARY_NAMES)[number], string>;
}

function assertChecksumAgreement(directory: string, records: Record<PayloadName, ReleaseAssetRecord>): void {
  const checksums = parseChecksums(readRegularFile(directory, "SHA256SUMS"));
  for (const name of BINARY_NAMES) {
    if (checksums[name] !== records[name].sha256) throw new Error(`Checksum for ${name} does not match its file hash`);
  }
}

function manifestFrom(identity: ReleaseIdentity, assets: Record<PayloadName, ReleaseAssetRecord>): ReleaseManifest {
  return {
    schemaVersion: 1,
    version: identity.version,
    commitSha: identity.commitSha,
    releaseNotesSha256: identity.releaseNotesSha256,
    assets: Object.fromEntries(PAYLOAD_NAMES.map((name) => [name, assets[name]])) as Record<
      PayloadName,
      ReleaseAssetRecord
    >,
  };
}

function manifestBytes(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function releaseListingIdentity(value: unknown, label: string): { id: string; tagName: string; draft: boolean } {
  const release = plainRecord(value, label);
  if (
    typeof release.id !== "number" ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    typeof release.tag_name !== "string" ||
    typeof release.draft !== "boolean"
  ) {
    throw new Error(`${label} is missing an exact ID, tag name, or draft state`);
  }
  return { id: String(release.id), tagName: release.tag_name, draft: release.draft };
}

export function selectUniqueRelease(
  releasePages: unknown,
  publishedByTag: unknown | null,
  expectedTag: string,
): SelectedRelease {
  if (!/^v.+$/.test(expectedTag)) throw new Error("Expected Release tag must start with v");
  if (!Array.isArray(releasePages) || releasePages.length === 0 || releasePages.length > 3) {
    throw new Error("Release listing must contain between one and three bounded pages");
  }
  const pages = releasePages.map((value, pageIndex) => {
    if (!Array.isArray(value) || value.length > 100) {
      throw new Error(`Release listing page ${pageIndex + 1} exceeds the bounded page size`);
    }
    return value;
  });
  if (pages.length === 3 && pages[2]!.length === 100) {
    throw new Error("Bounded Release listing cannot prove uniqueness beyond 300 records");
  }

  const matches = pages
    .flat()
    .map((value, index) => releaseListingIdentity(value, `Release listing record ${index}`))
    .filter((release) => release.tagName === expectedTag);
  if (matches.length > 1) throw new Error(`Multiple Releases use tag ${expectedTag}`);

  if (publishedByTag !== null) {
    const published = releaseListingIdentity(publishedByTag, "Published Release tag response");
    if (published.tagName !== expectedTag || published.draft) {
      throw new Error("Published Release tag response has inconsistent identity");
    }
    if (matches.length !== 1 || matches[0]!.id !== published.id || matches[0]!.draft) {
      throw new Error("Published Release tag response disagrees with the bounded Release listing");
    }
    return { releaseId: published.id, published: true };
  }

  if (matches.length === 0) return { releaseId: null, published: false };
  if (!matches[0]!.draft) throw new Error("Release listing contains a published tag absent from the tag endpoint");
  return { releaseId: matches[0]!.id, published: false };
}

function parseUtcTimestamp(value: unknown, label: string): { source: string; milliseconds: number } {
  if (typeof value !== "string") throw new Error(`${label} must be a UTC ISO timestamp`);
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) throw new Error(`${label} must be a UTC ISO timestamp`);
  const milliseconds = Date.parse(value);
  const base = match[1];
  const fraction = match[2] ?? "000";
  const normalized = `${base}.${fraction.padEnd(3, "0")}Z`;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new Error(`${label} must be a valid UTC ISO timestamp`);
  }
  return { source: value, milliseconds };
}

interface ParsedArtifactMetadata extends VerifiedCandidateArtifactMetadata {
  expired: boolean;
  createdMilliseconds: number;
  expiresMilliseconds: number;
}

function parseArtifactMetadata(value: unknown, label: string): ParsedArtifactMetadata {
  const artifact = plainRecord(value, label);
  const workflowRun = plainRecord(artifact.workflow_run, `${label} workflow_run`);
  if (
    typeof artifact.id !== "number" ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    typeof artifact.name !== "string" ||
    typeof artifact.digest !== "string" ||
    typeof artifact.expired !== "boolean" ||
    typeof workflowRun.id !== "number" ||
    !Number.isSafeInteger(workflowRun.id) ||
    workflowRun.id <= 0 ||
    typeof workflowRun.head_sha !== "string"
  ) {
    throw new Error(`${label} is missing exact identity fields`);
  }
  const created = parseUtcTimestamp(artifact.created_at, `${label} created_at`);
  const expires = parseUtcTimestamp(artifact.expires_at, `${label} expires_at`);
  return {
    id: String(artifact.id),
    name: artifact.name,
    digest: artifact.digest,
    expired: artifact.expired,
    candidateRunId: String(workflowRun.id),
    runSha: workflowRun.head_sha,
    createdAt: created.source,
    expiresAt: expires.source,
    createdMilliseconds: created.milliseconds,
    expiresMilliseconds: expires.milliseconds,
  };
}

function sameArtifactMetadata(left: ParsedArtifactMetadata, right: ParsedArtifactMetadata): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.digest === right.digest &&
    left.expired === right.expired &&
    left.candidateRunId === right.candidateRunId &&
    left.runSha === right.runSha &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt
  );
}

export function verifyCandidateArtifactMetadata(
  artifactsResponse: unknown,
  artifactResponse: unknown,
  identity: CandidateArtifactIdentity,
  now: Date,
): VerifiedCandidateArtifactMetadata {
  assertStableVersion(identity.version);
  assertFullSha(identity.commitSha, "Commit SHA");
  assertPositiveId(identity.candidateRunId, "Candidate run ID");
  assertPositiveId(identity.artifactId, "Artifact ID");
  assertSha256(identity.artifactDigest, "Artifact digest");
  assertFullSha(identity.runSha, "Candidate run SHA");
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new Error("Current time must be valid");

  const list = plainRecord(artifactsResponse, "Candidate artifact list");
  if (list.total_count !== 1 || !Array.isArray(list.artifacts) || list.artifacts.length !== 1) {
    throw new Error("Candidate run must contain the sole artifact");
  }
  const listed = parseArtifactMetadata(list.artifacts[0], "Listed artifact");
  const detailed = parseArtifactMetadata(artifactResponse, "Detailed artifact");
  if (!sameArtifactMetadata(listed, detailed)) throw new Error("Artifact list and detail metadata disagree");

  const expectedName = `release-candidate-${identity.version}-${identity.commitSha}`;
  const expectedDigest = `sha256:${identity.artifactDigest}`;
  if (
    detailed.id !== identity.artifactId ||
    detailed.name !== expectedName ||
    detailed.digest !== expectedDigest ||
    detailed.candidateRunId !== identity.candidateRunId ||
    detailed.runSha !== identity.runSha
  ) {
    throw new Error("Artifact metadata does not match the sealed candidate identity");
  }
  if (detailed.expiresMilliseconds <= detailed.createdMilliseconds) {
    throw new Error("Candidate artifact expires_at must be after created_at");
  }
  if (detailed.expiresMilliseconds - detailed.createdMilliseconds > SEVEN_DAYS_MS) {
    throw new Error("Candidate artifact lifetime must not exceed seven days");
  }
  if (detailed.expired || nowMilliseconds >= detailed.expiresMilliseconds) {
    throw new Error("Candidate artifact is expired");
  }
  if (detailed.createdMilliseconds > nowMilliseconds) throw new Error("Candidate artifact was created in the future");
  const {
    expired: _expired,
    createdMilliseconds: _createdMilliseconds,
    expiresMilliseconds: _expiresMilliseconds,
    ...verified
  } = detailed;
  return verified;
}

function parseManifest(bytes: Uint8Array): ReleaseManifest {
  const source = strictText(bytes, MANIFEST_NAME);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${MANIFEST_NAME} must contain valid JSON`);
  }
  const record = plainRecord(value, MANIFEST_NAME);
  const topKeys = ["assets", "commitSha", "releaseNotesSha256", "schemaVersion", "version"];
  if (!exactKeys(Object.keys(record), topKeys)) throw new Error(`${MANIFEST_NAME} contains unexpected fields`);
  if (record.schemaVersion !== 1) throw new Error("Release manifest schema version must be 1");
  if (typeof record.version !== "string") throw new Error("Manifest version must be a string");
  if (typeof record.commitSha !== "string") throw new Error("Manifest commit SHA must be a string");
  if (typeof record.releaseNotesSha256 !== "string") throw new Error("Manifest release-notes hash must be a string");
  const identity = {
    version: record.version,
    commitSha: record.commitSha,
    releaseNotesSha256: record.releaseNotesSha256,
  };
  assertIdentity(identity);
  const assets = plainRecord(record.assets, "Manifest assets");
  if (!exactKeys(Object.keys(assets), PAYLOAD_NAMES)) {
    throw new Error(`Manifest must contain the exact asset filenames: ${PAYLOAD_NAMES.join(", ")}`);
  }
  const parsedAssets: Partial<Record<PayloadName, ReleaseAssetRecord>> = {};
  for (const name of PAYLOAD_NAMES) {
    const asset = plainRecord(assets[name], `Manifest asset ${name}`);
    if (!exactKeys(Object.keys(asset), ["sha256", "size"])) throw new Error(`Manifest asset ${name} is malformed`);
    if (typeof asset.sha256 !== "string") throw new Error(`Manifest asset ${name} hash must be a string`);
    assertSha256(asset.sha256, `Manifest asset ${name} hash`);
    if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`Manifest asset ${name} size must be a nonnegative safe integer`);
    }
    parsedAssets[name] = { sha256: asset.sha256, size: asset.size };
  }
  const manifest = manifestFrom(identity, parsedAssets as Record<PayloadName, ReleaseAssetRecord>);
  if (manifestBytes(manifest) !== source) {
    throw new Error(`${MANIFEST_NAME} must use canonical two-space JSON with one trailing newline`);
  }
  return manifest;
}

export function createReleaseManifest(directory: string, identity: ReleaseIdentity): ManifestVerification {
  assertIdentity(identity);
  const artifact = artifactDirectory(directory);
  assertExactDirectoryEntries(artifact, PAYLOAD_NAMES);
  const assets = payloadRecords(artifact);
  if (assets["release-notes.md"].sha256 !== identity.releaseNotesSha256) {
    throw new Error("Release-notes hash does not match release-notes.md");
  }
  assertChecksumAgreement(artifact, assets);
  const manifest = manifestFrom(identity, assets);
  const bytes = manifestBytes(manifest);
  writeFileSync(path.join(artifact, MANIFEST_NAME), bytes, { flag: "wx" });
  return { manifest, releaseManifestSha256: sha256(bytes) };
}

export function verifyReleaseManifest(directory: string, identity: ReleaseIdentity): ManifestVerification {
  assertIdentity(identity);
  const artifact = artifactDirectory(directory);
  assertExactDirectoryEntries(artifact, [...PAYLOAD_NAMES, MANIFEST_NAME].sort());
  const manifestBytesOnDisk = readRegularFile(artifact, MANIFEST_NAME);
  const manifest = parseManifest(manifestBytesOnDisk);
  if (manifest.version !== identity.version) throw new Error("Manifest version does not match the sealed version");
  if (manifest.commitSha !== identity.commitSha)
    throw new Error("Manifest commit SHA does not match the sealed commit SHA");
  if (manifest.releaseNotesSha256 !== identity.releaseNotesSha256) {
    throw new Error("Manifest release-notes hash does not match the sealed release-notes hash");
  }
  for (const name of PAYLOAD_NAMES) {
    const bytes = readRegularFile(artifact, name);
    if (bytes.byteLength !== manifest.assets[name].size) throw new Error(`${name} size does not match the manifest`);
    if (sha256(bytes) !== manifest.assets[name].sha256) throw new Error(`${name} hash does not match the manifest`);
  }
  if (manifest.assets["release-notes.md"].sha256 !== identity.releaseNotesSha256) {
    throw new Error("Release-notes hash does not match release-notes.md");
  }
  assertChecksumAgreement(artifact, manifest.assets);
  return { manifest, releaseManifestSha256: sha256(manifestBytesOnDisk) };
}

function samePublishedAssets(manifest: ReleaseManifest, actual: PublishedAsset[]): boolean {
  if (actual.length !== PUBLIC_ASSET_NAMES.length) return false;
  const byName = new Map<string, PublishedAsset>();
  for (const asset of actual) {
    if (byName.has(asset.name)) return false;
    byName.set(asset.name, asset);
  }
  return PUBLIC_ASSET_NAMES.every((name: PublicAssetName) => {
    const observed = byName.get(name);
    const expected = manifest.assets[name];
    return observed?.size === expected.size && observed.sha256 === expected.sha256;
  });
}

function missingDraftAssets(manifest: ReleaseManifest, actual: PublishedAsset[]): PublicAssetName[] | null {
  const byName = new Map<string, PublishedAsset>();
  for (const asset of actual) {
    if (byName.has(asset.name) || !PUBLIC_ASSET_NAMES.includes(asset.name as PublicAssetName)) return null;
    const expected = manifest.assets[asset.name as PublicAssetName];
    if (asset.size !== expected.size || asset.sha256 !== expected.sha256) return null;
    byName.set(asset.name, asset);
  }
  return PUBLIC_ASSET_NAMES.filter((name) => !byName.has(name));
}

export function classifyPublicationState(
  manifest: ReleaseManifest,
  releaseNotes: string,
  observation: ReleaseObservation,
): PublicationState {
  assertIdentity(manifest);
  if (sha256(releaseNotes) !== manifest.releaseNotesSha256) {
    throw new Error("Release notes do not match the manifest release-notes hash");
  }
  if (observation.tagTargetSha === null) {
    if (observation.tagObjectType !== null) throw new Error("Absent tag must not have an object type");
    if (observation.release === null) return { kind: "clear" };
    const draft = observation.release;
    if (!draft.draft) return { kind: "release-only" };
    const expectedTag = `v${manifest.version}`;
    if (
      draft.tagName !== expectedTag ||
      draft.targetCommitish !== manifest.commitSha ||
      draft.name !== expectedTag ||
      draft.prerelease
    ) {
      return { kind: "mismatch", reason: "release" };
    }
    if (draft.body !== releaseNotes) return { kind: "mismatch", reason: "body" };
    const missingAssets = missingDraftAssets(manifest, draft.assets);
    if (missingAssets === null) return { kind: "mismatch", reason: "assets" };
    return missingAssets.length === 0 ? { kind: "draft-ready" } : { kind: "draft-incomplete", missingAssets };
  }
  if (observation.tagObjectType !== "commit" && observation.tagObjectType !== "tag") {
    throw new Error("Existing tag must have a recognized object type");
  }
  if (observation.tagObjectType !== "commit") return { kind: "mismatch", reason: "tag" };
  if (observation.tagTargetSha !== manifest.commitSha) return { kind: "mismatch", reason: "target" };
  if (observation.release === null) return { kind: "tag-only" };

  const expectedTag = `v${manifest.version}`;
  const release = observation.release;
  if (release.tagName !== expectedTag || release.name !== expectedTag || release.draft || release.prerelease) {
    return { kind: "mismatch", reason: "release" };
  }
  if (release.body !== releaseNotes) return { kind: "mismatch", reason: "body" };
  if (!samePublishedAssets(manifest, release.assets)) return { kind: "mismatch", reason: "assets" };
  return { kind: "already-published" };
}

function parseArguments(args: string[], names: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !names.includes(name)) throw new Error(`Unknown argument: ${name ?? ""}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires one value`);
    if (values.has(name)) throw new Error(`${name} may be provided only once`);
    values.set(name, value);
  }
  for (const name of names) if (!values.has(name)) throw new Error(`Missing required argument: ${name}`);
  return values;
}

function identityFrom(values: Map<string, string>): ReleaseIdentity {
  return {
    version: values.get("--version")!,
    commitSha: values.get("--commit-sha")!,
    releaseNotesSha256: values.get("--release-notes-sha256")!,
  };
}

function parseJsonFile(file: string, label: string): unknown {
  try {
    return JSON.parse(strictText(readFileSync(file), label));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must contain valid JSON`);
    throw error;
  }
}

function parsePublishedRelease(file: string): PublishedRelease {
  const value = parseJsonFile(file, "Release API response");
  const release = plainRecord(value, "Release API response");
  if (
    typeof release.tag_name !== "string" ||
    typeof release.target_commitish !== "string" ||
    typeof release.name !== "string" ||
    typeof release.body !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("Release API response is missing required fields");
  }
  const assets = release.assets.map((value, index): PublishedAsset => {
    const asset = plainRecord(value, `Release asset ${index}`);
    const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
    if (
      typeof asset.name !== "string" ||
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      digest === undefined
    ) {
      throw new Error(`Release asset ${index} is missing an exact SHA-256 digest, size, or name`);
    }
    return { name: asset.name, size: asset.size, sha256: digest };
  });
  return {
    tagName: release.tag_name,
    targetCommitish: release.target_commitish,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    assets,
  };
}

async function main(args: string[]): Promise<void> {
  const command = args[0];
  const identityArguments = ["--directory", "--version", "--commit-sha", "--release-notes-sha256"];
  if (command === "create" || command === "verify") {
    const values = parseArguments(args.slice(1), identityArguments);
    const operation = command === "create" ? createReleaseManifest : verifyReleaseManifest;
    console.log(JSON.stringify(operation(values.get("--directory")!, identityFrom(values))));
    return;
  }
  if (command === "artifact-metadata") {
    const values = parseArguments(args.slice(1), [
      "--artifacts-json",
      "--artifact-json",
      "--version",
      "--commit-sha",
      "--candidate-run-id",
      "--artifact-id",
      "--artifact-digest",
      "--run-sha",
    ]);
    const verified = verifyCandidateArtifactMetadata(
      parseJsonFile(values.get("--artifacts-json")!, "Candidate artifact list"),
      parseJsonFile(values.get("--artifact-json")!, "Candidate artifact detail"),
      {
        version: values.get("--version")!,
        commitSha: values.get("--commit-sha")!,
        candidateRunId: values.get("--candidate-run-id")!,
        artifactId: values.get("--artifact-id")!,
        artifactDigest: values.get("--artifact-digest")!,
        runSha: values.get("--run-sha")!,
      },
      new Date(),
    );
    console.log(JSON.stringify(verified));
    return;
  }
  if (command === "release-lookup") {
    const values = parseArguments(args.slice(1), ["--release-pages-json", "--published-json", "--tag"]);
    const publishedValue = values.get("--published-json")!;
    console.log(
      JSON.stringify(
        selectUniqueRelease(
          parseJsonFile(values.get("--release-pages-json")!, "Bounded Release listing"),
          publishedValue === "absent" ? null : parseJsonFile(publishedValue, "Published Release tag response"),
          values.get("--tag")!,
        ),
      ),
    );
    return;
  }
  if (command === "publication-state") {
    const values = parseArguments(args.slice(1), [
      ...identityArguments,
      "--tag-target",
      "--tag-object-type",
      "--release-json",
    ]);
    const directory = values.get("--directory")!;
    const verified = verifyReleaseManifest(directory, identityFrom(values));
    const tagValue = values.get("--tag-target")!;
    const tagTargetSha = tagValue === "absent" ? null : tagValue;
    if (tagTargetSha !== null) assertFullSha(tagTargetSha, "Tag target");
    const tagTypeValue = values.get("--tag-object-type")!;
    const tagObjectType = tagTypeValue === "absent" ? null : tagTypeValue;
    if (tagObjectType !== null && tagObjectType !== "commit" && tagObjectType !== "tag") {
      throw new Error("Tag object type must be absent, commit, or tag");
    }
    if ((tagTargetSha === null) !== (tagObjectType === null)) {
      throw new Error("Tag target and object type must both be absent or both be present");
    }
    const releaseValue = values.get("--release-json")!;
    const release = releaseValue === "absent" ? null : parsePublishedRelease(releaseValue);
    const notes = strictText(readRegularFile(artifactDirectory(directory), "release-notes.md"), "release-notes.md");
    console.log(
      JSON.stringify(classifyPublicationState(verified.manifest, notes, { tagTargetSha, tagObjectType, release })),
    );
    return;
  }
  throw new Error(`Unknown command: ${command ?? ""}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release-manifest: ${message}`);
    process.exitCode = 1;
  }
}
