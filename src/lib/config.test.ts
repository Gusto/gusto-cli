import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  type ConfigPaths,
  normalizeValue,
  readConfig,
  resetConfig,
  validateKey,
  validateValue,
  writeConfig,
} from "./config.ts";
import { makeScratch, removeScratch } from "./test-support.ts";

let scratch: string;
let paths: ConfigPaths;

beforeEach(() => {
  scratch = makeScratch("gusto-cli-config-");
  paths = { dir: scratch, file: path.join(scratch, "config.toml") };
});

afterEach(() => {
  removeScratch(scratch);
});

describe("validateKey", () => {
  test("accepts known keys", () => {
    expect(validateKey("environment")).toBe("environment");
    expect(validateKey("format")).toBe("format");
    expect(validateKey("skills_auto_install")).toBe("skills_auto_install");
  });
  test("rejects unknown keys", () => {
    expect(validateKey("token")).toBeNull();
    expect(validateKey("")).toBeNull();
  });
});

describe("validateValue", () => {
  test("environment must be sandbox or production", () => {
    expect(validateValue("environment", "sandbox")).toBeNull();
    expect(validateValue("environment", "production")).toBeNull();
    expect(validateValue("environment", "staging")).not.toBeNull();
  });
  test("format accepts agent, human, and the json alias", () => {
    expect(validateValue("format", "agent")).toBeNull();
    expect(validateValue("format", "human")).toBeNull();
    expect(validateValue("format", "json")).toBeNull();
  });
  test("format rejects genuinely invalid values", () => {
    expect(validateValue("format", "bogus")).not.toBeNull();
  });
  test("format error message lists every accepted value including the json alias", () => {
    const msg = validateValue("format", "bogus");
    expect(msg).toContain("agent");
    expect(msg).toContain("human");
    expect(msg).toContain("json");
  });
  test("format rejects Object prototype property names", () => {
    expect(validateValue("format", "toString")).not.toBeNull();
    expect(validateValue("format", "constructor")).not.toBeNull();
    expect(validateValue("format", "hasOwnProperty")).not.toBeNull();
  });
});

describe("normalizeValue", () => {
  test("normalizes the json format alias to agent", () => {
    expect(normalizeValue("format", "json")).toBe("agent");
  });
  test("leaves agent and human untouched", () => {
    expect(normalizeValue("format", "agent")).toBe("agent");
    expect(normalizeValue("format", "human")).toBe("human");
  });
  test("leaves environment values untouched", () => {
    expect(normalizeValue("environment", "sandbox")).toBe("sandbox");
  });
  test("does not treat Object prototype property names as the json alias", () => {
    expect(normalizeValue("format", "toString")).toBe("toString");
  });
  test("skills_auto_install must be ask, always, or never", () => {
    expect(validateValue("skills_auto_install", "ask")).toBeNull();
    expect(validateValue("skills_auto_install", "always")).toBeNull();
    expect(validateValue("skills_auto_install", "never")).toBeNull();
    expect(validateValue("skills_auto_install", "sometimes")).not.toBeNull();
  });
});

describe("read/write/reset", () => {
  test("readConfig returns empty object when file is absent", async () => {
    expect(await readConfig(paths)).toEqual({});
  });

  test("writeConfig + readConfig round-trip", async () => {
    await writeConfig({ environment: "sandbox", format: "agent" }, paths);
    expect(await readConfig(paths)).toEqual({ environment: "sandbox", format: "agent" });
  });

  test("skills_auto_install round-trips and rejects invalid values from disk", async () => {
    await writeConfig({ skills_auto_install: "always" }, paths);
    expect(await readConfig(paths)).toEqual({ skills_auto_install: "always" });
    await Bun.write(paths.file, `skills_auto_install = "sometimes"\n`);
    expect(await readConfig(paths)).toEqual({});
  });

  test("readConfig ignores unknown keys + invalid values", async () => {
    await Bun.write(paths.file, `environment = "staging"\nformat = "agent"\nrogue = "nope"\n`);
    expect(await readConfig(paths)).toEqual({ format: "agent" });
  });

  test("readConfig throws an actionable error naming the file on malformed TOML", async () => {
    await Bun.write(paths.file, `environment = "sandbox\nformat =`);
    expect(readConfig(paths)).rejects.toThrow(/is not valid TOML.*gusto config reset/s);
    expect(readConfig(paths)).rejects.toThrow(paths.file);
  });

  test("writeConfig creates the directory if missing", async () => {
    const nested = { dir: path.join(scratch, "nested"), file: path.join(scratch, "nested", "config.toml") };
    await writeConfig({ environment: "sandbox" }, nested);
    expect(await readConfig(nested)).toEqual({ environment: "sandbox" });
  });

  test("resetConfig removes the file", async () => {
    await writeConfig({ environment: "sandbox" }, paths);
    expect(await readConfig(paths)).toEqual({ environment: "sandbox" });
    await resetConfig(paths);
    expect(await readConfig(paths)).toEqual({});
  });

  test("resetConfig on a missing file is a no-op", async () => {
    await resetConfig(paths);
    expect(await readConfig(paths)).toEqual({});
  });
});
