import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { isTelemetryEnabled } from "./env.ts";
import type { EnvSource } from "./env.ts";
import type { Environment } from "./global-flags.ts";
import type { OutputMode } from "./output.ts";

export type ConfigKey = "environment" | "format" | "skills_auto_install" | "feedback_nudge" | "auto_update";

export const CONFIG_KEYS: readonly ConfigKey[] = [
  "environment",
  "format",
  "skills_auto_install",
  "feedback_nudge",
  "auto_update",
] as const;

export type SkillsAutoInstall = "ask" | "always" | "never";
export type FeedbackNudge = "on" | "off";
export type AutoUpdate = "on" | "off";

export interface UserConfig {
  environment?: Environment;
  format?: OutputMode;
  skills_auto_install?: SkillsAutoInstall;
  feedback_nudge?: FeedbackNudge;
  auto_update?: AutoUpdate;
  /** Anonymous per-install UUID managed by getOrCreateInstallId; not user-configurable. */
  install_id?: string;
}

const ENV_VALUES: readonly Environment[] = ["sandbox", "production"] as const;
const FORMAT_VALUES: readonly OutputMode[] = ["agent", "human"] as const;
const SKILLS_AUTO_INSTALL_VALUES: readonly SkillsAutoInstall[] = ["ask", "always", "never"] as const;
const FEEDBACK_NUDGE_VALUES: readonly FeedbackNudge[] = ["on", "off"] as const;
const AUTO_UPDATE_VALUES: readonly AutoUpdate[] = ["on", "off"] as const;

/** The env override for `auto_update`, which wins over the config file. */
export const AUTO_UPDATE_ENV = "GUSTO_CLI_AUTO_UPDATE";
/** The env override for `feedback_nudge`, which wins over the config file. */
export const FEEDBACK_NUDGE_ENV = "GUSTO_CLI_FEEDBACK_NUDGE";

/** Normalises anything that might mean on or off. Only `on` reads as on; everything else present
 * reads as off, because `on` is the default and so the only reason to set either opt-out key is to
 * turn it off - see their branches in `pickValid`. */
function readOnOff(value: string | boolean): "on" | "off" {
  const text = typeof value === "boolean" ? (value ? "on" : "off") : String(value).trim();
  return text.toLowerCase() === "on" ? "on" : "off";
}

/** Whether auto-update is on for this invocation, env first.
 *
 * The env form exists for the places a config file doesn't reach: an ephemeral container writes no
 * `update-state.toml` and keeps no `config.toml`, so without this the only ways to stop a
 * per-container release download were baking a config file into the image or pinning a version. */
export function autoUpdateEnabled(cfg: Pick<UserConfig, "auto_update">, env: EnvSource = process.env): boolean {
  const override = env[AUTO_UPDATE_ENV];
  if (override !== undefined && override.length > 0) return readOnOff(override) === "on";
  return cfg.auto_update !== "off";
}

/** Whether feedback nudges are on for this invocation, env first. */
export function feedbackNudgeEnabled(cfg: Pick<UserConfig, "feedback_nudge">, env: EnvSource = process.env): boolean {
  const override = env[FEEDBACK_NUDGE_ENV];
  if (override !== undefined && override.length > 0) return readOnOff(override) === "on";
  return cfg.feedback_nudge !== "off";
}

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
  const { mkdir, writeFile, rename, rm } = await import("node:fs/promises");
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  // Write to a uniquely-named temp file and rename into place: POSIX rename on the same
  // filesystem is atomic, so a concurrent reader can never observe a half-written file.
  // Suffix includes pid + a UUID so two concurrent writes in the same process (or across
  // processes with recycled PIDs) don't step on each other's temp file.
  const tmp = `${paths.file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Mode at creation, not a follow-up chmod: never expose the file at the umask default.
    await writeFile(tmp, stringify(stripUndefined(cfg)), { mode: 0o600 });
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
    case "feedback_nudge":
      return (FEEDBACK_NUDGE_VALUES as readonly string[]).includes(value)
        ? null
        : `feedback_nudge must be one of: ${FEEDBACK_NUDGE_VALUES.join(", ")}`;
    case "auto_update":
      return (AUTO_UPDATE_VALUES as readonly string[]).includes(value)
        ? null
        : `auto_update must be one of: ${AUTO_UPDATE_VALUES.join(", ")}`;
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
  // These opt-out keys fail closed. The obvious hand-edit is a TOML boolean, and an unrecognised
  // value must not be dropped because both consumers treat a missing value as on. `config set`
  // remains strict; this normalization only protects direct edits.
  if (raw.feedback_nudge !== undefined) {
    out.feedback_nudge = readOnOff(
      typeof raw.feedback_nudge === "boolean" || typeof raw.feedback_nudge === "string"
        ? raw.feedback_nudge
        : String(raw.feedback_nudge),
    );
  }
  if (raw.auto_update !== undefined) {
    out.auto_update = readOnOff(
      typeof raw.auto_update === "boolean" || typeof raw.auto_update === "string"
        ? raw.auto_update
        : String(raw.auto_update),
    );
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
