import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerCompletionCommand } from "./completion.ts";

describe("registerCompletionCommand", () => {
  test("registers a completion command that takes a shell argument with choices", () => {
    const program = new Command();
    registerCompletionCommand(program);
    const completion = program.commands.find((c) => c.name() === "completion");
    expect(completion).toBeDefined();
    expect(completion!.registeredArguments[0]?.argChoices).toEqual(["bash", "zsh"]);
  });
});
