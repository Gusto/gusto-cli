import { describe, expect, test } from "bun:test";
import { ApiError, BlockedDestinationError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { partialFailure, toResult } from "./handle-api-error.ts";
import { OAuthError } from "./oauth/endpoints.ts";

describe("toResult", () => {
  test("4xx ApiError maps to api_client_error and carries body + request_id", () => {
    const err = new ApiError(422, { errors: ["bad email"] }, ExitCode.ApiClient, "Unprocessable", "req-123");
    const result = toResult(err);
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.ApiClient,
      error: {
        code: "api_client_error",
        message: "Unprocessable",
        details: { errors: ["bad email"] },
        request_id: "req-123",
      },
    });
  });

  test("5xx ApiError maps to api_server_error", () => {
    const err = new ApiError(500, null, ExitCode.ApiServer, "Server blew up");
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
    expect(result.error.code).toBe("api_server_error");
    // null body is omitted, not emitted as details: null
    expect("details" in result.error).toBe(false);
    expect("request_id" in result.error).toBe(false);
  });

  test("NetworkError maps to network_error with the network exit code", () => {
    const err = new NetworkError("connection refused");
    const result = toResult(err);
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Network,
      error: { code: "network_error", message: "connection refused" },
    });
  });

  test("BlockedDestinationError maps to blocked_destination with the validation exit code", () => {
    const err = new BlockedDestinationError(
      "refusing to send credentialed request to https://evil.test; only https://api.gusto.com is allowed",
    );
    const result = toResult(err);
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: {
        code: "blocked_destination",
        message: "refusing to send credentialed request to https://evil.test; only https://api.gusto.com is allowed",
      },
    });
  });

  test("unknown Error falls back to internal_error / general exit code", () => {
    const result = toResult(new Error("boom"));
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.General,
      error: { code: "internal_error", message: "boom" },
    });
  });

  test("non-Error throwable is stringified", () => {
    const result = toResult("just a string");
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.General,
      error: { code: "internal_error", message: "just a string" },
    });
  });
});

describe("toResult 403 scope handling", () => {
  test("insufficient_scope 403 maps to a scope remediation message", () => {
    const err = new ApiError(
      403,
      { error: "insufficient_scope", scope: "employees:manage" },
      ExitCode.ApiClient,
      "POST /v1/companies/x/employees -> 403",
    );
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.message).toContain("employees:manage");
    expect(result.error.message).toContain("gusto auth login");
  });

  test("the real Gusto missing_oauth_scopes 403 body maps to insufficient_scope", () => {
    // Actual demo-API body shape, captured from a scope-narrowed `employee add`.
    const err = new ApiError(
      403,
      {
        errors: [
          {
            error_key: "request",
            category: "missing_oauth_scopes",
            message:
              "You do not have the necessary OAuth scopes for this request. Please reach out to developer@gusto.com for assistance.",
          },
        ],
      },
      ExitCode.ApiClient,
      "POST /v1/companies/x/employees -> 403",
    );
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.message).toContain("gusto auth login");
  });

  test("a non-scope 403 still flows through as a client error", () => {
    const err = new ApiError(403, { error: "forbidden" }, ExitCode.ApiClient, "GET /v1/companies/x -> 403");
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("api_client_error");
  });

  test("an unrelated errors-array 403 is not mistaken for a scope problem", () => {
    const err = new ApiError(
      403,
      { errors: [{ error_key: "request", category: "forbidden", message: "nope" }] },
      ExitCode.ApiClient,
      "GET /v1/companies/x -> 403",
    );
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("api_client_error");
  });
});

