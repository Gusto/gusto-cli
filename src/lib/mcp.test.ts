import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { callMcpTool } from "./mcp.ts";
import { memoryStore, mockHttp } from "./oauth/test-support.ts";
import { stubGlobalFetch, successEnvelope } from "./test-support.ts";

const sandbox: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };
const prod: GlobalFlags = { ...sandbox, env: "production" };

const noSession = () => ({ store: memoryStore(), http: mockHttp({ status: 200 }) });

const stdinAuth = (tok: string | null = "tok") => ({
  ...noSession(),
  tokenStdin: true,
  readStdin: () => Promise.resolve(tok),
});

const ENV_KEYS = ["GUSTO_ACCESS_TOKEN", "GUSTO_API_BASE_URL", "GUSTO_API_VERSION", "GUSTO_MCP_BASE_URL"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const errorEnvelope = (code: number, message: string, details?: string) => ({
  jsonrpc: "2.0",
  id: 1,
  error: { code, message, ...(details ? { data: { details } } : {}) },
});

describe("callMcpTool — auth", () => {
  test("no token returns no_access_token / Auth exit", async () => {
    const result = await callMcpTool(sandbox, noSession(), "list_time_records", {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("no_access_token");
  });

  test("--token-stdin token flows through to the request's Authorization header", async () => {
    const { calls, restore } = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ source: "none" }) }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth("piped-tok"), "list_time_records", {
        start_date: "2026-06-01",
        end_date: "2026-06-15",
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe("callMcpTool — env routing + envelope", () => {
  test("sandbox env routes to mcp.api.gusto-demo.com", async () => {
    const { calls, restore } = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ source: "none" }) }));
    try {
      await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(calls[0]?.url).toContain("https://mcp.api.gusto-demo.com/");
    } finally {
      restore();
    }
  });

  test("production env routes to mcp.api.gusto.com", async () => {
    const { calls, restore } = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ source: "none" }) }));
    try {
      await callMcpTool(prod, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(calls[0]?.url).toContain("https://mcp.api.gusto.com/");
    } finally {
      restore();
    }
  });

  test("posts a JSON-RPC 2.0 tools/call body with the tool name and arguments", async () => {
    const { calls, restore } = stubGlobalFetch(() => ({ status: 200, body: successEnvelope({ source: "none" }) }));
    try {
      await callMcpTool(sandbox, stdinAuth(), "list_time_records", {
        start_date: "2026-06-01",
        end_date: "2026-06-15",
      });
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.body).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "list_time_records", arguments: { start_date: "2026-06-01", end_date: "2026-06-15" } },
      });
    } finally {
      restore();
    }
  });
});

describe("callMcpTool — success unwrap", () => {
  test("unwraps result.content[0].text and returns the parsed JSON as data", async () => {
    const payload = { source: "third_party", timesheets: [{ id: "ts-1" }] };
    const { restore } = stubGlobalFetch(() => ({ status: 200, body: successEnvelope(payload) }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result).toEqual({ ok: true, data: payload });
    } finally {
      restore();
    }
  });

  test("passes through a structured `result` when the content envelope isn't used", async () => {
    const { restore } = stubGlobalFetch(() => ({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: { source: "none" } },
    }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result).toEqual({ ok: true, data: { source: "none" } });
    } finally {
      restore();
    }
  });

  test("multiple text blocks return an array of parsed payloads", async () => {
    const { restore } = stubGlobalFetch(() => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ source: "third_party" }) },
            { type: "text", text: JSON.stringify({ source: "native" }) },
          ],
        },
      },
    }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result).toEqual({ ok: true, data: [{ source: "third_party" }, { source: "native" }] });
    } finally {
      restore();
    }
  });

  test("non-JSON content text falls back to the raw string", async () => {
    const { restore } = stubGlobalFetch(() => ({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not json" }] } },
    }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result).toEqual({ ok: true, data: "not json" });
    } finally {
      restore();
    }
  });

  test("response with neither result nor error returns mcp_invalid_response", async () => {
    const { restore } = stubGlobalFetch(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1 } }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("mcp_invalid_response");
    } finally {
      restore();
    }
  });

  test("result: null returns mcp_invalid_response instead of crashing", async () => {
    const { restore } = stubGlobalFetch(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: null } }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("mcp_invalid_response");
    } finally {
      restore();
    }
  });
});

