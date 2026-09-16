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
  /** The full command path being run (e.g. `"gusto employee list"`). Set by the runner from the
   * dispatched command, not parsed from CLI options, so it's absent until the runner injects it.
   * Threaded through to the API client as the per-command `X-Gusto-CLI-Command` request header. */
  command?: string;
}

/** Turn a full command path into the compact slug sent as `X-Gusto-CLI-Command`: strip a leading
 * `"gusto "`, trim, lowercase, and collapse internal whitespace runs to a single `-`. */
export function commandSlug(command: string): string {
  return command
    .replace(/^gusto /, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/** Resolve commander's `--fields [list]` value into a FieldSelection.
 * Absent → undefined; present with no/blank value → discover; otherwise a select on the keys. */
function readFieldSelection(raw: unknown): FieldSelection | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) return { mode: "discover" };
  const keys = parseFieldList(String(raw));
  return keys.length === 0 ? { mode: "discover" } : { mode: "select", keys };
}

export function readGlobalFlags(opts: OptionValues): GlobalFlags {
  return {
    agent: opts.agent === true,
    human: opts.human === true,
    json: opts.json === true,
    verbose: opts.verbose === true,
    // Already resolved by commander: `--env` > GUSTO_ENVIRONMENT (via `.env()`) > the config-file
    // default (via `.default()`, installed in `buildProgram`). Undefined when none was set, which
    // `defaultEnv` reads as production.
    env: opts.env as Environment | undefined,
    fields: readFieldSelection(opts.fields),
  };
}
