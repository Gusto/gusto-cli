import { describe, expect, test } from "bun:test";
import { buildProgram } from "./index.ts";

describe("buildProgram", () => {
  test("returns a program with the expected top-level commands", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("company");
    expect(names).toContain("employee");
    expect(names).toContain("config");
  });
});
