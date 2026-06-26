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
  /** Flag tokens (long and short) for options that take a value (`<value>` required or `[value]`
   * optional), deduped across the tree. The completion walk skips the token following one of these
   * so a space-separated flag value (e.g. `--env sandbox` or `--fields name`) is not mistaken for a
   * subcommand. Boolean flags are excluded - their following token is a real subcommand. */
  valueFlags: string[];
}

export function describeTree(program: Command): CompletionModel {
  const flagChoices: FlagChoice[] = [];
  const seenFlagChoice = new Set<string>();
  const valueFlags: string[] = [];
  const seenValueFlag = new Set<string>();

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
      if (opt.required || opt.optional) {
        for (const token of [opt.short, opt.long]) {
          if (token && !seenValueFlag.has(token)) {
            seenValueFlag.add(token);
            valueFlags.push(token);
          }
        }
      }
    }

    const argChoices: string[] = [];
    for (const arg of cmd.registeredArguments) {
      if (arg.argChoices) argChoices.push(...arg.argChoices);
    }

    return { name: cmd.name(), path, subcommands, flags, argChoices, children };
  }

  return { root: walk(program, ""), flagChoices, valueFlags };
}

function flatten(node: CompletionNode): CompletionNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

// Every emitted token is a developer-defined command name, flag, or `.choices()` value - never
// user input - so this is a fail-fast guard, not untrusted-input sanitization. A token with a
// shell-significant character would produce a malformed (or, in theory, unsafe) script, so we
// throw at generation time instead. The completion tests run the generators against the real
// program tree, so any offending token is caught before merge rather than shipped.
const SAFE_TOKEN = /^[A-Za-z0-9._:@=/-]+$/;

function assertSafeToken(token: string): string {
  if (!SAFE_TOKEN.test(token)) {
    throw new Error(
      `completion: refusing to emit shell-unsafe token ${JSON.stringify(token)}; allowed characters are A-Z a-z 0-9 . _ : @ = / -`,
    );
  }
  return token;
}

/** Join completion tokens into a space-separated list, validating each is shell-safe. */
function safeJoin(tokens: string[]): string {
  return tokens.map(assertSafeToken).join(" ");
}

/** Words a node can complete: its subcommands, its positional choices, then its flags. */
function candidatesFor(node: CompletionNode): string {
  return safeJoin([...node.subcommands, ...node.argChoices, ...node.flags]);
}

/** Per-shell formatting for the two case statements the generators share. The walk loop and
 * script skeleton stay in each generator below because they are written in different shell
 * dialects (bash `COMP_WORDS`/`COMP_CWORD` vs zsh `words`/`CURRENT`, `compgen` vs `compadd`); only
 * the data-driven case-arm construction is genuinely common, so that is what we factor out here. */
interface ShellDialect {
  pathArm: (path: string, words: string) => string;
  choiceArm: (flag: string, choices: string) => string;
}

function renderArms(
  model: CompletionModel,
  dialect: ShellDialect,
): { pathArms: string; choiceArms: string; valueFlagsList: string } {
  const pathArms = flatten(model.root)
    .map((n) => dialect.pathArm(n.path, candidatesFor(n)))
    .join("\n");
  const choiceArms = model.flagChoices
    .map((c) => dialect.choiceArm(assertSafeToken(c.flag), safeJoin(c.choices)))
    .join("\n");
  return { pathArms, choiceArms, valueFlagsList: safeJoin(model.valueFlags) };
}

const BASH_DIALECT: ShellDialect = {
  pathArm: (path, words) => `    "${path}") opts="${words}" ;;`,
  choiceArm: (flag, choices) => `    ${flag}) COMPREPLY=( $(compgen -W "${choices}" -- "$cur") ); return ;;`,
};

const ZSH_DIALECT: ShellDialect = {
  pathArm: (path, words) => `    "${path}") opts=(${words}) ;;`,
  choiceArm: (flag, choices) => `    ${flag}) compadd ${choices}; return ;;`,
};

export function generateBashCompletion(model: CompletionModel): string {
  const { pathArms, choiceArms, valueFlagsList } = renderArms(model, BASH_DIALECT);

  return `# bash completion for gusto (generated by \`gusto completion bash\`)
# Compatible with bash 3.2 (macOS system bash). On macOS run \`brew install bash-completion@2\`.
_gusto() {
  local cur prev cmd_path i w opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
${choiceArms}
  esac

  local value_flags=" ${valueFlagsList} "
  cmd_path=""
  for (( i=1; i < COMP_CWORD; i++ )); do
    w="\${COMP_WORDS[i]}"
    case "$w" in
      -*)
        case "$value_flags" in
          *" $w "*) i=$(( i + 1 )) ;;
        esac
        continue
        ;;
    esac
    cmd_path="\${cmd_path}/\${w}"
  done

  opts=""
  case "$cmd_path" in
${pathArms}
  esac

  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _gusto gusto
`;
}

export function generateZshCompletion(model: CompletionModel): string {
  const { pathArms, choiceArms, valueFlagsList } = renderArms(model, ZSH_DIALECT);

  return `#compdef gusto
# zsh completion for gusto (generated by \`gusto completion zsh\`)
_gusto() {
  local -a opts
  local cmd_path w
  integer i
  local value_flags=" ${valueFlagsList} "
  cmd_path=""
  for (( i = 2; i < CURRENT; i++ )); do
    w="\${words[i]}"
    case "$w" in
      -*)
        case "$value_flags" in
          *" $w "*) i=$(( i + 1 )) ;;
        esac
        continue
        ;;
    esac
    cmd_path="\${cmd_path}/\${w}"
  done

  case "\${words[CURRENT-1]}" in
${choiceArms}
  esac

  case "$cmd_path" in
${pathArms}
  esac

  compadd -- $opts
}
compdef _gusto gusto
`;
}
