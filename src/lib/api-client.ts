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
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
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

  get<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path);
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

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());
    let lastError: ApiError | NetworkError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.retrySleepMs(attempt - 1));
      }

      try {
        return await this.sendOnce<T>(method, path, body);
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

  private async sendOnce<T>(method: string, path: string, body: unknown): Promise<ApiResponse<T>> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "X-Gusto-API-Version": this.apiVersion,
    };
    let init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
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
        throw new NetworkError(`request timed out after ${this.timeoutMs}ms calling ${method} ${url}`);
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
