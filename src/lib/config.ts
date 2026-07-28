import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { isTelemetryEnabled } from "./env.ts";
import type { Environment } from "./global-flags.ts";
import type { OutputMode } from "./output.ts";

export type ConfigKey = "environment" | "format" | "skills_auto_install";

export const CONFIG_KEYS: readonly ConfigKey[] = ["environment", "format", "skills_auto_install"] as const;

export type SkillsAutoInstall = "ask" | "always" | "never";

export interface UserConfig {
  environment?: Environment;
  format?: OutputMode;
  skills_auto_install?: SkillsAutoInstall;
  /** Anonymous per-install UUID managed by getOrCreateInstallId; not user-configurable. */
  install_id?: string;
}

const ENV_VALUES: readonly Environment[] = ["sandbox", "production"] as const;
const FORMAT_VALUES: readonly OutputMode[] = ["agent", "human"] as const;
const SKILLS_AUTO_INSTALL_VALUES: readonly SkillsAutoInstall[] = ["ask", "always", "never"] as const;

// Permissive UUID shape check — variant intentionally not pinned; we only care that on-disk
// values look like real UUIDs so corruption is rejected.
const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `json` is the advertised alias for `agent` (see the `--json` / `--agent` global flags).
// Accept it as a `format` value and persist it as `agent` so the config mirrors the flags.
const FORMAT_ALIASES: Readonly<Record<string, OutputMode>> = { json: "agent" } as const;

export interface ConfigPaths {
  dir: string;
  file: string;
}

export function configPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : path.join(homedir(), ".config");
  const dir = path.join(base, "gusto");
  return { dir, file: path.join(dir, "config.toml") };
}

export async function readConfig(paths: ConfigPaths = configPaths()): Promise<UserConfig> {
  const file = Bun.file(paths.file);
  if (!(await file.exists())) return {};
  const text = await file.text();
  if (text.trim().length === 0) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(text) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `config file at ${paths.file} is not valid TOML (${detail}). Fix it by hand or run \`gusto config reset\`.`,
      { cause: err },
    );
  }
  return pickValid(parsed);
}

export async function writeConfig(cfg: UserConfig, paths: ConfigPaths = configPaths()): Promise<void> {
  const { mkdir, chmod, rename, rm } = await import("node:fs/promises");
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  // Write to a uniquely-named temp file and rename into place: POSIX rename on the same
  // filesystem is atomic, so a concurrent reader can never observe a half-written file.
  // Suffix includes pid + a UUID so two concurrent writes in the same process (or across
  // processes with recycled PIDs) don't step on each other's temp file.
  const tmp = `${paths.file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, stringify(stripUndefined(cfg)));
    await chmod(tmp, 0o600);
    await rename(tmp, paths.file);
  } catch (err) {
    // Best-effort tmp cleanup; don't shadow the real error.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function resetConfig(paths: ConfigPaths = configPaths()): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(paths.file, { force: true });
}

/** Return the persisted anonymous install_id, generating and persisting a UUIDv4 on first use.
 * On a genuine first-run race two callers may each generate + write their own UUID: last-writer
 * wins on disk and every future caller converges. Not full first-writer-wins semantics (that
 * would need a lock file), but adequate — divergence is bounded to one command per racing caller
 * and self-heals on the next call. */
export async function getOrCreateInstallId(paths: ConfigPaths = configPaths()): Promise<string> {
  const cfg = await readConfig(paths);
  if (cfg.install_id) return cfg.install_id;
  const install_id = randomUUID();
  await writeConfig({ ...cfg, install_id }, paths);
  const settled = await readConfig(paths);
  return settled.install_id ?? install_id;
}

/** The install_id value to stamp on an outbound request, honoring GUSTO_TELEMETRY opt-out.
 * Returns undefined (suppresses the header) when telemetry is disabled or when the on-disk
 * config can't be read/written — telemetry is best-effort and must never fail the user's command.
 *
 * Memoized per process when called with the default paths so the file is read at most once
 * per invocation regardless of how many outbound requests the command makes. Callers that pass
 * an explicit `paths` (tests) bypass the cache and resolve fresh each call. */
let cachedDefaultInstallId: Promise<string | undefined> | undefined;

export async function resolveInstallIdHeader(paths?: ConfigPaths): Promise<string | undefined> {
  if (paths !== undefined) return resolveInstallIdOnce(paths);
  if (cachedDefaultInstallId === undefined) cachedDefaultInstallId = resolveInstallIdOnce(configPaths());
  return cachedDefaultInstallId;
}

async function resolveInstallIdOnce(paths: ConfigPaths): Promise<string | undefined> {
  if (!isTelemetryEnabled()) return undefined;
  try {
    return await getOrCreateInstallId(paths);
  } catch {
    return undefined;
  }
}

export function validateKey(key: string): ConfigKey | null {
  return (CONFIG_KEYS as readonly string[]).includes(key) ? (key as ConfigKey) : null;
}

export function validateValue(key: ConfigKey, value: string): string | null {
  switch (key) {
    case "environment":
      return (ENV_VALUES as readonly string[]).includes(value)
        ? null
        : `environment must be one of: ${ENV_VALUES.join(", ")}`;
    case "format":
      return (FORMAT_VALUES as readonly string[]).includes(value) || Object.hasOwn(FORMAT_ALIASES, value)
        ? null
        : `format must be one of: ${[...FORMAT_VALUES, ...Object.keys(FORMAT_ALIASES)].join(", ")}`;
    case "skills_auto_install":
      return (SKILLS_AUTO_INSTALL_VALUES as readonly string[]).includes(value)
        ? null
        : `skills_auto_install must be one of: ${SKILLS_AUTO_INSTALL_VALUES.join(", ")}`;
    default: {
      // Exhaustiveness guard: adding a ConfigKey without a case here is a compile error,
      // not a silent validation bypass.
      const unhandled: never = key;
      throw new Error(`no validation for config key: ${String(unhandled)}`);
    }
  }
}

/** Canonicalize a validated value before persisting (e.g. the `json` format alias → `agent`). */
export function normalizeValue(key: ConfigKey, value: string): string {
  if (key === "format" && Object.hasOwn(FORMAT_ALIASES, value)) return FORMAT_ALIASES[value];
  return value;
}

function pickValid(raw: Record<string, unknown>): UserConfig {
  const out: UserConfig = {};
  if (typeof raw.environment === "string" && (ENV_VALUES as readonly string[]).includes(raw.environment)) {
    out.environment = raw.environment as Environment;
  }
  if (typeof raw.format === "string" && (FORMAT_VALUES as readonly string[]).includes(raw.format)) {
    out.format = raw.format as OutputMode;
  }
  if (
    typeof raw.skills_auto_install === "string" &&
    (SKILLS_AUTO_INSTALL_VALUES as readonly string[]).includes(raw.skills_auto_install)
  ) {
    out.skills_auto_install = raw.skills_auto_install as SkillsAutoInstall;
  }
  // Drop corrupted values so getOrCreateInstallId regenerates on next call.
  if (typeof raw.install_id === "string" && INSTALL_ID_PATTERN.test(raw.install_id)) {
    out.install_id = raw.install_id;
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
