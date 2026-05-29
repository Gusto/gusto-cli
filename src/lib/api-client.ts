import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly exitCode: ExitCodeValue;

  constructor(status: number, body: unknown, exitCode: ExitCodeValue, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.exitCode = exitCode;
  }
}

export class NetworkError extends Error {
  readonly exitCode: ExitCodeValue = ExitCode.Network;
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
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

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "X-Gusto-API-Version": this.apiVersion,
    };
    let init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init = { ...init, body: JSON.stringify(body) };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`network error calling ${method} ${url}: ${msg}`);
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text();
    const parsed: unknown = text.length === 0 ? null : safeParseJson(text);

    if (response.ok) {
      return { status: response.status, body: parsed as T, requestId };
    }

    const exitCode = response.status >= 500 ? ExitCode.ApiServer : ExitCode.ApiClient;
    throw new ApiError(response.status, parsed, exitCode, `${method} ${url} -> ${response.status}`);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
