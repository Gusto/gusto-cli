import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProgram } from "../index.ts";
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
});

async function syntaxCheck(shell: "bash" | "zsh", script: string): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), "gusto-completion-"));
  const file = path.join(dir, shell === "bash" ? "gusto.bash" : "_gusto");
  writeFileSync(file, script);
  const proc = Bun.spawn([shell, "-n", file], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  return code;
}

describe("generateBashCompletion", () => {
  test("emits a valid bash script", async () => {
    const script = generateBashCompletion(describeTree(buildProgram()));
    expect(await syntaxCheck("bash", script)).toBe(0);
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
});

describe("generateZshCompletion", () => {
  test("emits a valid zsh script", async () => {
    const script = generateZshCompletion(describeTree(buildProgram()));
    expect(await syntaxCheck("zsh", script)).toBe(0);
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
