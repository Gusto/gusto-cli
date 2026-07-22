import { Command, CommanderError, Option } from "commander";
import { registerApiCommand } from "./commands/api.ts";
import { registerAuthCommand } from "./commands/auth.ts";
import { registerCompanyCommand } from "./commands/company.ts";
import { registerCompensationCommand } from "./commands/compensation.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerContractorCommand } from "./commands/contractor.ts";
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
import { usageErrorEnvelope } from "./lib/command-diagnostics.ts";
import { ExitCode } from "./lib/exit-codes.ts";
import type { GlobalFlags } from "./lib/global-flags.ts";
import { emit, outputOptionsFrom } from "./lib/output.ts";
import pkg from "../package.json" with { type: "json" };

const VERSION: string = pkg.version;

const HELP_FOOTER = `
Documentation:
  https://github.com/Gusto/gusto-cli

Report issues:
  https://github.com/Gusto/gusto-cli/issues
`;

function buildProgram(): Command {
  const program = new Command();

  program
    .name("gusto")
    .description("Gusto CLI - agent-friendly developer interface for Gusto payroll")
    .version(VERSION, "-v, --version", "Print version and exit")
    .addOption(new Option("--agent", "Emit stable JSON to stdout (auto-on when stdout is piped)"))
    .addOption(new Option("--human", "Emit human-readable output (default when stdout is a TTY)"))
    .addOption(new Option("--json", "Alias for --agent with JSON pinned"))
    .addOption(
      new Option("--env <env>", "Override environment for this invocation (default: production)")
        .choices(["sandbox", "production"])
        .env("GUSTO_ENVIRONMENT"),
    )
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
  registerDepartmentCommand(program);
  registerJobCommand(program);
  registerCompensationCommand(program);
  registerPayScheduleCommand(program);
  registerPayrollCommand(program);
  registerLedgerCommand(program);
  registerReportCommand(program);
  registerTimesheetCommand(program);
  registerAuthCommand(program);
  registerSkillCommand(program);
  registerConfigCommand(program);
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

async function main(argv: string[]): Promise<void> {
  installSignalHandlers();
  const program = buildProgram();

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
