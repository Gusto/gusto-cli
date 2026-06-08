import { describe, expect, test } from "bun:test";
import { readGlobalFlags } from "./global-flags.ts";

describe("readGlobalFlags", () => {
  test("coerces missing flags to false", () => {
    const flags = readGlobalFlags({});
    expect(flags.agent).toBe(false);
    expect(flags.human).toBe(false);
    expect(flags.json).toBe(false);
    expect(flags.verbose).toBe(false);
    expect(flags.env).toBeUndefined();
  });

  test("passes through truthy flags", () => {
    const flags = readGlobalFlags({ agent: true, verbose: true, env: "sandbox" });
    expect(flags.agent).toBe(true);
    expect(flags.verbose).toBe(true);
    expect(flags.env).toBe("sandbox");
  });

  test("treats non-true values as false", () => {
    const flags = readGlobalFlags({ agent: "yes", json: 1 });
    expect(flags.agent).toBe(false);
    expect(flags.json).toBe(false);
  });

  test("parses --fields <list> into a select selection", () => {
    expect(readGlobalFlags({ fields: "uuid, email ,name" }).fields).toEqual({
      mode: "select",
      keys: ["uuid", "email", "name"],
    });
  });

  test("dedupes repeated fields in a select selection", () => {
    expect(readGlobalFlags({ fields: "uuid,uuid,email" }).fields).toEqual({ mode: "select", keys: ["uuid", "email"] });
  });

  test("treats --fields with no value as a discover selection", () => {
    expect(readGlobalFlags({ fields: true }).fields).toEqual({ mode: "discover" });
  });

  test("treats --fields with a blank value as discover", () => {
    expect(readGlobalFlags({ fields: "" }).fields).toEqual({ mode: "discover" });
    expect(readGlobalFlags({ fields: "  ,  " }).fields).toEqual({ mode: "discover" });
  });

  test("leaves fields undefined when the flag is absent", () => {
    expect(readGlobalFlags({}).fields).toBeUndefined();
  });
});
