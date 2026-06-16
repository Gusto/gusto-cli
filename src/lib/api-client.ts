import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly exitCode: ExitCodeValue;
  readonly requestId?: string;

  constructor(status: number, body: unknown, exitCode: ExitCodeValue, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.exitCode = exitCode;
    this.requestId = requestId;
  }
}

export class NetworkError extends Error {
  readonly exitCode: ExitCodeValue = ExitCode.Network;
  /** True when the failure is a request timeout / deadline abort (vs. a
   * connection-level error like DNS failure or connection reset). `poll()` only
   * reclassifies timeout-flavored failures so it can't mask a real network fault. */
  readonly timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.name = "NetworkError";
    this.timedOut = timedOut;
  }
}

/** Thrown before any request is sent when a path resolves to an origin other
 * than the configured API base URL. Blocks SSRF and stops the bearer credential
 * from being attached to a request bound for a non-Gusto host (a documented risk
 * of the agent-facing `gusto api request` escape hatch). Carries `Validation` so
 * callers report it as bad input rather than a network/server fault. */
export class BlockedDestinationError extends Error {
  readonly exitCode: ExitCodeValue = ExitCode.Validation;
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

/** Thrown by `poll()` when the success predicate never holds within the
 * configured time / attempt budget. Carries the last response body so callers
 * can report the terminal status (and any resumable request id). */
export class PollTimeoutError extends Error {
  readonly exitCode: ExitCodeValue = ExitCode.Timeout;
  readonly attempts: number;
  readonly lastBody: unknown;
  constructor(message: string, attempts: number, lastBody: unknown) {
    super(message);
    this.name = "PollTimeoutError";
    this.attempts = attempts;
    this.lastBody = lastBody;
  }
}

/** Thrown by `poll()` when the failure predicate matches a response, i.e. the
 * polled operation reached a terminal failed state. */
export class PollFailedError extends Error {
  readonly exitCode: ExitCodeValue = ExitCode.ApiServer;
  readonly body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.name = "PollFailedError";
    this.body = body;
  }
}

