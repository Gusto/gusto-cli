import type { Command } from "commander";
import { fetchResource } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runReadCommand } from "../lib/runner.ts";

interface CompensationReadOpts {
  tokenStdin?: boolean;
}

export function registerCompensationCommand(parent: Command): void {
  const cmd = parent.command("compensation").description("Inspect job compensations");

  cmd
    .command("show <compensation_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read a compensation record")
    .option(...TOKEN_STDIN_OPT)
    .action((compensationUuid: string, opts: CompensationReadOpts) =>
      runReadCommand(
        "gusto compensation show",
        readGlobalFlags(parent.opts()),
        compensationShowHandler(compensationUuid, opts),
      ),
    );
}

export function compensationShowHandler(compensationUuid: string, opts: CompensationReadOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/compensations/${compensationUuid}`);
}
