import { Command, CommanderError, Option } from "commander";
import { registerApiCommand } from "./commands/api.ts";
import { registerAuthCommand } from "./commands/auth.ts";
import { registerCompanyCommand } from "./commands/company.ts";
import { registerCompensationCommand } from "./commands/compensation.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerContractorCommand } from "./commands/contractor.ts";
import { registerContractorPaymentCommand } from "./commands/contractor-payment.ts";
import { registerContractorPaymentGroupCommand } from "./commands/contractor-payment-group.ts";
import { registerDepartmentCommand } from "./commands/department.ts";
import { registerEmployeeCommand } from "./commands/employee.ts";
import { registerFeedbackCommand } from "./commands/feedback.ts";
import { registerJobCommand } from "./commands/job.ts";
import { registerLedgerCommand } from "./commands/ledger.ts";
import { registerPayScheduleCommand } from "./commands/pay-schedule.ts";
import { registerPayrollCommand } from "./commands/payroll.ts";
import { registerReportCommand } from "./commands/report.ts";
import { registerSkillCommand } from "./commands/skill.ts";
import { registerTimesheetCommand } from "./commands/timesheet.ts";
import { registerUpgradeCommand } from "./commands/upgrade.ts";
import {
  BACKGROUND_UPDATE_FLAG,
  maybeSpawnBackgroundCheck,
  runBackgroundCheck,
  swapStagedUpdate,
} from "./lib/auto-update.ts";
import { usageErrorEnvelope } from "./lib/command-diagnostics.ts";
import { readConfig, type UserConfig } from "./lib/config.ts";
import { ExitCode } from "./lib/exit-codes.ts";
import type { Environment, GlobalFlags } from "./lib/global-flags.ts";
import { type StreamSinks, defaultSinks, emit, outputOptionsFrom, resolveOutputMode } from "./lib/output.ts";
import { SKIP_AUTO_UPDATE_ENV } from "./lib/upgrade.ts";
import { VERSION } from "./lib/version.ts";

const HELP_FOOTER = `
Documentation:
  https://github.com/Gusto/gusto-cli

Report issues:
  https://github.com/Gusto/gusto-cli/issues
`;

/** `configuredEnvironment` is the persisted `gusto config set environment` value, installed as the
 * `--env` option's default. Commander then resolves the whole precedence chain itself: an explicit
 * `--env` outranks GUSTO_ENVIRONMENT, which outranks a default. Undefined leaves the option unset,
 * which `defaultEnv` reads as production. */
function buildProgram(configuredEnvironment?: Environment): Command {
  const program = new Command();

  const envOption = new Option(
    "--env <env>",
    "Override environment for this invocation. Outranks GUSTO_ENVIRONMENT and `gusto config set environment`; production when none of the three is set. Credentials are stored per environment.",
  )
    .choices(["sandbox", "production"])
    .env("GUSTO_ENVIRONMENT");
  // Only when one is persisted: `.default(undefined)` would still count as a default, and an unset
  // `--env` has to stay undefined so `defaultEnv` owns the production fallback in one place.
  if (configuredEnvironment) envOption.default(configuredEnvironment);

  program
    .name("gusto")
    .description("Gusto CLI - agent-friendly developer interface for Gusto payroll")
    .version(VERSION, "-v, --version", "Print version and exit")
    .addOption(new Option("--agent", "Emit stable JSON to stdout (auto-on when stdout is piped)"))
    .addOption(new Option("--human", "Emit human-readable output (default when stdout is a TTY)"))
    .addOption(new Option("--json", "Alias for --agent with JSON pinned"))
    .addOption(envOption)
    .addOption(new Option("--verbose", "Print request IDs and intermediate state to stderr"))
    .addOption(
      new Option(
        "--fields [list]",
        "Filter successful output to these comma-separated top-level keys; pass with no value on a read command to list its available fields",
      ),
    )
    .addHelpText("after", HELP_FOOTER)
    .exitOverride()
    // Silence commander's own raw "error: ..." line for usage errors; main() re-emits them through
    // the standard {ok:false} envelope instead (JSON on stdout in agent mode). Help output uses a
    // different channel and is unaffected, so `gusto <group>` with no subcommand still prints help.
    .configureOutput({ outputError: () => {} });

  registerCompanyCommand(program);
  registerEmployeeCommand(program);
  registerContractorCommand(program);
  registerContractorPaymentCommand(program);
  registerContractorPaymentGroupCommand(program);
  registerDepartmentCommand(program);
  registerJobCommand(program);
  registerCompensationCommand(program);
  registerPayScheduleCommand(program);
  registerPayrollCommand(program);
  registerLedgerCommand(program);
  registerReportCommand(program);
  registerTimesheetCommand(program);
  registerAuthCommand(program, configuredEnvironment);
  registerSkillCommand(program);
  registerConfigCommand(program);
  registerUpgradeCommand(program);
  registerApiCommand(program);
  registerFeedbackCommand(program);

  // Cascade exitOverride to every command at every depth (some commands, e.g. `auth login`,
  // nest subcommands two levels deep) so commander throws CommanderError instead of calling
  // process.exit() out from under us.
  const cascadeExitOverride = (cmd: Command): void => {
    cmd.exitOverride();
    for (const sub of cmd.commands) cascadeExitOverride(sub);
  };
  for (const cmd of program.commands) cascadeExitOverride(cmd);

  return program;
}

