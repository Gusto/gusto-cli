import type { Environment } from "../global-flags.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import type { TokenStore } from "./token-store.ts";
import type { StoredSession } from "./types.ts";

export interface Captured {
  urls: string[];
  inits: RequestInit[];
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

/** A fetch mock that replays responses in order (last repeats) and records calls. */
export function mockFetch(responses: MockResponse | MockResponse[]): { fetch: typeof fetch; captured: Captured } {
  const list = Array.isArray(responses) ? responses : [responses];
  const captured: Captured = { urls: [], inits: [] };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.urls.push(url.toString());
    captured.inits.push(init ?? {});
    const r = list[Math.min(captured.urls.length - 1, list.length - 1)];
    if (r === undefined) throw new Error("mockFetch: no response configured");
    const text = r.body !== undefined ? JSON.stringify(r.body) : "";
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, captured };
}

export function formOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

/** OAuthHttpOptions backed by a mockFetch that replays the given responses. */
export function mockHttp(responses: MockResponse | MockResponse[]): OAuthHttpOptions {
  return { baseUrl: "https://api.test", fetchImpl: mockFetch(responses).fetch };
}

export interface MemoryStore extends TokenStore {
  data: Partial<Record<Environment, StoredSession>>;
}

export function memoryStore(initial: Partial<Record<Environment, StoredSession>> = {}): MemoryStore {
  const data: Partial<Record<Environment, StoredSession>> = { ...initial };
  return {
    data,
    load: (env) => Promise.resolve(data[env] ?? null),
    save: (env, session) => {
      data[env] = session;
      return Promise.resolve();
    },
    clear: (env) => {
      delete data[env];
      return Promise.resolve();
    },
  };
}
