import { describe, expect, test } from "bun:test";
import { buildProgram } from "../index.ts";
import { describeTree } from "./completion.ts";

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
