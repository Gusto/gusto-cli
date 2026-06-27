import type { Command } from "commander";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";
import { findSkillsDir, getSkill, getSkillStatus, installSkill, listSkills, type SkillsDir } from "../lib/skills.ts";

interface SkillInstallOpts {
  all?: boolean;
}

export function registerSkillCommand(parent: Command): void {
  const cmd = parent.command("skill").description("List and install bundled skills");

  cmd
    .command("list")
    .description("Show bundled skills available to install")
    .action(() => runReadCommand("gusto skill list", readGlobalFlags(parent.opts()), skillListHandler()));

  cmd
    .command("install [name]")
    .description("Install a bundled skill (or --all) into .claude / .cursor / .windsurf skills directory")
    .option("--all", "Install every bundled skill")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto skill install cash-forecasting
  $ gusto skill install --all

The skill is installed into the first of .claude/skills, .cursor/skills,
or .windsurf/skills found by walking up from the current directory. Falls
back to ~/.claude/skills. For .claude targets, the SKILL.md frontmatter
is augmented with user-invocable: true so the skill appears as a slash
command in Claude Code.
`,
    )
    .action((name: string | undefined, opts: SkillInstallOpts) =>
      runCommand("gusto skill install", readGlobalFlags(parent.opts()), skillInstallHandler(name, opts)),
    );
}

export function skillListHandler(dir: SkillsDir = findSkillsDir()): CommandHandler {
  return async () => {
    const skills = await Promise.all(
      listSkills().map(async ({ name, description }) => ({
        name,
        description,
        status: await getSkillStatus(name, dir),
      })),
    );
    return { ok: true, data: { skills } };
  };
}

export function skillInstallHandler(
  name: string | undefined,
  opts: SkillInstallOpts = {},
  dir: SkillsDir = findSkillsDir(),
): CommandHandler {
  return async () => {
    if (opts.all && name) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "ambiguous_install",
          message: "Pass either a skill name or --all, not both.",
        },
      };
    }
    if (opts.all) {
      const results = [];
      for (const skill of listSkills()) {
        results.push(await installSkill(skill.name, dir));
      }
      return { ok: true, data: { skills: results } };
    }
    if (!name) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "missing_skill_name",
          message: "Pass a skill name or --all. Run `gusto skill list` to see available skills.",
        },
      };
    }
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
    const result = await installSkill(name, dir);
    return { ok: true, data: result };
  };
}
