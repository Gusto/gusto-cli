import type { Command } from "commander";
import type { BlockedOn, EnvelopeError } from "./output.ts";

/** Pointer we route agents to when a read has no first-class command yet. Surfaced in every
 * usage-error envelope so a wrong guess self-heals: the agent falls back to the raw REST hatch. */
export const API_HATCH_HINT = "for a read without a first-class command yet, use: gusto api request GET <path>";

/** Recovery pointer for usage errors that aren't an unknown command (unknown option, excess/missing
 * args). Restores the general help guidance commander used to print after such errors. */
export const USAGE_HELP_HINT = "run `gusto --help` for usage";

/** Largest edit distance we'll still treat as a plausible typo when suggesting a command. Keeps
 * "compant"->"company" (1) and "shwo"->"show" (2) but rejects "blork"->"show" (4). */
const SUGGESTION_MAX_DISTANCE = 3;

/** Levenshtein edit distance (insert/delete/substitute, each cost 1) via the standard single-row
 * dynamic program. Used to rank command suggestions. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** The candidate closest to `input` by edit distance, or undefined when the best match is further
 * than SUGGESTION_MAX_DISTANCE. Ties resolve to the first candidate in `candidates` order. */
export function nearestCommand(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= SUGGESTION_MAX_DISTANCE ? best : undefined;
}

/** Visible subcommand names of `command`, excluding the implicit `help` command. */
function subcommandNames(command: Command): string[] {
  return command.commands.filter((c) => c.name() !== "help").map((c) => c.name());
}

/** Does `token` name `command` (by its name or any alias)? */
function matchesCommand(command: Command, token: string): boolean {
  return command.name() === token || command.aliases().includes(token);
}

/** True when `token` is an option (defined on `command` or the root `program`) that takes a required
 * value in the separate-token form (e.g. `--env <env>`), so the walk must also skip the value that
 * follows it - otherwise that value gets mistaken for a subcommand. Options with an attached value
 * (`--env=sandbox`) are a single token and don't reach here. */
function optionConsumesNextToken(command: Command, root: Command, token: string): boolean {
  const opt = [...command.options, ...root.options].find((o) => o.short === token || o.long === token);
  return opt?.required === true;
}

export interface UnknownCommandDiagnosis {
  /** Space-joined path of the command that expected a subcommand, e.g. "gusto payroll". */
  parent: string;
  /** The token that matched no subcommand of `parent`. */
  token: string;
  /** Subcommand names available on `parent` (help excluded). */
  validCommands: string[];
  /** Nearest valid command when one is close enough, else undefined. */
  didYouMean?: string;
}

/** Walk the program tree against the raw args (already stripped of the node/exe prefix) to find the
 * first positional token that doesn't name a subcommand of the command reached so far. Returns
 * undefined when every token resolves, or when the unresolved token lands on a leaf command (that's
 * excess arguments, not an unknown command). Option tokens (leading "-") are skipped. */
export function diagnoseUnknownCommand(program: Command, args: readonly string[]): UnknownCommandDiagnosis | undefined {
  let current = program;
  const path = [program.name()];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith("-")) {
      if (!token.includes("=") && optionConsumesNextToken(current, program, token)) i++;
      continue;
    }
    const sub = current.commands.find((c) => matchesCommand(c, token));
    if (sub) {
      current = sub;
      path.push(sub.name());
      continue;
    }
    // A leaf command takes positional arguments, not subcommands, so an unmatched token there is an
    // excess-argument error rather than an unknown command - leave it for the generic branch.
    if (current.commands.length === 0) return undefined;
    const validCommands = subcommandNames(current);
    return { parent: path.join(" "), token, validCommands, didYouMean: nearestCommand(token, validCommands) };
  }
  return undefined;
}

/** Map a commander error code (e.g. `commander.unknownOption`) to the snake_case `error.code` used
 * in the agent envelope. Unrecognized codes collapse to the generic `cli_usage`. */
export function usageErrorCode(commanderCode: string | undefined): string {
  switch (commanderCode) {
    case "commander.unknownCommand":
      return "unknown_command";
    case "commander.unknownOption":
      return "unknown_option";
    case "commander.excessArguments":
      return "excess_arguments";
    case "commander.invalidArgument":
      return "invalid_argument";
    default:
      return "cli_usage";
  }
}

/** Extract the argument name(s) from commander's "missing required argument 'x'" message into a
 * blocked_on list. Commander reports one missing arg at a time; the fallback keeps a usable entry if
 * the message wording ever changes. */
function missingArgumentBlockedOn(message: string): BlockedOn[] {
  const names = [...message.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return (names.length > 0 ? names : ["argument"]).map((field) => ({ field, reason: "required" }));
}

/** Commander prefixes its messages with "error: "; drop it so the envelope message reads cleanly. */
function stripErrorPrefix(message: string): string {
  return message.replace(/^error:\s*/i, "");
}

/** Build the `{ok:false}` error envelope for a commander usage error. An unknown-command error gets
 * the rich treatment - the offending command's valid subcommands, a did-you-mean suggestion, and the
 * API-hatch hint (the recovery path when a read has no first-class command yet) - so an agent can
 * self-correct. Other usage errors (unknown option, excess/missing args) get the same structured
 * shape minus the hatch hint, which doesn't fit those cases. */
export function usageErrorEnvelope(
  commanderCode: string | undefined,
  message: string,
  program: Command,
  args: readonly string[],
): EnvelopeError {
  if (commanderCode === "commander.unknownCommand") {
    const diagnosis = diagnoseUnknownCommand(program, args);
    if (diagnosis) {
      return {
        code: "unknown_command",
        message: `unknown command '${diagnosis.token}' for '${diagnosis.parent}'`,
        valid_commands: diagnosis.validCommands,
        ...(diagnosis.didYouMean ? { did_you_mean: diagnosis.didYouMean } : {}),
        hint: API_HATCH_HINT,
      };
    }
  }
  // A missing required positional is the documented blocked_on/exit-7 case (CLAUDE.md), so mirror the
  // handler-level `missingArgs` shape exactly (code "validation" + blocked_on) rather than reporting a
  // commander-specific usage error - agents get one consistent contract for "you left out a field".
  if (commanderCode === "commander.missingArgument") {
    return { code: "validation", message: "missing required arguments", blocked_on: missingArgumentBlockedOn(message) };
  }
  return { code: usageErrorCode(commanderCode), message: stripErrorPrefix(message), hint: USAGE_HELP_HINT };
}
