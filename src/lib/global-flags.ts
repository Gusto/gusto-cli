import type { OptionValues } from "commander";

export type Environment = "sandbox" | "production";

export interface GlobalFlags {
  agent: boolean;
  human: boolean;
  json: boolean;
  verbose: boolean;
  env?: Environment;
}

export function readGlobalFlags(opts: OptionValues): GlobalFlags {
  return {
    agent: opts.agent === true,
    human: opts.human === true,
    json: opts.json === true,
    verbose: opts.verbose === true,
    env: opts.env as Environment | undefined,
  };
}
