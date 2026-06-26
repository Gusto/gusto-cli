import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerCompletionCommand } from "./completion.ts";

/** Run the completion command's action, capturing what it writes to stdout. */
async function captureCompletion(shell: string): Promise<string> {
  const program = new Command();
  program.name("gusto");
  program.exitOverride();
  registerCompletionCommand(program);
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // Spy on stdout: the action writes the raw script directly (bypassing the runner envelope).
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["node", "gusto", "completion", shell]);
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("registerCompletionCommand", () => {
  test("registers a completion command that takes a shell argument with choices", () => {
    const program = new Command();
    registerCompletionCommand(program);
    const completion = program.commands.find((c) => c.name() === "completion");
    expect(completion).toBeDefined();
    expect(completion!.registeredArguments[0]?.argChoices).toEqual(["bash", "zsh"]);
  });

  test("the action writes the bash script to stdout for `completion bash`", async () => {
    const out = await captureCompletion("bash");
    expect(out).toContain("complete -F _gusto gusto");
  });

  test("the action writes the zsh script to stdout for `completion zsh`", async () => {
    const out = await captureCompletion("zsh");
    expect(out).toContain("#compdef gusto");
  });
});
