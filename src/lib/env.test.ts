import { describe, expect, test } from "bun:test";
import { DEFAULT_API_VERSION, getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";

describe("resolveBaseUrl", () => {
  test("defaults to sandbox when env is undefined and no override", () => {
    expect(resolveBaseUrl(undefined, {})).toBe("https://api.gusto-demo.com");
  });
  test("returns sandbox URL for sandbox env", () => {
    expect(resolveBaseUrl("sandbox", {})).toBe("https://api.gusto-demo.com");
  });
  test("returns production URL for production env", () => {
    expect(resolveBaseUrl("production", {})).toBe("https://api.gusto.com");
  });
  test("GUSTO_API_BASE_URL overrides both", () => {
    expect(resolveBaseUrl("production", { GUSTO_API_BASE_URL: "https://example.test" })).toBe("https://example.test");
  });
});

describe("resolveApiVersion", () => {
  test("defaults to DEFAULT_API_VERSION", () => {
    expect(resolveApiVersion({})).toBe(DEFAULT_API_VERSION);
  });
  test("GUSTO_API_VERSION overrides", () => {
    expect(resolveApiVersion({ GUSTO_API_VERSION: "2026-06-15" })).toBe("2026-06-15");
  });
});

describe("getAccessToken", () => {
  test("returns null when neither override nor env is set", () => {
    expect(getAccessToken(undefined, {})).toBeNull();
  });
  test("override beats env", () => {
    expect(getAccessToken("OVERRIDE", { GUSTO_ACCESS_TOKEN: "ENV" })).toBe("OVERRIDE");
  });
  test("falls back to env when no override", () => {
    expect(getAccessToken(undefined, { GUSTO_ACCESS_TOKEN: "ENV" })).toBe("ENV");
  });
  test("treats empty string as missing", () => {
    expect(getAccessToken("", { GUSTO_ACCESS_TOKEN: "" })).toBeNull();
  });
});

describe("getCompanyUuid", () => {
  test("override beats env", () => {
    expect(getCompanyUuid("OVERRIDE", { GUSTO_COMPANY_UUID: "ENV" })).toBe("OVERRIDE");
  });
  test("returns null when both empty", () => {
    expect(getCompanyUuid(undefined, {})).toBeNull();
  });
});
