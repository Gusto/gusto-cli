import type { Command } from "commander";
import { fetchResource } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runReadCommand } from "../lib/runner.ts";

interface JobReadOpts {
  tokenStdin?: boolean;
}

export function registerJobCommand(parent: Command): void {
  const cmd = parent.command("job").description("Inspect jobs and their compensations");

  cmd
    .command("show <job_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read a job record")
    .option(...TOKEN_STDIN_OPT)
    .action((jobUuid: string, opts: JobReadOpts) =>
      runReadCommand("gusto job show", readGlobalFlags(parent.opts()), jobShowHandler(jobUuid, opts)),
    );

  cmd
    .command("compensations <job_uuid>")
    .description("List a job's compensations")
    .option(...TOKEN_STDIN_OPT)
    .action((jobUuid: string, opts: JobReadOpts) =>
      runReadCommand("gusto job compensations", readGlobalFlags(parent.opts()), jobCompensationsHandler(jobUuid, opts)),
    );
}

export function jobShowHandler(jobUuid: string, opts: JobReadOpts): CommandHandler {
  return async ({ globals }) => fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/jobs/${jobUuid}`);
}

export function jobCompensationsHandler(jobUuid: string, opts: JobReadOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/jobs/${jobUuid}/compensations`);
}
