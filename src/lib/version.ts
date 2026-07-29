import pkg from "../../package.json" with { type: "json" };

/** The CLI's version, and the single source `gusto --version` and the outbound
 * `User-Agent` both read from - so the version a user reports can't disagree with the
 * version our request logs attribute their calls to. `bun build --compile` inlines this
 * JSON into the binary, and the release workflow refuses to publish unless the git tag
 * matches `package.json`, so this stays the one place a version is declared. */
export const VERSION: string = pkg.version;

/** Strip anything outside the unreserved set so a platform value can't inject header
 * bytes (CR/LF) or a space that would break the `name/version (platform)` grammar
 * parsers group on. Defensive: `process.platform`/`process.arch` are enum-like today,
 * but a header built from ambient runtime state shouldn't assume that. */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** `gusto-cli/<version> (<os>-<arch>)`, e.g. `gusto-cli/0.1.0 (darwin-arm64)`.
 *
 * Sent on every API request so install-base version spread is measurable in the request
 * logs (how stale the field is, whether a release got picked up, how wide a bad build's
 * blast radius is). Deliberately machine-parseable and stable: no free text, no locale-
 * or clock-dependent fields, nothing that varies between two runs of the same build on
 * the same machine - the value has to group cleanly in request-log analytics.
 *
 * `os`/`arch` come from `process.platform`/`process.arch`, which yield the same tokens as
 * the release artifact names (`darwin-arm64`, `darwin-x64`, `linux-x64`), so a row in the
 * logs maps directly to a published binary. Computed once at module load - it can't change
 * within a process. */
export const USER_AGENT: string = `gusto-cli/${VERSION} (${sanitize(process.platform)}-${sanitize(process.arch)})`;
