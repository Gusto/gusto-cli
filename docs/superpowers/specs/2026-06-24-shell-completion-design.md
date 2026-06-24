# Shell completion scripts (bash + zsh)

Ticket: AINT-565 (parent epic AINT-552)

## Goal

Add `gusto completion <bash|zsh>` that prints a completion script the user sources to get
tab completion for `gusto` commands. Stripe, gh, vercel, and supabase all ship this; it is
table stakes for terminal ergonomics.

## Scope

In scope:

- A new top-level `completion` command taking a required positional shell argument (`bash` or `zsh`).
- Completion of subcommand names at every depth (top-level nouns and their verbs, including
  two-level nests like `employee add`).
- Completion of option flags (long and short) for the current command context.
- Completion of static choice values that commander already knows, for both option flags
  (`--env` to `sandbox`/`production`) and positional arguments (`argChoices`).

Out of scope:

- fish and PowerShell. Documented as not yet supported; a follow-up if requested.
- Dynamic value completion that calls the API at tab time (e.g. real company / employee UUIDs).
  This needs auth and network on every keypress and a runtime-callback model we are not building.

## Approach: static-baked generation

`gusto completion zsh` walks the live commander program tree once, at the moment the command
runs, and bakes the full command / flag / choice structure into the emitted script. The script
is self-contained: no callback to the `gusto` binary at tab time, so completion is fast and has
no runtime dependency on the binary being on PATH during completion.

This is distinct from the "static hand-rolled scripts would rot" anti-pattern the ticket warns
against. Nobody hand-writes the command list; it is derived from the actual code. When commands
change, the user re-runs `gusto completion <shell>` to refresh. This is how gh, stripe, and
kubectl ship completions; regeneration is a documented step.

The one residual staleness: a generated script is a snapshot, so a user who upgrades the binary
but does not regenerate will have slightly stale completions until they regenerate. This is
acceptable and standard, and far milder than hand-rolled drift.

## File layout

Follows the existing `commands/` + `lib/` split.

- `src/lib/completion.ts` (pure logic, no I/O):
  - `describeTree(program: Command): CompletionNode` walks the live commander tree into a plain
    serializable shape. At each node: command name, subcommand names, option flags (long + short),
    and any `argChoices` for flags and positional arguments. Global flags are captured at the root.
  - `generateBashCompletion(node: CompletionNode): string` and
    `generateZshCompletion(node: CompletionNode): string` render that tree into a script.
    Pure string in, string out.
- `src/commands/completion.ts`:
  - `registerCompletionCommand(program: Command): void`. Wired last in `buildProgram()` in
    `src/index.ts` so the whole tree exists when its action runs. The action walks `program`
    (its parent), picks the renderer by shell, writes the script raw to stdout, and exits 0.

## Output and error behavior

This command deliberately breaks the normal output pattern in one place.

- Success path bypasses `runner.ts`. The acceptance criteria require
  `gusto completion zsh > _gusto` to produce a source-able script, so stdout must be the raw
  script, never the JSON / human envelope. `--agent`, `--json`, and `--human` do not wrap it.
- Shell validation rides on commander. The shell is a positional argument with
  `.choices(["bash", "zsh"])`, so `gusto completion fish` fails with commander's standard usage
  error and exit code (`CliUsage`), consistent with the rest of the CLI. No custom error code,
  and agents still get a structured failure on stderr.
- No shell auto-detect. The shell argument is required, matching the ticket's `<bash|zsh>`.

## macOS bash 3.2 caveat

Documented, not blocked, via the command's `--help` footer:

```
macOS ships bash 3.2 without programmable completion.
Run `brew install bash-completion@2` and follow its instructions, then:
  gusto completion bash > $(brew --prefix)/etc/bash_completion.d/gusto
zsh and Linux bash need no extra packages.
```

## Testing

- Unit (`src/lib/completion.test.ts`): call the pure generators against a small fixture program
  and against the real `buildProgram()`. Assert that top-level command names appear, that a
  nested verb (`employee add`) appears, and that `--env`'s `sandbox` / `production` choices
  appear in both bash and zsh output.
- Smoke (`tests/smoke.test.ts`): build the binary, run `gusto completion bash` and
  `gusto completion zsh`, write each script to a temp file, and assert `bash -n <file>` and
  `zsh -n <file>` both exit 0. Also assert `gusto completion fish` exits non-zero. `bash -n`
  is pure syntax checking and does not need bash-completion@2, so the macOS caveat does not
  affect the test. Both shells are present in the local and CI environments.

## Acceptance criteria (from ticket)

- `gusto completion zsh > _gusto && source _gusto` enables tab completion for top-level nouns
  and their verbs.
- `gusto completion bash > gusto.bash && source gusto.bash` works on Linux and on macOS with
  bash-completion@2.
- The generated script parses with `bash -n` and `zsh -n`.
