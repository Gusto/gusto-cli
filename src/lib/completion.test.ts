import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProgram } from "../index.ts";
import { shellSyntaxCheck } from "../../tests/support.ts";
import { describeTree, generateBashCompletion, generateZshCompletion } from "./completion.ts";

// CI Linux runners ship bash but not zsh, so `zsh -n` would ENOENT. Skip the zsh
// syntax check where zsh is absent; it still runs for real on macOS (dev + the macOS
// smoke matrix legs). bash is present everywhere we run.
const HAS_ZSH = Bun.which("zsh") !== null;

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
});

async function bashComplete(script: string, words: string[], cword: number): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "gusto-complete-run-"));
  const file = path.join(dir, "gusto.bash");
  writeFileSync(file, script);
  const compWords = words.map((w) => `'${w}'`).join(" ");
  const driver = `source '${file}'; COMP_WORDS=(${compWords}); COMP_CWORD=${cword}; _gusto; printf '%s\\n' "\${COMPREPLY[@]}"`;
  const proc = Bun.spawn(["bash", "-c", driver], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  return out.split("\n").filter((l) => l.length > 0);
}

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

  test("completes a subcommand after a space-separated required-value flag value", async () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    const reply = await bashComplete(script, ["gusto", "--env", "sandbox", "employee", ""], 4);
    expect(reply).toContain("list");
  });

  test("completes a subcommand after a space-separated optional-value flag value", async () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    const reply = await bashComplete(script, ["gusto", "--fields", "name", "employee", ""], 4);
    expect(reply).toContain("list");
  });

  test("completes top-level commands with no preceding flags", async () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    const reply = await bashComplete(script, ["gusto", ""], 1);
    expect(reply).toContain("employee");
  });
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
