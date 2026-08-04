import type { OptionValues } from "commander";
import { parseFieldList } from "./field-filter.ts";

export type Environment = "sandbox" | "production";

/** How `--fields` was supplied: `discover` (flag with no/blank value → list available fields)
 * or `select` (a non-empty key list → project the output down to those keys). Absent → undefined. */
export type FieldSelection = { mode: "discover" } | { mode: "select"; keys: string[] };

export interface GlobalFlags {
  agent: boolean;
  human: boolean;
  json: boolean;
  verbose: boolean;
  env?: Environment;
  fields?: FieldSelection;
}

/** Resolve commander's `--fields [list]` value into a FieldSelection.
 * Absent → undefined; present with no/blank value → discover; otherwise a select on the keys. */
function readFieldSelection(raw: unknown): FieldSelection | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { mode: "discover" };
  const keys = parseFieldList(String(raw));
  return keys.length === 0 ? { mode: "discover" } : { mode: "select", keys };
}

/** The persisted `environment` default, loaded once before commander parses (see
 * `setConfiguredEnvironment`). Cached rather than read per command because `readGlobalFlags` runs
 * inside every command's action and is synchronous; making it async would ripple through every
 * registration for a value that cannot change mid-run. */
let configuredEnvironment: Environment | undefined;

/** Install the config-file `environment` default. Called once from `main()` before parsing, so the
 * lowest tier of the precedence chain is in place by the time any action runs. Exported for tests,
 * which set it directly rather than writing a config file. */
export function setConfiguredEnvironment(env: Environment | undefined): void {
  configuredEnvironment = env;
}

export function readGlobalFlags(opts: OptionValues): GlobalFlags {
  return {
    agent: opts.agent === true,
    human: opts.human === true,
    json: opts.json === true,
    verbose: opts.verbose === true,
    // Precedence, highest first: `--env` > GUSTO_ENVIRONMENT > config `environment` > production.
    // Commander folds the env var into `opts.env` via `.env()`, so both of the top two tiers arrive
    // here as `opts.env` and outrank the config file without needing to be told apart. The final
    // production default lives in `defaultEnv`, which treats undefined as production.
    env: (opts.env as Environment | undefined) ?? configuredEnvironment,
    fields: readFieldSelection(opts.fields),
  };
}
