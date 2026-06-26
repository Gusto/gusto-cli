import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import { buildProgram } from "../index.ts";
import { HAS_ZSH, shellSyntaxCheck } from "../../tests/support.ts";
import { describeTree, generateBashCompletion, generateZshCompletion } from "./completion.ts";

function findNode(model: ReturnType<typeof describeTree>, path: string) {
  const stack = [model.root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.path === path) return n;
    stack.push(...n.children);
  }
  return undefined;
}

describe("describeTree", () => {
  test("captures top-level commands as children of the root", () => {
    const model = describeTree(buildProgram());
    expect(model.root.subcommands).toContain("employee");
    expect(model.root.subcommands).toContain("completion");
  });

  test("captures nested subcommands by path", () => {
    const model = describeTree(buildProgram());
    const employee = findNode(model, "/employee");
    expect(employee).toBeDefined();
    expect(employee!.subcommands).toContain("list");
  });

  test("captures global flags on the root node", () => {
    const model = describeTree(buildProgram());
    expect(model.root.flags).toContain("--json");
    expect(model.root.flags).toContain("--env");
  });

  test("captures static flag choices across the tree", () => {
    const model = describeTree(buildProgram());
    const env = model.flagChoices.find((c) => c.flag === "--env");
    expect(env).toBeDefined();
    expect(env!.choices).toEqual(expect.arrayContaining(["sandbox", "production"]));
  });

  test("captures positional argChoices (completion <shell>)", () => {
    const model = describeTree(buildProgram());
    const completion = findNode(model, "/completion");
    expect(completion!.argChoices).toEqual(expect.arrayContaining(["bash", "zsh"]));
  });

  test("captures required-value flags", () => {
    const model = describeTree(buildProgram());
    expect(model.valueFlags).toContain("--env");
  });

  test("captures optional-value flags too (so their value is not read as a subcommand)", () => {
    const model = describeTree(buildProgram());
    // --fields takes an optional value ([list]); its following token must still be skipped.
    expect(model.valueFlags).toContain("--fields");
  });

  test("does not capture boolean flags as value flags", () => {
    const model = describeTree(buildProgram());
    // --json takes no value; the token after it is a real subcommand and must not be skipped.
    expect(model.valueFlags).not.toContain("--json");
  });

  test("excludes hidden options from a node's flags", () => {
    const program = new Command();
    program.name("gusto");
    program
      .command("demo")
      .addOption(new Option("--visible").hideHelp(false))
      .addOption(new Option("--secret").hideHelp());
    const demo = findNode(describeTree(program), "/demo");
    expect(demo!.flags).toContain("--visible");
    expect(demo!.flags).not.toContain("--secret");
  });
});

describe("generateBashCompletion", () => {
  test("emits a valid bash script", async () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    expect(await shellSyntaxCheck("bash", script)).toBe(0);
  });

  test("registers the completion function for gusto", () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    expect(script).toContain("complete -F _gusto gusto");
  });

  test("includes a case arm for a nested command path", () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    expect(script).toContain('"/employee")');
  });

  test("completes static flag choices", () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    expect(script).toContain("sandbox production");
  });
  // Behavioral tests that source the generated script and execute `_gusto` live in the smoke
  // suite (tests/smoke.test.ts), driven off the compiled binary's output - they are integration
  // level, not unit level.
});

describe("generateZshCompletion", () => {
  test.skipIf(!HAS_ZSH)("emits a valid zsh script", async () => {
    const script = generateZshCompletion(describeTree(buildProgram()));
    expect(await shellSyntaxCheck("zsh", script)).toBe(0);
  });

  test("declares the compdef header", () => {
    const script = generateZshCompletion(describeTree(buildProgram()));
    expect(script).toContain("#compdef gusto");
    expect(script).toContain("compdef _gusto gusto");
  });

  test("includes a case arm for a nested command path", () => {
    const script = generateZshCompletion(describeTree(buildProgram()));
    expect(script).toContain('"/employee")');
  });

  test("completes static flag choices", () => {
    const script = generateZshCompletion(describeTree(buildProgram()));
    expect(script).toContain("compadd sandbox production");
  });
});

describe("generator shell-safety guard", () => {
  function programWithChoice(value: string): Command {
    const program = new Command();
    program.name("gusto");
    program.command("demo").addOption(new Option("--mode <mode>").choices(["safe", value]));
    return program;
  }

  test("bash generator throws on a shell-unsafe choice value rather than emitting it", () => {
    const program = programWithChoice('evil"; rm -rf /');
    expect(() => generateBashCompletion(describeTree(program))).toThrow(/shell-unsafe/);
  });

  test("zsh generator throws on a shell-unsafe choice value rather than emitting it", () => {
    const program = programWithChoice("has space");
    expect(() => generateZshCompletion(describeTree(program))).toThrow(/shell-unsafe/);
  });
});
