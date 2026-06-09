import type { Command } from "commander";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";
import { findSkillsDir, getSkill, installSkill, listSkills } from "../lib/skills.ts";

export function registerSkillCommand(parent: Command): void {
  const cmd = parent.command("skill").description("List and install bundled skills");

  cmd
    .command("list")
    .description("Show bundled skills available to install")
    .action(() => runReadCommand("gusto skill list", readGlobalFlags(parent.opts()), skillListHandler()));

  cmd
    .command("install <name>")
    .description("Install a bundled skill into .claude / .cursor / .windsurf skills directory")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto skill install onboard-company

The skill is installed into the first of .claude/skills, .cursor/skills,
or .windsurf/skills found by walking up from the current directory. Falls
back to ~/.claude/skills. For .claude targets, the SKILL.md frontmatter
is augmented with user-invocable: true so the skill appears as a slash
command in Claude Code.
`,
    )
    .action((name: string) =>
      runCommand("gusto skill install", readGlobalFlags(parent.opts()), skillInstallHandler(name)),
    );
}

function skillListHandler(): CommandHandler {
  return async () => ({
    ok: true,
    data: { skills: listSkills().map(({ name, description }) => ({ name, description })) },
  });
}

function skillInstallHandler(name: string): CommandHandler {
  return async () => {
    const skill = getSkill(name);
    if (!skill) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "unknown_skill",
          message: `Unknown skill: ${name}. Run \`gusto skill list\` to see available skills.`,
        },
      };
    }
    const dir = findSkillsDir();
    const result = await installSkill(name, dir);
    return { ok: true, data: result };
  };
}
