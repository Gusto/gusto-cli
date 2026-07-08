import { describe, expect, test } from "bun:test";
import {
  ApiClient,
  type ApiClientOptions,
  ApiError,
  NetworkError,
  PollFailedError,
  PollTimeoutError,
} from "./api-client.ts";
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

/**
 * Returns a fetch mock that replays a sequence of responses, one per call.
 * After the sequence is exhausted, returns the last response forever.
 * Lets retry tests assert "first call 503, second call 200" cleanly.
 */
function sequenceFetch(responses: MockResponse[]): { fetch: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const impl = (async () => {
    const idx = Math.min(state.calls, responses.length - 1);
    state.calls += 1;
    const response = responses[idx];
    if (response === undefined) throw new Error("sequenceFetch: no response");
    const text = response.text ?? (response.body !== undefined ? JSON.stringify(response.body) : "");
    return new Response(text, {
      status: response.status,
      headers: response.headers ?? { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return Object.assign(state, { fetch: impl }) as { fetch: typeof fetch; calls: number };
}

/**
 * Test defaults: no retry, no sleep, so tests run fast and the existing
 * single-shot assertions still hold. Individual tests opt into retry by
 * overriding maxRetries.
 */
function makeClient(fetchImpl: typeof fetch, overrides: Partial<ApiClientOptions> = {}): ApiClient {
  return new ApiClient({
    baseUrl: "https://api.example.test",
    token: "test-token",
    apiVersion: "2026-02-01",
    fetchImpl,
    maxRetries: 0,
    retrySleepMs: () => 0,
    ...overrides,
  });
}

describe("ApiClient basics", () => {
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

  test("same-origin absolute URLs are passed through", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 200, body: {} }));
    await client.get("https://api.example.test/v1/me?page=2");
    expect(captured.url).toBe("https://api.example.test/v1/me?page=2");
  });

  test("rejects a foreign-origin absolute URL without sending the credential", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 200, body: {} }));
    try {
      await client.get("https://evil.test/steal");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("BlockedDestinationError");
      expect((err as { exitCode: number }).exitCode).toBe(ExitCode.Validation);
    }
    // fetch must never run, so the bearer token never leaves the process.
    expect(captured.url).toBeUndefined();
    expect(captured.init).toBeUndefined();
  });

  test("rejects a protocol-relative path that resolves to a foreign host", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 200, body: {} }));
    await expect(client.get("//evil.test/steal")).rejects.toThrow(/only https:\/\/api\.example\.test is allowed/);
    expect(captured.url).toBeUndefined();
  });

  test("rejects a cleartext-downgrade URL on the configured host", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = makeClient(mockFetch(captured, { status: 200, body: {} }));
    await expect(client.get("http://api.example.test/v1/me")).rejects.toThrow(
      /only https:\/\/api\.example\.test is allowed/,
    );
    expect(captured.url).toBeUndefined();
  });

  test("a blocked destination is not retried", async () => {
    const seq = sequenceFetch([{ status: 200, body: {} }]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    await expect(client.get("https://evil.test/steal")).rejects.toThrow();
    expect(seq.calls).toBe(0);
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

  test("5xx throws ApiError with ApiServer exit code (no retry by default in tests)", async () => {
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

  test("ApiError carries the x-request-id from the failed response", async () => {
    const client = makeClient(
      mockFetch(
        {},
        {
          status: 422,
          body: { errors: ["bad input"] },
          headers: { "content-type": "application/json", "x-request-id": "req-abc" },
        },
      ),
    );
    try {
      await client.post("/v1/x", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).requestId).toBe("req-abc");
    }
  });

  test("trailing slash in baseUrl is normalized", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const client = new ApiClient({
      baseUrl: "https://api.example.test/",
      token: "t",
      apiVersion: "2026-02-01",
      fetchImpl: mockFetch(captured, { status: 200, body: {} }),
      maxRetries: 0,
    });
    await client.get("/v1/me");
    expect(captured.url).toBe("https://api.example.test/v1/me");
  });
});

describe("ApiClient retries (idempotent verbs only)", () => {
  test("GET retries on 5xx and succeeds on a later attempt", async () => {
    const seq = sequenceFetch([
      { status: 503, body: { err: "down" } },
      { status: 502, body: { err: "still down" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    const result = await client.get<{ ok: boolean }>("/v1/x");
    expect(result.status).toBe(200);
    expect(seq.calls).toBe(3);
  });

  test("GET retries on NetworkError and succeeds on a later attempt", async () => {
    let calls = 0;
    const flakyFetch = (async (_url: string | URL | Request) => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = makeClient(flakyFetch, { maxRetries: 3 });
    const result = await client.get<{ ok: boolean }>("/v1/x");
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("GET gives up after maxRetries + 1 attempts on persistent 5xx", async () => {
    const seq = sequenceFetch([{ status: 503, body: { err: "down" } }]);
    const client = makeClient(seq.fetch, { maxRetries: 2 });
    try {
      await client.get("/v1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
      expect(seq.calls).toBe(3); // 1 initial + 2 retries
    }
  });

  test("POST does NOT retry on 5xx (not idempotent)", async () => {
    const seq = sequenceFetch([{ status: 503, body: { err: "down" } }]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    try {
      await client.post("/v1/x", { foo: "bar" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(seq.calls).toBe(1);
    }
  });

  test("PUT does NOT retry on 5xx (not idempotent in our policy)", async () => {
    const seq = sequenceFetch([{ status: 503, body: { err: "down" } }]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    try {
      await client.put("/v1/x", { foo: "bar" });
      throw new Error("should have thrown");
    } catch {
      expect(seq.calls).toBe(1);
    }
  });

  test("GET does NOT retry on 4xx (caller error - retrying won't help)", async () => {
    const seq = sequenceFetch([{ status: 422, body: { err: "validation" } }]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    try {
      await client.get("/v1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect(seq.calls).toBe(1);
    }
  });

  test("DELETE retries on 5xx (idempotent)", async () => {
    const seq = sequenceFetch([
      { status: 503, body: {} },
      { status: 204, text: "" },
    ]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    const result = await client.delete("/v1/x");
    expect(result.status).toBe(204);
    expect(seq.calls).toBe(2);
  });

  test("uses the provided retrySleepMs hook (verifies backoff is plumbed)", async () => {
    const seq = sequenceFetch([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 200, body: { ok: true } },
    ]);
    const sleeps: number[] = [];
    const client = makeClient(seq.fetch, {
      maxRetries: 3,
      retrySleepMs: (attempt) => {
        sleeps.push(attempt);
        return 0;
      },
    });
    await client.get("/v1/x");
    expect(sleeps).toEqual([0, 1]); // sleep before attempts 2 and 3 (zero-indexed)
  });
});

describe("ApiClient request deadline", () => {
  test("does not even attempt once the deadline has already passed", async () => {
    const seq = sequenceFetch([{ status: 200, body: { ok: true } }]);
    const client = makeClient(seq.fetch, { maxRetries: 3 });
    try {
      await client.request("GET", "/v1/x", undefined, { deadline: 0, now: () => 1000 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect(seq.calls).toBe(0);
    }
  });

  test("stops retrying once the deadline is exhausted (does not run the full retry budget)", async () => {
    const seq = sequenceFetch([{ status: 503, body: { err: "down" } }]);
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 100;
      return v;
    };
    const client = makeClient(seq.fetch, { maxRetries: 5, retrySleepMs: () => 0 });
    try {
      await client.request("GET", "/v1/x", undefined, { deadline: 1000, now });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      // Without a deadline this would be maxRetries + 1 = 6 attempts.
      expect(seq.calls).toBeLessThan(6);
    }
  });

  test("succeeds normally when the request completes within the deadline", async () => {
    const client = makeClient(mockFetch({}, { status: 200, body: { ok: true } }));
    const result = await client.request<{ ok: boolean }>("GET", "/v1/x", undefined, { deadline: 9_999_999_999_999 });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });
});

describe("ApiClient.poll", () => {
  const PENDING = { status: 200, body: { status: "Pending" } };
  const succeeded = (extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: { status: "Succeeded", ...extra },
  });

  test("polls until `until` holds and resolves with that response", async () => {
    const seq = sequenceFetch([PENDING, PENDING, succeeded({ report_urls: ["https://x/report.json"] })]);
    const client = makeClient(seq.fetch);
    const result = await client.poll<{ status: string; report_urls?: string[] }>("/v1/reports/r", {
      until: (b) => b.status === "Succeeded",
      isFailure: (b) => b.status === "Failed",
      sleepMs: () => 0,
    });
    expect(result.body.status).toBe("Succeeded");
    expect(result.body.report_urls).toEqual(["https://x/report.json"]);
    expect(seq.calls).toBe(3);
  });

  test("resolves on the first attempt (no sleep) when `until` is already satisfied", async () => {
    const seq = sequenceFetch([succeeded()]);
    const sleeps: number[] = [];
    const client = makeClient(seq.fetch);
    await client.poll<{ status: string }>("/v1/reports/r", {
      until: (b) => b.status === "Succeeded",
      sleepMs: (n) => {
        sleeps.push(n);
        return 0;
      },
    });
    expect(seq.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("rejects with PollFailedError when `isFailure` matches", async () => {
    const seq = sequenceFetch([PENDING, { status: 200, body: { status: "Failed" } }]);
    const client = makeClient(seq.fetch);
    try {
      await client.poll<{ status: string }>("/v1/reports/r", {
        until: (b) => b.status === "Succeeded",
        isFailure: (b) => b.status === "Failed",
        sleepMs: () => 0,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PollFailedError);
      expect((err as PollFailedError).body).toEqual({ status: "Failed" });
      expect(seq.calls).toBe(2);
    }
  });

  test("rejects with PollTimeoutError after maxAttempts without success", async () => {
    const seq = sequenceFetch([PENDING]);
    const client = makeClient(seq.fetch);
    try {
      await client.poll<{ status: string }>("/v1/reports/r", {
        until: (b) => b.status === "Succeeded",
        maxAttempts: 3,
        sleepMs: () => 0,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PollTimeoutError);
      expect((err as PollTimeoutError).exitCode).toBe(ExitCode.Timeout);
      expect((err as PollTimeoutError).attempts).toBe(3);
      expect((err as PollTimeoutError).lastBody).toEqual({ status: "Pending" });
      expect(seq.calls).toBe(3);
    }
  });

  test("rejects with PollTimeoutError once the wall-clock budget is exceeded", async () => {
    const seq = sequenceFetch([PENDING]);
    // Each clock read advances 60s; with a 120s budget the poll cannot run forever.
    let elapsed = 0;
    const now = () => (elapsed += 60_000);
    const client = makeClient(seq.fetch);
    try {
      await client.poll<{ status: string }>("/v1/reports/r", {
        until: (b) => b.status === "Succeeded",
        timeoutMs: 120_000,
        sleepMs: () => 0,
        now,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PollTimeoutError);
    }
  });

  test("sleeps between polls via the injected sleepMs hook", async () => {
    const seq = sequenceFetch([PENDING, PENDING, succeeded()]);
    const sleeps: number[] = [];
    const client = makeClient(seq.fetch);
    await client.poll<{ status: string }>("/v1/reports/r", {
      until: (b) => b.status === "Succeeded",
      sleepMs: (n) => {
        sleeps.push(n);
        return 0;
      },
    });
    // Slept before the 2nd and 3rd attempts (zero-indexed).
    expect(sleeps).toEqual([0, 1]);
  });

  test("a GET aborted at the deadline is reclassified as PollTimeoutError", async () => {
    // Fetch always aborts (timeout-flavored failure). Clock advances 400ms per
    // call: deadline=1000, loop-top check (400) is under it, the GET runs and
    // aborts, and the catch check (1200) is past the deadline.
    const aborting = (async () => {
      throw new DOMException("aborted", "TimeoutError");
    }) as unknown as typeof fetch;
    let t = -400;
    const now = (): number => (t += 400);
    const client = makeClient(aborting, { maxRetries: 0 });
    try {
      await client.poll("/v1/reports/r", { until: () => false, timeoutMs: 1000, now, sleepMs: () => 0 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PollTimeoutError);
    }
  });

  test("a genuine network fault past the deadline is NOT masked as a timeout", async () => {
    // A real connection error (not a timeout) that happens to surface when the
    // clock is already past the deadline must propagate, not become a PollTimeoutError.
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    let t = -400;
    const now = (): number => (t += 400);
    const client = makeClient(failing, { maxRetries: 0 });
    try {
      await client.poll("/v1/reports/r", { until: () => false, timeoutMs: 1000, now, sleepMs: () => 0 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(PollTimeoutError);
      expect((err as NetworkError).message).toContain("ECONNRESET");
    }
  });
});

describe("ApiClient timeout", () => {
  test("times out after timeoutMs and throws NetworkError", async () => {
    // Fetch that resolves only after the abort signal fires.
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = init.signal?.reason;
          if (reason instanceof Error) reject(reason);
          else reject(new DOMException("timed out", "TimeoutError"));
        });
      });
    }) as unknown as typeof fetch;

    const client = makeClient(hangingFetch, { timeoutMs: 20 });
    try {
      await client.get("/v1/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).message).toContain("timed out");
    }
  });
});

describe("ApiClient response headers", () => {
  test("get() surfaces response headers (lowercased)", async () => {
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      token: "tok",
      apiVersion: "2026-02-01",
      fetchImpl: (async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "X-Total-Pages": "3", "X-Page": "1" },
        })) as unknown as typeof fetch,
    });
    const res = await client.get("/v1/things");
    expect(res.headers["x-total-pages"]).toBe("3");
    expect(res.headers["x-page"]).toBe("1");
  });
});
