import { ApiClient } from "./api-client.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { type StreamSinks, defaultSinks } from "./output.ts";
import type { CommandContext, CommandResult } from "./runner.ts";

export interface CapturedStream {
  buffer: string;
  sink: NodeJS.WritableStream;
}

export function captureStream(): CapturedStream {
  const captured: CapturedStream = {
    buffer: "",
    sink: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal WritableStream stub for tests
      write(chunk: any) {
        captured.buffer += String(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
  };
  return captured;
}

export function captureSinks(): { sinks: StreamSinks; stdout: CapturedStream; stderr: CapturedStream } {
  const stdout = captureStream();
  const stderr = captureStream();
  return { sinks: { stdout: stdout.sink, stderr: stderr.sink }, stdout, stderr };
}

/** Shared command-handler test fixtures. */
export const TEST_GLOBALS: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };
export const TEST_CONTEXT: CommandContext = { command: "test", globals: TEST_GLOBALS, sinks: defaultSinks };
// Just the company override; the access token comes from the ambient env set in
// tests/preload.ts (explicit token wins: stdin > env > session).
export const TEST_AUTH = { companyUuid: "co-1" };

/** JSON-RPC 2.0 success envelope wrapping a single text content block. */
export const successEnvelope = (payload: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
});

/** Unwrap a successful CommandResult's data, throwing if it failed. */
export function okData(result: CommandResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown>;
}

/** The `field`s from a failed CommandResult's blocked_on list. */
export function blockedFields(result: CommandResult): string[] {
  if (result.ok) throw new Error("expected validation failure");
  return (result.error.blocked_on ?? []).map((b) => b.field);
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

/** A routed mock response: serve `MockResponse` on any URL containing `match`. */
export interface Route extends MockResponse {
  match: string;
}

/** Stub global fetch with substring-routed responses. The first route whose `match`
 * the URL contains wins; unmatched URLs return 404. Returns the same `{ calls, restore }`
 * handle as `stubGlobalFetch`; pass the restore to your file's `afterEach`. */
export function routeFetch(routes: Route[]): { calls: RecordedCall[]; restore: () => void } {
  return stubGlobalFetch((u) => routes.find((rt) => u.includes(rt.match)) ?? { status: 404 });
}

/**
 * Stub `globalThis.fetch` for command-handler tests that build their own
 * ApiClient internally (so there's no `fetchImpl` seam to inject).
 *
 * `plan` is either an array replayed one response per call (the last repeats),
 * or a router `(url) => MockResponse` for URL-substring matching. Returns the
 * recorded calls and a `restore()` to put the real fetch back.
 */
export function stubGlobalFetch(plan: MockResponse[] | ((url: string) => MockResponse)): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method: init?.method ?? "GET", url: u, body: bodyStr ? JSON.parse(bodyStr) : undefined });
    const r = Array.isArray(plan) ? (plan[Math.min(calls.length - 1, plan.length - 1)] ?? { status: 200 }) : plan(u);
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : "", {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/**
 * ApiClient backed by a fetch stub that routes by exact `"METHOD /pathname"` and records each call
 * (the pathname lands in `RecordedCall.url`). Returns the client plus the recorded calls. Use for
 * tests that inject an ApiClient via `fetchImpl`; use `stubGlobalFetch` instead for handlers that
 * build their own client internally. Retries are disabled so error paths resolve immediately.
 */
export function stubApiClient(routes: Record<string, [number, unknown]>): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(url.toString());
    const method = init?.method ?? "GET";
    const key = `${method} ${u.pathname}`;
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url: u.pathname, body: bodyStr ? JSON.parse(bodyStr) : undefined });
    const route = routes[key];
    if (!route) throw new Error(`no stub route for ${key}`);
    const [status, body] = route;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new ApiClient({
    baseUrl: "https://api.example.com",
    token: "tok",
    apiVersion: "2026-02-01",
    fetchImpl,
    retrySleepMs: () => 0,
  });
  return { client, calls };
}
