import { describe, expect, test } from "bun:test";
import {
  DEFAULT_API_VERSION,
  getAccessToken,
  getCompanyUuid,
  resolveApiVersion,
  resolveBaseUrl,
  resolveMcpBaseUrl,
} from "./env.ts";

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
  test("rejects http URL without escape hatch", () => {
    expect(() => resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "http://localhost:3000" })).toThrow(
      "GUSTO_API_BASE_URL must be https:// (set GUSTO_ALLOW_HTTP=1 to allow http for local testing)",
    );
  });
  test("allows http URL when GUSTO_ALLOW_HTTP=1", () => {
    expect(resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "http://localhost:3000", GUSTO_ALLOW_HTTP: "1" })).toBe(
      "http://localhost:3000",
    );
  });
  test("allows http URL when GUSTO_ALLOW_HTTP=true (case-insensitive)", () => {
    expect(resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "http://localhost:3000", GUSTO_ALLOW_HTTP: "TRUE" })).toBe(
      "http://localhost:3000",
    );
  });
  test("allows http URL when GUSTO_ALLOW_HTTP=yes", () => {
    expect(resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "http://localhost:3000", GUSTO_ALLOW_HTTP: "yes" })).toBe(
      "http://localhost:3000",
    );
  });
  test("rejects http URL when GUSTO_ALLOW_HTTP=0", () => {
    expect(() =>
      resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "http://localhost:3000", GUSTO_ALLOW_HTTP: "0" }),
    ).toThrow("GUSTO_API_BASE_URL must be https://");
  });
  test("malformed URL throws an error that names the env var", () => {
    expect(() => resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "not-a-url" })).toThrow(
      "GUSTO_API_BASE_URL is not a valid URL: not-a-url",
    );
  });
  test("rejects non-http schemes even with GUSTO_ALLOW_HTTP=1 (file://)", () => {
    expect(() =>
      resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "file:///etc/passwd", GUSTO_ALLOW_HTTP: "1" }),
    ).toThrow("GUSTO_API_BASE_URL must be https://");
  });
  test("rejects non-http schemes even with GUSTO_ALLOW_HTTP=1 (ftp://)", () => {
    expect(() => resolveBaseUrl(undefined, { GUSTO_API_BASE_URL: "ftp://example.com", GUSTO_ALLOW_HTTP: "1" })).toThrow(
      "GUSTO_API_BASE_URL must be https://",
    );
  });
});

describe("resolveMcpBaseUrl", () => {
  test("defaults to sandbox MCP when env is undefined and no override", () => {
    expect(resolveMcpBaseUrl(undefined, {})).toBe("https://mcp.api.gusto-demo.com");
  });
  test("returns sandbox MCP URL for sandbox env", () => {
    expect(resolveMcpBaseUrl("sandbox", {})).toBe("https://mcp.api.gusto-demo.com");
  });
  test("returns production MCP URL for production env", () => {
    expect(resolveMcpBaseUrl("production", {})).toBe("https://mcp.api.gusto.com");
  });
  test("GUSTO_MCP_BASE_URL overrides both", () => {
    expect(resolveMcpBaseUrl("production", { GUSTO_MCP_BASE_URL: "https://example.test" })).toBe("https://example.test");
  });
  test("rejects http URL without escape hatch", () => {
    expect(() => resolveMcpBaseUrl(undefined, { GUSTO_MCP_BASE_URL: "http://localhost:3000" })).toThrow(
      "GUSTO_MCP_BASE_URL must be https:// (set GUSTO_ALLOW_HTTP=1 to allow http for local testing)",
    );
  });
  test("allows http URL when GUSTO_ALLOW_HTTP=1", () => {
    expect(resolveMcpBaseUrl(undefined, { GUSTO_MCP_BASE_URL: "http://localhost:3000", GUSTO_ALLOW_HTTP: "1" })).toBe(
      "http://localhost:3000",
    );
  });
  test("malformed URL throws an error that names the env var", () => {
    expect(() => resolveMcpBaseUrl(undefined, { GUSTO_MCP_BASE_URL: "not-a-url" })).toThrow(
      "GUSTO_MCP_BASE_URL is not a valid URL: not-a-url",
    );
  });
  test("rejects non-http schemes even with GUSTO_ALLOW_HTTP=1 (file://)", () => {
    expect(() =>
      resolveMcpBaseUrl(undefined, { GUSTO_MCP_BASE_URL: "file:///etc/passwd", GUSTO_ALLOW_HTTP: "1" }),
    ).toThrow("GUSTO_MCP_BASE_URL must be https://");
  });
  test("GUSTO_API_BASE_URL does NOT override the MCP URL (separate env vars)", () => {
    expect(resolveMcpBaseUrl("sandbox", { GUSTO_API_BASE_URL: "https://wrong.test" })).toBe(
      "https://mcp.api.gusto-demo.com",
    );
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
  test("returns null when GUSTO_ACCESS_TOKEN is unset", () => {
    expect(getAccessToken({})).toBeNull();
  });
  test("returns the GUSTO_ACCESS_TOKEN value", () => {
    expect(getAccessToken({ GUSTO_ACCESS_TOKEN: "ENV" })).toBe("ENV");
  });
  test("treats an empty GUSTO_ACCESS_TOKEN as missing", () => {
    expect(getAccessToken({ GUSTO_ACCESS_TOKEN: "" })).toBeNull();
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
