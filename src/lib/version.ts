import pkg from "../../package.json" with { type: "json" };

/** The one place the CLI's version is declared - see `ARCHITECTURE.md#user-agent`.
 * `bun build --compile` inlines this JSON, so the compiled binary reads no file at runtime. */
export const VERSION: string = pkg.version;

/** Strip anything outside the unreserved set so a platform value can't inject header
 * bytes (CR/LF) or a space that would break the `name/version (platform)` grammar
 * parsers group on. Defensive: `process.platform`/`process.arch` are enum-like today,
 * but a header built from ambient runtime state shouldn't assume that. */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** e.g. `gusto-cli/0.1.0 (darwin-arm64)`. A stable contract that adoption reporting groups on -
 * before changing the grammar, read `ARCHITECTURE.md#user-agent`. */
export const USER_AGENT: string = `gusto-cli/${VERSION} (${sanitize(process.platform)}-${sanitize(process.arch)})`;
