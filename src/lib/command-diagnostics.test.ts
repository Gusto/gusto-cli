import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  API_HATCH_HINT,
  USAGE_HELP_HINT,
  diagnoseUnknownCommand,
  levenshtein,
  nearestCommand,
  usageErrorCode,
  usageErrorEnvelope,
} from "./command-diagnostics.ts";

/** A small stand-in for the real program tree: `company {show|get, locations}` and
 * `payroll {list, show}`, so the diagnostics can be exercised without importing index.ts. */
function buildTestProgram(): Command {
  const program = new Command();
  program.name("gusto");
  const company = program.command("company");
  company.command("show").alias("get");
  company.command("locations");
  const payroll = program.command("payroll");
  payroll.command("list");
  payroll.command("show");
  return program;
}

describe("levenshtein", () => {
  test("identical strings have distance 0", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  test("single deletion is distance 1", () => {
    expect(levenshtein("get", "gt")).toBe(1);
  });

  test("a transposition costs two edits", () => {
    expect(levenshtein("show", "shwo")).toBe(2);
  });

  test("single substitution is distance 1", () => {
    expect(levenshtein("company", "compant")).toBe(1);
  });

  test("classic kitten/sitting is distance 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("nearestCommand", () => {
  test("returns the closest candidate within threshold", () => {
    expect(nearestCommand("compant", ["company", "payroll"])).toBe("company");
    expect(nearestCommand("shwo", ["show", "list"])).toBe("show");
  });

  test("returns undefined when nothing is close enough", () => {
    expect(nearestCommand("blork", ["show", "locations"])).toBeUndefined();
  });

  test("an exact match wins", () => {
    expect(nearestCommand("get", ["show", "list", "get"])).toBe("get");
  });

  test("ties resolve to the first candidate in order", () => {
    expect(nearestCommand("ax", ["ay", "az"])).toBe("ay");
  });

  test("no candidates yields undefined", () => {
    expect(nearestCommand("show", [])).toBeUndefined();
  });
});

describe("diagnoseUnknownCommand", () => {
  test("locates an unknown subcommand and lists the valid ones (excluding help)", () => {
    const d = diagnoseUnknownCommand(buildTestProgram(), ["company", "blork"]);
    expect(d).toEqual({
      parent: "gusto company",
      token: "blork",
      validCommands: ["show", "locations"],
      didYouMean: undefined,
    });
  });

  test("suggests a near match via did-you-mean", () => {
    const d = diagnoseUnknownCommand(buildTestProgram(), ["payroll", "shwo"]);
    expect(d?.token).toBe("shwo");
    expect(d?.parent).toBe("gusto payroll");
    expect(d?.didYouMean).toBe("show");
  });

  test("an unknown top-level command reports the program as parent", () => {
    const d = diagnoseUnknownCommand(buildTestProgram(), ["bogus"]);
    expect(d?.parent).toBe("gusto");
    expect(d?.token).toBe("bogus");
    expect(d?.validCommands).toContain("company");
    expect(d?.validCommands).toContain("payroll");
  });

  test("a typo'd top-level command is suggested", () => {
    const d = diagnoseUnknownCommand(buildTestProgram(), ["--json", "compant"]);
    expect(d?.parent).toBe("gusto");
    expect(d?.didYouMean).toBe("company");
  });

  test("an aliased subcommand resolves and yields no diagnosis", () => {
    expect(diagnoseUnknownCommand(buildTestProgram(), ["company", "get"])).toBeUndefined();
  });

  test("excess args on a leaf command are not an unknown command", () => {
    expect(diagnoseUnknownCommand(buildTestProgram(), ["company", "show", "extra"])).toBeUndefined();
  });

  test("options are skipped while walking", () => {
    const d = diagnoseUnknownCommand(buildTestProgram(), ["company", "--verbose", "blork"]);
    expect(d?.token).toBe("blork");
    expect(d?.parent).toBe("gusto company");
  });

  test("the value of a required-value option is not mistaken for the unknown command", () => {
    const program = buildTestProgram();
    program.option("--env <env>", "environment");
    const d = diagnoseUnknownCommand(program, ["--env", "sandbox", "bogus"]);
    expect(d?.token).toBe("bogus");
    expect(d?.parent).toBe("gusto");
  });

  test("an attached option value is a single token and doesn't shift the walk", () => {
    const program = buildTestProgram();
    program.option("--env <env>", "environment");
    const d = diagnoseUnknownCommand(program, ["--env=sandbox", "bogus"]);
    expect(d?.token).toBe("bogus");
  });
});

describe("usageErrorCode", () => {
  test("maps known commander codes to snake_case", () => {
    expect(usageErrorCode("commander.unknownCommand")).toBe("unknown_command");
    expect(usageErrorCode("commander.unknownOption")).toBe("unknown_option");
    expect(usageErrorCode("commander.excessArguments")).toBe("excess_arguments");
    expect(usageErrorCode("commander.missingArgument")).toBe("missing_argument");
    expect(usageErrorCode("commander.invalidArgument")).toBe("invalid_argument");
  });

  test("falls back to cli_usage for anything else", () => {
    expect(usageErrorCode(undefined)).toBe("cli_usage");
    expect(usageErrorCode("commander.somethingNew")).toBe("cli_usage");
  });
});

describe("usageErrorEnvelope", () => {
  test("builds a rich unknown_command envelope with valid_commands, did_you_mean, and the hatch hint", () => {
    const env = usageErrorEnvelope("commander.unknownCommand", "error: unknown command 'shwo'", buildTestProgram(), [
      "payroll",
      "shwo",
    ]);
    expect(env.code).toBe("unknown_command");
    expect(env.message).toBe("unknown command 'shwo' for 'gusto payroll'");
    expect(env.valid_commands).toEqual(["list", "show"]);
    expect(env.did_you_mean).toBe("show");
    expect(env.hint).toBe(API_HATCH_HINT);
  });

  test("omits did_you_mean when nothing is close", () => {
    const env = usageErrorEnvelope("commander.unknownCommand", "error: unknown command 'blork'", buildTestProgram(), [
      "company",
      "blork",
    ]);
    expect(env.code).toBe("unknown_command");
    expect(env.valid_commands).toEqual(["show", "locations"]);
    expect(env.did_you_mean).toBeUndefined();
  });

  test("other usage errors keep their message (prefix stripped), omit the hatch hint, and point at --help", () => {
    const env = usageErrorEnvelope("commander.unknownOption", "error: unknown option '--nope'", buildTestProgram(), [
      "company",
      "show",
      "--nope",
    ]);
    expect(env.code).toBe("unknown_option");
    expect(env.message).toBe("unknown option '--nope'");
    expect(env.valid_commands).toBeUndefined();
    expect(env.hint).toBe(USAGE_HELP_HINT);
  });
});