function installSignalHandlers(): void {
  const onSignal = (): never => process.exit(ExitCode.General);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

function exitCodeForCommanderError(err: CommanderError): number {
  switch (err.code) {
    case "commander.helpDisplayed":
    case "commander.help":
    case "commander.version":
      return ExitCode.Success;
    // A missing required positional is a validation failure, not a generic usage error: CLAUDE.md
    // documents it as the exit-7 blocked_on case, matching the handler-level `missingArgs` path.
    case "commander.missingArgument":
      return ExitCode.Validation;
    default:
      return ExitCode.CliUsage;
  }
}

/** Minimal flags for picking the output mode when reporting a usage error. The mode-selecting flags
 * are global, so a raw-argv scan is reliable even when commander threw before finishing its parse
 * (an unknown subcommand aborts parsing before a trailing --json is recorded on program.opts()). */
function usageFlags(argv: string[]): GlobalFlags {
  return {
    agent: argv.includes("--agent"),
    human: argv.includes("--human"),
    json: argv.includes("--json"),
    verbose: false,
  };
}

/** The persisted user config, read before commander is built so `environment` can become the
 * `--env` default and `auto_update` can gate the background check below.
 *
 * A corrupt config file warns and is ignored rather than aborting the run: failing hard here would
 * also block `gusto config reset`, the one command that fixes it. The warning says the defaults were
 * dropped, so a user whose `environment = "sandbox"` is being ignored finds out from us instead of
 * from a production 401. */
async function loadConfig(sinks: StreamSinks = defaultSinks): Promise<UserConfig> {
  try {
    return await readConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // stderr, like every other diagnostic the CLI writes: stdout carries the envelope and nothing
    // else, so a warning there would corrupt the one stream an agent parses. Through the sinks rather
    // than `process.stderr` directly, matching the rest of the writers.
    sinks.stderr.write(
      `warning: ignoring user config, so its defaults (including environment and auto_update) are not applied: ${message}\n`,
    );
    return {};
  }
}

async function main(argv: string[]): Promise<void> {
  // The detached child's entire job, checked before anything else so its startup stays cheap.
  // Matched against the exact argv shape the spawn produces rather than `argv.includes(...)`, which
  // would also match a command whose own option value happened to equal this string.
  const realArgs = argv.slice(2);
  if (realArgs.length === 1 && realArgs[0] === BACKGROUND_UPDATE_FLAG) {
    await runBackgroundCheck();
    process.exit(ExitCode.Success);
  }

  installSignalHandlers();
  const cfg = await loadConfig();

  // Set by `defaultVersionOf` on the binary it exec-checks: that binary's `main()` runs for real,
  // and would otherwise act on the same `update-state.toml` the outer call is still working through.
  const skipAutoUpdate = process.env[SKIP_AUTO_UPDATE_ENV] !== undefined;

  const program = buildProgram(cfg.environment);

  if (!skipAutoUpdate) {
    // A hook rather than code before `parseAsync`: every handler calls `process.exit()` itself
    // (see `lib/runner.ts`), so `parseAsync` never returns and there is no "after parse" to run in.
    program.hook("preAction", async (_thisCommand, actionCommand) => {
      // Excluded from both halves: swapping right before the `upgrade` handler would have
      // `--dry-run` report a version other than what is now on disk, and the background download
      // would duplicate the one being asked for.
      if (actionCommand.name() === "upgrade") return;
      await swapStagedUpdate({ cfg, sinks: defaultSinks, mode: resolveOutputMode(usageFlags(argv)) });
      await maybeSpawnBackgroundCheck({ cfg });
    });
  }

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      const code = exitCodeForCommanderError(err);
      // help/version aren't errors (commander already wrote the text); just exit. Everything else is
      // a usage error - re-emit it through the standard envelope so agents get a parseable
      // {ok:false} on stdout with valid_commands/did_you_mean instead of a bare stderr line.
      if (code !== ExitCode.Success) {
        emit(outputOptionsFrom(usageFlags(argv)), {
          ok: false,
          error: usageErrorEnvelope(err.code, err.message, program, argv.slice(2)),
        });
      }
      process.exit(code);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gusto: ${message}\n`);
    process.exit(ExitCode.General);
  }
}

await main(process.argv);
