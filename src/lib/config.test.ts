import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConfigPaths, readConfig, resetConfig, validateKey, validateValue, writeConfig } from "./config.ts";

let scratch: string;
let paths: ConfigPaths;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-config-"));
  paths = { dir: scratch, file: path.join(scratch, "config.toml") };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("validateKey", () => {
  test("accepts known keys", () => {
    expect(validateKey("environment")).toBe("environment");
    expect(validateKey("format")).toBe("format");
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
  test("format must be agent or human", () => {
    expect(validateValue("format", "agent")).toBeNull();
    expect(validateValue("format", "human")).toBeNull();
    expect(validateValue("format", "json")).not.toBeNull();
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

  test("readConfig ignores unknown keys + invalid values", async () => {
    await Bun.write(paths.file, `environment = "staging"\nformat = "agent"\nrogue = "nope"\n`);
    expect(await readConfig(paths)).toEqual({ format: "agent" });
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
