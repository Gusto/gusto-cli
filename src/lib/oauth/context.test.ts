import { describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../global-flags.ts";
import { resolveEnv } from "./context.ts";

const flags = (env?: GlobalFlags["env"]): GlobalFlags => ({
  agent: false,
  human: false,
  json: false,
  verbose: false,
  env,
});

describe("resolveEnv", () => {
  test("returns sandbox when --env sandbox is explicit", () => {
    expect(resolveEnv(flags("sandbox"))).toBe("sandbox");
  });
  test("returns production when --env production is explicit", () => {
    expect(resolveEnv(flags("production"))).toBe("production");
  });
  test("defaults to production when no --env is passed", () => {
    expect(resolveEnv(flags(undefined))).toBe("production");
  });
});
