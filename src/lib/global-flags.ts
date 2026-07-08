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

export function readGlobalFlags(opts: OptionValues): GlobalFlags {
  return {
    agent: opts.agent === true,
    human: opts.human === true,
    json: opts.json === true,
    verbose: opts.verbose === true,
    env: opts.env as Environment | undefined,
    fields: readFieldSelection(opts.fields),
  };
}
