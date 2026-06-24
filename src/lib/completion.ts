import type { Command } from "commander";

export interface CompletionNode {
  /** Command name, e.g. "employee". Root node uses the program name ("gusto"). */
  name: string;
  /** "" for the root, "/employee", "/employee/job" for nested commands. */
  path: string;
  /** Direct child command names. */
  subcommands: string[];
  /** Option flag tokens for this command (long and short), e.g. ["--json", "-v"]. */
  flags: string[];
  /** Positional argument choice values declared on this command. */
  argChoices: string[];
  children: CompletionNode[];
}

export interface FlagChoice {
  flag: string;
  choices: string[];
}

export interface CompletionModel {
  root: CompletionNode;
  /** Flags with static choices, unioned across the whole tree (global flags live at the root). */
  flagChoices: FlagChoice[];
}

export function describeTree(program: Command): CompletionModel {
  const flagChoices: FlagChoice[] = [];
  const seenFlagChoice = new Set<string>();

  function walk(cmd: Command, path: string): CompletionNode {
    const subcommands: string[] = [];
    const children: CompletionNode[] = [];
    for (const sub of cmd.commands) {
      const subName = sub.name();
      subcommands.push(subName);
      children.push(walk(sub, `${path}/${subName}`));
    }

    const flags: string[] = [];
    for (const opt of cmd.options) {
      if (opt.hidden) continue;
      if (opt.short) flags.push(opt.short);
      if (opt.long) flags.push(opt.long);
      if (opt.argChoices && opt.long && !seenFlagChoice.has(opt.long)) {
        seenFlagChoice.add(opt.long);
        flagChoices.push({ flag: opt.long, choices: [...opt.argChoices] });
      }
    }

    const argChoices: string[] = [];
    for (const arg of cmd.registeredArguments) {
      if (arg.argChoices) argChoices.push(...arg.argChoices);
    }

    return { name: cmd.name(), path, subcommands, flags, argChoices, children };
  }

  return { root: walk(program, ""), flagChoices };
}