describe("toResult OAuthError handling", () => {
  test("a 4xx OAuthError surfaces the response body + request_id instead of collapsing to internal_error", () => {
    const err = new OAuthError(
      400,
      { error: "invalid_grant", error_description: "auth code already redeemed" },
      "/v1/mcp/oauth/token -> 400",
      "req-abc",
    );
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.code).toBe("oauth_client_error");
    expect(result.error.message).toBe("/v1/mcp/oauth/token -> 400");
    expect(result.error.details).toEqual({
      error: "invalid_grant",
      error_description: "auth code already redeemed",
    });
    expect(result.error.request_id).toBe("req-abc");
  });

  test("a 5xx OAuthError maps to oauth_server_error / api_server exit code", () => {
    const err = new OAuthError(503, { error: "temporarily_unavailable" }, "/v1/mcp/oauth/token -> 503");
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
    expect(result.error.code).toBe("oauth_server_error");
  });

  test("a status-0 OAuthError (network failure inside the OAuth client) maps to network_error", () => {
    const err = new OAuthError(0, null, "network error calling /v1/mcp/oauth/token: ECONNREFUSED");
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Network);
    expect(result.error.code).toBe("network_error");
  });

  test("an OAuthError without a body omits details (no `details: null` noise)", () => {
    const err = new OAuthError(400, null, "/v1/mcp/oauth/token -> 400");
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect("details" in result.error).toBe(false);
  });
});

describe("partialFailure", () => {
  test("ApiError: classifies via toResult, appends the error message, nests the body under failed.error", () => {
    const err = new ApiError(422, { errors: ["nope"] }, ExitCode.ApiClient, "PUT /x -> 422");
    const result = partialFailure({
      code: "bank_verification_failed",
      message: "bank account created but verify failed",
      err,
      completed: { bank_account: "ba-1" },
      failedDomain: "verify",
    });
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.ApiClient,
      error: {
        code: "bank_verification_failed",
        message: "bank account created but verify failed: PUT /x -> 422",
        details: {
          bank_account: "ba-1",
          completed: ["bank_account"],
          // The server's 422 body is preserved (structured) under failed.error.details.
          failed: {
            domain: "verify",
            error: { code: "api_client_error", message: "PUT /x -> 422", details: { errors: ["nope"] } },
          },
        },
      },
    });
  });

  test("5xx ApiError carries its server exitCode", () => {
    const err = new ApiError(500, { e: 1 }, ExitCode.ApiServer, "PUT /x -> 500");
    const result = partialFailure({
      code: "c",
      message: "m",
      err,
      completed: { job: { uuid: "j-1" } },
      failedDomain: "compensation",
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
  });

  test("lists every completed domain and echoes its data", () => {
    const err = new ApiError(422, null, ExitCode.ApiClient, "PUT /x -> 422");
    const result = partialFailure({
      code: "c",
      message: "m",
      err,
      completed: { job: { uuid: "j-1" }, bank_account: "ba-1" },
      failedDomain: "payment_method",
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({
      job: { uuid: "j-1" },
      bank_account: "ba-1",
      completed: ["job", "bank_account"],
      failed: { domain: "payment_method", error: { code: "api_client_error", message: "PUT /x -> 422" } },
    });
  });

  test("NetworkError keeps its network exit code (matches toResult), not General", () => {
    // A follow-up-step network failure (e.g. /verify timing out) must classify
    // the same as a first-step one through toResult - both exit Network.
    const err = new NetworkError("connection reset");
    const result = partialFailure({
      code: "bank_verification_failed",
      message: "bank account created but verify failed",
      err,
      completed: { bank_account: "ba-1" },
      failedDomain: "verify",
    });
    const viaToResult = toResult(err);
    if (result.ok || viaToResult.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Network);
    expect(result.exitCode).toBe(viaToResult.exitCode);
    expect(result.error.code).toBe("bank_verification_failed");
    expect(result.error.message).toBe("bank account created but verify failed: connection reset");
    expect((result.error.details as { failed: { error: { code: string } } }).failed.error.code).toBe("network_error");
  });

  test("unknown non-Error throwable falls back to exit General and records the message", () => {
    const result = partialFailure({ code: "c", message: "m", err: "boom", completed: {}, failedDomain: "step" });
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.General);
    expect(result.error.message).toBe("m: boom");
  });
});
