import { Argument, type Command } from "commander";
import { describeTree, generateBashCompletion, generateZshCompletion } from "../lib/completion.ts";

const HELP_FOOTER = `
Install (zsh):
  gusto completion zsh > _gusto && source _gusto

Install (bash, Linux):
  gusto completion bash > gusto.bash && source gusto.bash

Install (bash, macOS):
  macOS ships bash 3.2 without programmable completion.
  Run \`brew install bash-completion@2\` and follow its instructions, then:
    gusto completion bash > $(brew --prefix)/etc/bash_completion.d/gusto

fish and PowerShell are not yet supported.
`;

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Print a shell completion script to source (bash or zsh)")
    .addArgument(new Argument("<shell>", "Shell to generate completion for").choices(["bash", "zsh"]))
    .addHelpText("after", HELP_FOOTER)
    .action((shell: "bash" | "zsh") => {
      const model = describeTree(program);
      const script = shell === "bash" ? generateBashCompletion(model) : generateZshCompletion(model);
      process.stdout.write(script);
    });
}