export interface RequestOptions {
  /** Absolute wall-clock deadline (ms, same epoch as `now`). When set, the retry
   * backoff and the per-request abort timeout are both capped so a request can
   * never run past it. Used by `poll()` to honor `--timeout` exactly. */
  deadline?: number;
  /** Clock source (ms); injectable for deterministic deadline tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface PollOptions<T> {
  /** Terminal-success predicate. `poll()` resolves with the first response whose body satisfies it. */
  until: (body: T) => boolean;
  /** Terminal-failure predicate. When a body satisfies it, `poll()` rejects with `PollFailedError`. */
  isFailure?: (body: T) => boolean;
  /** Overall wall-clock budget in ms before `PollTimeoutError`. Default 120000. */
  timeoutMs?: number;
  /** Hard cap on GET attempts before `PollTimeoutError`. Optional; complements `timeoutMs`. */
  maxAttempts?: number;
  /** Sleep duration (ms) before poll attempt `n` (zero-indexed). Override in tests to skip waits. */
  sleepMs?: (attempt: number) => number;
  /** Clock source (ms); injectable for deterministic timeout tests. Defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const IDEMPOTENT_METHODS = new Set(["GET", "DELETE"]);

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Sleep duration (ms) before retry attempt `n` (zero-indexed). Override in tests to skip waits. */
  retrySleepMs?: (attempt: number) => number;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  requestId?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retrySleepMs: (attempt: number) => number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    // Exponential backoff: 1s, 2s, 4s, 8s. Tests override to skip waits.
    this.retrySleepMs = opts.retrySleepMs ?? ((attempt) => 2 ** attempt * 1000);
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, undefined, opts);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  put<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", path, body);
  }

  delete<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", path);
  }

  /** GET `path` repeatedly until `until` holds (resolves with that response),
   * `isFailure` holds (rejects with `PollFailedError`), or the time / attempt
   * budget is exhausted (rejects with `PollTimeoutError`). Sleeps a fixed
   * `DEFAULT_POLL_INTERVAL_MS` between attempts unless `sleepMs` overrides it.
   * The wall-clock deadline is threaded into each GET so the inner retry loop
   * and per-request timeout can't overshoot it. Used for async report
   * generation (general ledger). */
  async poll<T = unknown>(path: string, options: PollOptions<T>): Promise<ApiResponse<T>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const sleepMs = options.sleepMs ?? (() => DEFAULT_POLL_INTERVAL_MS);
    const now = options.now ?? (() => Date.now());

    const deadline = Number.isFinite(timeoutMs) ? now() + timeoutMs : undefined;
    const timedOut = (attempt: number, lastBody: unknown): PollTimeoutError =>
      new PollTimeoutError(`poll: ${path} did not succeed within ${timeoutMs}ms`, attempt, lastBody);

    let attempt = 0;
    let lastBody: unknown;

    for (;;) {
      if (deadline !== undefined && now() >= deadline) {
        throw timedOut(attempt, lastBody);
      }

      let response: ApiResponse<T>;
      try {
        response = await this.get<T>(path, { deadline, now });
      } catch (err) {
        // Reclassify ONLY a deadline-driven timeout/abort as a poll timeout. A
        // genuine network fault (DNS, connection reset) or API error propagates
        // unchanged, even if the clock is past the deadline, so we never mask
        // the real root cause behind a "did not finish before timeout" message.
        if (deadline !== undefined && err instanceof NetworkError && err.timedOut && now() >= deadline) {
          throw timedOut(attempt, lastBody);
        }
        throw err;
      }
      attempt += 1;
      lastBody = response.body;

      if (options.isFailure?.(response.body)) {
        throw new PollFailedError(`poll: ${path} reached a terminal failed state`, response.body);
      }
      if (options.until(response.body)) {
        return response;
      }
      if (options.maxAttempts !== undefined && attempt >= options.maxAttempts) {
        throw new PollTimeoutError(`poll: ${path} did not succeed within ${attempt} attempts`, attempt, lastBody);
      }

      // Clamp the inter-poll sleep to the remaining budget; if none remains the
      // next iteration's deadline check throws immediately.
      let wait = sleepMs(attempt - 1);
      if (deadline !== undefined) wait = Math.min(wait, Math.max(0, deadline - now()));
      await sleep(wait);
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());
    const now = opts.now ?? (() => Date.now());
    const { deadline } = opts;
    let lastError: ApiError | NetworkError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        let backoff = this.retrySleepMs(attempt - 1);
        if (deadline !== undefined) {
          const remaining = deadline - now();
          // Out of budget: surface the real error we already saw, else a
          // timeout-flavored error so poll() can classify it as a timeout.
          if (remaining <= 0) throw lastError ?? this.deadlineError(method, path);
          backoff = Math.min(backoff, remaining);
        }
        await sleep(backoff);
      }

      // Cap each attempt's timeout by the remaining budget so a single in-flight
      // request can never overshoot the deadline.
      let perRequestTimeout = this.timeoutMs;
      if (deadline !== undefined) {
        const remaining = deadline - now();
        if (remaining <= 0) throw lastError ?? this.deadlineError(method, path);
        perRequestTimeout = Math.min(this.timeoutMs, remaining);
      }

      try {
        return await this.sendOnce<T>(method, path, body, perRequestTimeout);
      } catch (err) {
        if (err instanceof ApiError && err.status >= 500 && isIdempotent) {
          lastError = err;
          continue;
        }
        if (err instanceof NetworkError && isIdempotent) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new NetworkError(`request failed after ${this.maxRetries + 1} attempts`);
  }

  /** A timeout-flavored NetworkError for when the request budget (deadline) is
   * exhausted before a response. Marked `timedOut` so `poll()` treats it as a
   * timeout rather than a connection failure. */
  private deadlineError(method: string, path: string): NetworkError {
    return new NetworkError(`request deadline exceeded calling ${method} ${path}`, true);
  }

  /** Resolve `path` against the configured base URL and confirm it stays on the
   * same origin (scheme + host + port). Relative paths, same-origin absolute
   * URLs, and protocol-relative paths that resolve back to the base host are
   * allowed; anything pointing elsewhere - a foreign host, a `//other` redirect,
   * or an `http://` downgrade of an `https` host - is rejected before the bearer
   * credential can be attached. */
  private resolveUrl(path: string): string {
    const base = new URL(this.baseUrl);
    let resolved: URL;
    try {
      resolved = new URL(path, base);
    } catch {
      throw new BlockedDestinationError(`invalid request path: ${path}`);
    }
    if (resolved.origin !== base.origin) {
      throw new BlockedDestinationError(
        `refusing to send credentialed request to ${resolved.origin}; only ${base.origin} is allowed`,
      );
    }
    return resolved.toString();
  }

  private async sendOnce<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<ApiResponse<T>> {
    const url = this.resolveUrl(path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "X-Gusto-API-Version": this.apiVersion,
    };
    let init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init = { ...init, body: JSON.stringify(body) };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new NetworkError(`request timed out after ${timeoutMs}ms calling ${method} ${url}`, true);
      }
      throw new NetworkError(`network error calling ${method} ${url}: ${msg}`);
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text();
    const parsed: unknown = text.length === 0 ? null : safeParseJson(text);

    if (response.ok) {
      return { status: response.status, body: parsed as T, requestId };
    }

    const exitCode = response.status >= 500 ? ExitCode.ApiServer : ExitCode.ApiClient;
    throw new ApiError(response.status, parsed, exitCode, `${method} ${url} -> ${response.status}`, requestId);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