describe("callMcpTool — JSON-RPC error mapping", () => {
  const cases: { code: number; expectedCode: string; expectedExit: ExitCodeValue }[] = [
    { code: -32601, expectedCode: "mcp_tool_not_found", expectedExit: ExitCode.Auth },
    { code: -32602, expectedCode: "mcp_invalid_params", expectedExit: ExitCode.ApiClient },
    { code: -32000, expectedCode: "mcp_unauthorized", expectedExit: ExitCode.Auth },
    { code: -32001, expectedCode: "mcp_not_found", expectedExit: ExitCode.ApiClient },
    { code: -32002, expectedCode: "mcp_bad_request", expectedExit: ExitCode.ApiClient },
    { code: -32003, expectedCode: "mcp_rate_limited", expectedExit: ExitCode.Network },
    { code: -32603, expectedCode: "mcp_internal_error", expectedExit: ExitCode.ApiServer },
  ];
  for (const { code, expectedCode, expectedExit } of cases) {
    test(`code ${code} maps to ${expectedCode} / exit ${expectedExit}`, async () => {
      const { restore } = stubGlobalFetch(() => ({ status: 200, body: errorEnvelope(code, "x", "details-here") }));
      try {
        const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error.code).toBe(expectedCode);
        expect(result.exitCode).toBe(expectedExit);
      } finally {
        restore();
      }
    });
  }

  test("rate-limit error includes retryable: true in details", async () => {
    const { restore } = stubGlobalFetch(() => ({ status: 200, body: errorEnvelope(-32003, "slow down", "x") }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.details).toMatchObject({ retryable: true });
    } finally {
      restore();
    }
  });

  test("tool-not-found surfaces remediation guidance (scope grant) in the message", async () => {
    const { restore } = stubGlobalFetch(() => ({
      status: 200,
      body: errorEnvelope(-32601, "Method not found", "Tool not found: list_time_records"),
    }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).toContain("missing the required OAuth scope");
    } finally {
      restore();
    }
  });

  test("empty-string `details` falls back to the higher-level `message` instead of being swallowed", async () => {
    const { restore } = stubGlobalFetch(() => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Missing required parameters", data: { details: "" } },
      },
    }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).toBe("Missing required parameters");
    } finally {
      restore();
    }
  });

  test("unknown RPC code falls back to mcp_error / ApiServer", async () => {
    const { restore } = stubGlobalFetch(() => ({ status: 200, body: errorEnvelope(-99999, "boom") }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("mcp_error");
      expect(result.exitCode).toBe(ExitCode.ApiServer);
    } finally {
      restore();
    }
  });
});

describe("callMcpTool — HTTP-level failures (via ApiClient → toResult)", () => {
  test("HTTP 401 from the MCP gateway flows through ApiClient to an api_client_error envelope", async () => {
    const { restore } = stubGlobalFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.exitCode).toBe(ExitCode.ApiClient);
      expect(result.error.code).toBe("api_client_error");
    } finally {
      restore();
    }
  });

  test("HTTP 5xx from the MCP gateway maps to api_server_error / ApiServer exit", async () => {
    const { restore } = stubGlobalFetch(() => ({ status: 502, body: { error: "bad gateway" } }));
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.exitCode).toBe(ExitCode.ApiServer);
      expect(result.error.code).toBe("api_server_error");
    } finally {
      restore();
    }
  });

  test("a fetch throw (DNS/connection) maps to network_error / Network exit", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    try {
      const result = await callMcpTool(sandbox, stdinAuth(), "list_time_records", { start_date: "x", end_date: "y" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.exitCode).toBe(ExitCode.Network);
      expect(result.error.code).toBe("network_error");
    } finally {
      globalThis.fetch = original;
    }
  });
});
