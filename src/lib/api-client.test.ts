import { describe, expect, test } from "bun:test";
import { ApiClient, ApiError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";

interface MockResponse {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function mockFetch(captured: { url?: string; init?: RequestInit }, response: MockResponse): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = url.toString();
    captured.init = init;
    const text = response.text ?? (response.body !== undefined ? JSON.stringify(response.body) : "");
    return new Response(text, {
      status: response.status,
      headers: response.headers ?? { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({
    baseUrl: "https://api.example.test",
    token: "test-token",
    apiVersion: "2026-02-01",
    fetchImpl,
  });
}

describe("ApiClient", () => {
  test("GET attaches bearer token + API version headers", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 200, body: { ok: true } }));
    const result = await client.get<{ ok: boolean }>("/v1/me");

    expect(captured.url).toBe("https://api.example.test/v1/me");
    expect(captured.init?.method).toBe("GET");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["X-Gusto-API-Version"]).toBe("2026-02-01");
    expect(result.body.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  test("POST sends a JSON body and the right content-type", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 201, body: { id: "x" } }));
    await client.post("/v1/things", { name: "thing" });

    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(captured.init?.body).toBe(JSON.stringify({ name: "thing" }));
  });

  test("absolute URLs are passed through verbatim", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 200, body: {} }));
    await client.get("https://other.test/path");
    expect(captured.url).toBe("https://other.test/path");
  });

  test("4xx throws ApiError with ApiClient exit code", async () => {
    const client = makeClient(mockFetch({}, { status: 422, body: { error: "validation" } }));
    try {
      await client.get("/v1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(422);
      expect(apiErr.exitCode).toBe(ExitCode.ApiClient);
      expect((apiErr.body as { error: string }).error).toBe("validation");
    }
  });

  test("5xx throws ApiError with ApiServer exit code", async () => {
    const client = makeClient(mockFetch({}, { status: 503, body: { error: "down" } }));
    try {
      await client.get("/v1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).exitCode).toBe(ExitCode.ApiServer);
    }
  });

  test("network failures throw NetworkError with Network exit code", async () => {
    const failingFetch = (async () => {
      throw new Error("dns failure");
    }) as unknown as typeof fetch;
    const client = makeClient(failingFetch);
    try {
      await client.get("/v1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).exitCode).toBe(ExitCode.Network);
    }
  });

  test("empty body responses parse to null", async () => {
    const client = makeClient(mockFetch({}, { status: 204, text: "" }));
    const result = await client.delete("/v1/x");
    expect(result.body).toBeNull();
    expect(result.status).toBe(204);
  });

  test("captures x-request-id from headers when present", async () => {
    const client = makeClient(
      mockFetch(
        {},
        {
          status: 200,
          body: { ok: true },
          headers: { "content-type": "application/json", "x-request-id": "req-123" },
        },
      ),
    );
    const result = await client.get("/v1/x");
    expect(result.requestId).toBe("req-123");
  });

  test("trailing slash in baseUrl is normalized", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = new ApiClient({
      baseUrl: "https://api.example.test/",
      token: "t",
      apiVersion: "2026-02-01",
      fetchImpl: mockFetch(captured, { status: 200, body: {} }),
    });
    await client.get("/v1/me");
    expect(captured.url).toBe("https://api.example.test/v1/me");
  });
});
