import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { Environment } from "./global-flags.ts";
import type { OutputMode } from "./output.ts";

export type ConfigKey = "environment" | "format";

export const CONFIG_KEYS: readonly ConfigKey[] = ["environment", "format"] as const;

export interface UserConfig {
  environment?: Environment;
  format?: OutputMode;
}

const ENV_VALUES: readonly Environment[] = ["sandbox", "production"] as const;
const FORMAT_VALUES: readonly OutputMode[] = ["agent", "human"] as const;

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
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await Bun.write(paths.file, stringify(stripUndefined(cfg)));
  await chmod(paths.file, 0o600);
}

export async function resetConfig(paths: ConfigPaths = configPaths()): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(paths.file, { force: true });
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
        : `format must be one of: ${FORMAT_VALUES.join(", ")}`;
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
  return out;
}

function stripUndefined<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
