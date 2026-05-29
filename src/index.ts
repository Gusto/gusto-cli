import { Command, CommanderError, Option } from "commander";
import { registerApiCommand } from "./commands/api.ts";
import { registerAuthCommand } from "./commands/auth.ts";
import { registerCompanyCommand } from "./commands/company.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerContractorCommand } from "./commands/contractor.ts";
import { registerEmployeeCommand } from "./commands/employee.ts";
import { registerPayScheduleCommand } from "./commands/pay-schedule.ts";
import { registerSkillCommand } from "./commands/skill.ts";
import { ExitCode } from "./lib/exit-codes.ts";

const VERSION = "0.0.1";

const HELP_FOOTER = `
Documentation:
  https://cli.gusto.com

Report issues:
  https://github.com/Gusto/gusto-cli-public/issues
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
      new Option("--env <env>", "Override environment for this invocation")
        .choices(["sandbox", "production"])
        .env("GUSTO_ENVIRONMENT"),
    )
    .addOption(new Option("--verbose", "Print request IDs and intermediate state to stderr"))
    .showHelpAfterError("(run `gusto --help` for usage)")
    .addHelpText("after", HELP_FOOTER)
    .exitOverride();

  registerCompanyCommand(program);
  registerEmployeeCommand(program);
  registerContractorCommand(program);
  registerPayScheduleCommand(program);
  registerAuthCommand(program);
  registerSkillCommand(program);
  registerConfigCommand(program);
  registerApiCommand(program);

  // Cascade exitOverride to every subcommand so commander throws CommanderError
  // instead of calling process.exit() out from under us.
  for (const cmd of program.commands) {
    cmd.exitOverride();
    for (const sub of cmd.commands) sub.exitOverride();
  }

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
    default:
      return ExitCode.CliUsage;
  }
}

async function main(argv: string[]): Promise<void> {
  installSignalHandlers();
  const program = buildProgram();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exit(exitCodeForCommanderError(err));
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gusto: ${message}\n`);
    process.exit(ExitCode.General);
  }
}

await main(process.argv);
