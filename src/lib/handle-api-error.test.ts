import { describe, expect, test } from "bun:test";
import { ApiError, type AuthContext, BlockedDestinationError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { partialFailure, toResult } from "./handle-api-error.ts";
import { OAuthError } from "./oauth/endpoints.ts";

describe("toResult", () => {
  test("4xx ApiError maps to api_client_error and carries body + request_id", () => {
    const err = new ApiError(422, { errors: ["bad email"] }, ExitCode.ApiClient, "Unprocessable", {
      requestId: "req-123",
    });
    const result = toResult(err);
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.ApiClient,
      error: {
        code: "api_client_error",
        message: "bad email (Unprocessable)",
        details: { errors: ["bad email"] },
        request_id: "req-123",
      },
    });
  });

  // `ApiError.message` is only the request line, so an API that explained itself needs its
  // explanation lifted into `error.message`. Body shapes below are the ones the API actually
  // emits: a flat shape for parameter errors, a nested one for record-level errors.
  test("leads with the API's own message for a parameter error, keeping the request line", () => {
    const body = {
      errors: [{ error_key: "start_date", category: "invalid_parameter", message: "Date range too long, max 1 year" }],
    };
    const err = new ApiError(422, body, ExitCode.ApiClient, "GET /v1/companies/c-1/payrolls -> 422");
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe(
      "start_date: Date range too long, max 1 year (GET /v1/companies/c-1/payrolls -> 422)",
    );
    // The structured body is still there untouched for callers that want the key/category.
    expect(result.error.details).toEqual(body);
  });

  test("recurses into nested record errors", () => {
    const body = {
      errors: [
        {
          error_key: "required_questions",
          errors: [{ error_key: "response", message: "Please ensure a correct response type is provided." }],
        },
      ],
    };
    const err = new ApiError(422, body, ExitCode.ApiClient, "PUT /x -> 422");
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe("response: Please ensure a correct response type is provided. (PUT /x -> 422)");
  });

  test("joins multiple messages", () => {
    const body = { errors: [{ message: "first problem" }, { message: "second problem" }] };
    const err = new ApiError(422, body, ExitCode.ApiClient, "POST /x -> 422");
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe("first problem; second problem (POST /x -> 422)");
  });

  // The API reuses one message across fields, so without `error_key` a multi-field 422 reads
  // "can't be blank; can't be blank" - repeated, and naming none of the fields that failed.
  test("names the field on each message when the body carries error_key", () => {
    const body = {
      errors: [
        { error_key: "first_name", message: "can't be blank" },
        { error_key: "last_name", message: "can't be blank" },
        { error_key: "email", message: "is invalid" },
      ],
    };
    const result = toResult(new ApiError(422, body, ExitCode.ApiClient, "POST /v1/employees -> 422"));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe(
      "first_name: can't be blank; last_name: can't be blank; email: is invalid (POST /v1/employees -> 422)",
    );
  });

  test("collapses messages that repeat verbatim", () => {
    const body = { errors: [{ message: "is invalid" }, { message: "is invalid" }] };
    const result = toResult(new ApiError(422, body, ExitCode.ApiClient, "POST /x -> 422"));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe("is invalid (POST /x -> 422)");
  });

  test("reads a bare top-level error string", () => {
    const err = new ApiError(422, { error: "EIN is already in use" }, ExitCode.ApiClient, "POST /x -> 422");
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toBe("EIN is already in use (POST /x -> 422)");
  });

  test("falls back to the request line when the body explains nothing", () => {
    for (const body of [{ detail: "gateway said no" }, {}, null, []]) {
      const result = toResult(new ApiError(422, body, ExitCode.ApiClient, "GET /x -> 422"));
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).toBe("GET /x -> 422");
    }
  });

  // An unparseable response body reaches us as the raw string, so a proxy's HTML error page
  // must not end up spliced into `message`. Bare strings count only inside `errors`.
  test("ignores a whole-body string but reads a bare string inside errors", () => {
    const html = toResult(new ApiError(502, "<html><body>gateway timeout</body></html>", ExitCode.ApiServer, "GET /x"));
    if (html.ok) throw new Error("unreachable");
    expect(html.error.message).toBe("GET /x");

    const nested = toResult(new ApiError(422, { errors: ["bad email"] }, ExitCode.ApiClient, "POST /x -> 422"));
    if (nested.ok) throw new Error("unreachable");
    expect(nested.error.message).toBe("bad email (POST /x -> 422)");
  });

  test("does not disturb the insufficient_scope branch", () => {
    const body = { errors: [{ category: "missing_oauth_scopes", message: "missing scopes" }], scope: "payrolls:read" };
    const result = toResult(new ApiError(403, body, ExitCode.ApiClient, "GET /x -> 403"));
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.message).toContain("payrolls:read");
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

// A 401 means the credential was sent and refused, so it belongs to the auth family (exit 3) rather
// than the ordinary 4xx bucket - and the only useful wording names *which* credential, which is why
// the client stamps its `AuthContext` onto the error.
describe("toResult 401 handling", () => {
  const unauthorized = (auth?: AuthContext) =>
    new ApiError(401, { error: "unauthorized" }, ExitCode.ApiClient, "GET /v1/me -> 401", { requestId: "req-9", auth });

  test("exits Auth, not ApiClient, so one branch catches every credential problem", () => {
    const result = toResult(unauthorized({ tokenSource: "session", environment: "production" }));
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("credential_rejected");
  });

  test("carries the environment, the body, and the request id", () => {
    const result = toResult(unauthorized({ tokenSource: "session", environment: "sandbox" }));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.environment).toBe("sandbox");
    expect(result.error.details).toEqual({ error: "unauthorized" });
    expect(result.error.request_id).toBe("req-9");
  });

  test("a rejected session is told to sign in again, for the environment that failed", () => {
    const result = toResult(unauthorized({ tokenSource: "session", environment: "sandbox" }));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("gusto auth login --env sandbox");
    // The request line survives: a 401 can land mid-walk, and which call failed is worth knowing.
    expect(result.error.message).toContain("GET /v1/me -> 401");
  });

  test.each([
    ["env" as const, "GUSTO_ACCESS_TOKEN"],
    ["stdin" as const, "--token-stdin"],
  ])("a rejected %s token names it and does not suggest logging in", (tokenSource, named) => {
    // `auth login` would rotate a stored session the failing command never used, so an explicitly
    // supplied token has to be reported as the caller's to fix.
    const result = toResult(unauthorized({ tokenSource, environment: "production" }));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain(named);
    expect(result.error.message).not.toContain("gusto auth login");
  });

  test("a rejected just-minted login token names the sign-in, not a stored credential", () => {
    // The `token_info` read inside `auth login` is the one 401 whose credential is seconds old and
    // ours. None of the other three recoveries apply: nothing is stored yet (the save happens after
    // this read) and there is no caller-supplied value to go fix.
    const result = toResult(unauthorized({ tokenSource: "login", environment: "sandbox" }));
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("credential_rejected");
    expect(result.error.environment).toBe("sandbox");
    expect(result.error.message).toContain("/v1/token_info");
    expect(result.error.message).toContain("nothing was stored");
    expect(result.error.message).toContain("gusto auth login --env sandbox");
    // Must not read as a rejected stored session, whose login costs a live refresh token.
    expect(result.error.message).not.toContain("stored sandbox session");
  });

  test("no wording suggests a bare retry, since nothing re-authenticates on its own", () => {
    for (const tokenSource of ["session", "env", "stdin"] as const) {
      const result = toResult(unauthorized({ tokenSource, environment: "production" }));
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).not.toContain("retry");
    }
  });

  test("still classifies as an auth failure when the client carried no context", () => {
    // Covers a 401 from a client built without one: the code and exit stay put, and the message has
    // to describe all three sources rather than send the caller at the wrong one.
    const result = toResult(unauthorized());
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("credential_rejected");
    expect("environment" in result.error).toBe(false);
    expect(result.error.message).toContain("GUSTO_ACCESS_TOKEN");
    expect(result.error.message).toContain("gusto auth login");
  });

  test("a 403 without a scope reason stays an ordinary 4xx", () => {
    // Guards the boundary: only 401 moves to the auth family, not every 4xx near it.
    const result = toResult(new ApiError(403, { error: "forbidden" }, ExitCode.ApiClient, "GET /x -> 403"));
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.code).toBe("api_client_error");
  });
});

describe("toResult 403 scope handling", () => {
  // Scopes are granted per credential and a credential is per environment, so this failure is no
  // less environment-specific than the 401 above. It predates the field, which is the only reason it
  // ever read as the exception.
  test("insufficient_scope carries the environment when the client had a context", () => {
    const err = new ApiError(
      403,
      { error: "insufficient_scope", scope: "payrolls:read" },
      ExitCode.ApiClient,
      "GET /v1/payrolls -> 403",
      { auth: { tokenSource: "session", environment: "sandbox" } },
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.environment).toBe("sandbox");
  });

  test("insufficient_scope omits the environment when the client carried no context", () => {
    // Absent rather than guessed: a wrong environment is worse than none for a caller branching on it.
    const err = new ApiError(
      403,
      { error: "insufficient_scope", scope: "payrolls:read" },
      ExitCode.ApiClient,
      "GET /v1/payrolls -> 403",
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("insufficient_scope");
    expect("environment" in result.error).toBe(false);
  });

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

  test.each([
    ["env" as const, "GUSTO_ACCESS_TOKEN"],
    ["stdin" as const, "--token-stdin"],
  ])("insufficient_scope for an explicit %s token tells the caller to replace that token", (tokenSource, named) => {
    const err = new ApiError(
      403,
      { error: "insufficient_scope", scope: "employees:manage" },
      ExitCode.ApiClient,
      "POST /v1/companies/x/employees -> 403",
      { auth: { tokenSource, environment: "sandbox" } },
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain(named);
    expect(result.error.message).toContain("employees:manage");
    // A stored login cannot repair an explicit token, which wins on every subsequent command.
    expect(result.error.message).not.toContain("gusto auth login");
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

  test("a Gusto missing_oauth_scopes 403 with metadata.missing_scope_name and no auth context names the scope", () => {
    // Same shape as the generic body above, plus metadata naming the scope.
    const err = new ApiError(
      403,
      {
        errors: [
          {
            error_key: "request",
            category: "missing_oauth_scopes",
            message:
              "You do not have the 'company_benefits:read' OAuth scope required for this request. Please reach out to developer@gusto.com for assistance.",
            metadata: { missing_scope_name: "company_benefits:read" },
          },
        ],
      },
      ExitCode.ApiClient,
      "GET /v1/companies/x/benefits -> 403",
    );
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.message).toContain("company_benefits:read");
    expect(result.error.message).not.toContain("gusto auth login");
    expect(result.error.message).toContain("gusto feedback");
  });

  test("the scope name is read off the missing_oauth_scopes entry even when it isn't errors[0]", () => {
    const err = new ApiError(
      403,
      {
        errors: [
          { error_key: "request", category: "forbidden", message: "nope" },
          {
            error_key: "request",
            category: "missing_oauth_scopes",
            message: "You do not have the 'company_benefits:read' OAuth scope required for this request.",
            metadata: { missing_scope_name: "company_benefits:read" },
          },
        ],
      },
      ExitCode.ApiClient,
      "GET /v1/companies/x/benefits -> 403",
    );
    const result = toResult(err);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.message).toContain("company_benefits:read");
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

describe("toResult 403 scope recovery", () => {
  const SUPPORT_EMAIL = "developer@gusto.com";

  function scopeEntry(scope?: string) {
    return {
      error_key: "request",
      category: "missing_oauth_scopes",
      message: scope
        ? `You do not have the '${scope}' OAuth scope required for this request. Please reach out to ${SUPPORT_EMAIL} for assistance.`
        : `You do not have the necessary OAuth scopes for this request. Please reach out to ${SUPPORT_EMAIL} for assistance.`,
      ...(scope !== undefined ? { metadata: { missing_scope_name: scope } } : {}),
    };
  }

  function scopeError(entries: unknown[], auth?: AuthContext, requestId: string | null = "req-scope-1"): ApiError {
    return new ApiError(403, { errors: entries }, ExitCode.ApiClient, "GET /v1/companies/x/thing -> 403", {
      ...(requestId ? { requestId } : {}),
      ...(auth ? { auth } : {}),
    });
  }

  const gustoScopeError = (scope: string | undefined, auth?: AuthContext) => scopeError([scopeEntry(scope)], auth);

  function message(err: ApiError): string {
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    return result.error.message;
  }

  const storedSources = [
    ["session", { tokenSource: "session", environment: "production" }],
    ["login", { tokenSource: "login", environment: "production" }],
  ] as const satisfies readonly (readonly [string, AuthContext])[];

  describe.each(storedSources)("for a %s credential", (_label, auth) => {
    test.each(["company_benefits:read", "company_bank_accounts:write"])(
      "a scope outside the CLI's grant (%s) points to feedback instead of signing in again",
      (scope) => {
        const text = message(gustoScopeError(scope, auth));
        expect(text).toContain(`${scope} isn't part of the CLI's OAuth grant, so signing in again won't add it`);
        expect(text).not.toContain("gusto auth login");
        expect(text).toContain('gusto feedback --message "<what you need>"');
      },
    );

    test("several scopes outside the CLI's grant are named together", () => {
      const text = message(
        scopeError([scopeEntry("company_benefits:read"), scopeEntry("company_bank_accounts:write")], auth),
      );
      expect(text).toContain("missing the OAuth scopes (company_benefits:read, company_bank_accounts:write)");
      expect(text).toContain(
        "company_benefits:read, company_bank_accounts:write aren't part of the CLI's OAuth grant, so signing in again won't add them",
      );
    });

    test("several requested scopes get a plural sign-in suggestion", () => {
      const text = message(scopeError([scopeEntry("payrolls:read"), scopeEntry("employees:read")], auth));
      expect(text).toContain("missing the OAuth scopes (payrolls:read, employees:read)");
      expect(text).toContain("Re-run `gusto auth login --env production` and grant them");
    });

    test("a scope in the CLI's grant still suggests signing in again", () => {
      const text = message(gustoScopeError("payrolls:read", auth));
      expect(text).toContain("payrolls:read");
      expect(text).toContain("Re-run `gusto auth login --env production` and grant it;");
    });

    test("an unnamed scope suggests whoami and a sign-in without promising either fixes it", () => {
      const text = message(gustoScopeError(undefined, auth));
      expect(text).toContain("missing the OAuth scope this command needs");
      expect(text).toContain("gusto auth whoami --env production");
      expect(text).toContain("`gusto auth login --env production` may add it. If that doesn't help,");
      expect(text).toContain("gusto feedback");
      expect(text).not.toContain("and grant it");
    });
  });

  test.each([
    ["a requested", "payrolls:read"],
    ["an unnamed", undefined],
  ])("with no auth context, %s scope's advice carries no --env flag", (_label, scope) => {
    const text = message(gustoScopeError(scope));
    expect(text).toContain("gusto auth login");
    expect(text).not.toContain("--env");
  });

  const explicitSources = [
    ["env", "GUSTO_ACCESS_TOKEN"],
    ["stdin", "--token-stdin"],
  ] as const;

  describe.each(explicitSources)("an explicit %s token", (tokenSource, named) => {
    test.each([
      ["requested", ["payrolls:read"]],
      ["outside the grant", ["company_benefits:read"]],
      ["unnamed", [undefined]],
    ])("keeps its replace-the-token advice for a %s scope", (_label, scopes) => {
      const result = toResult(scopeError(scopes.map(scopeEntry), { tokenSource, environment: "sandbox" }));
      if (result.ok) throw new Error("unreachable");
      expect(result.error.message).toContain(named);
      expect(result.error.message).not.toContain("gusto auth login");
      expect(JSON.stringify(result.error)).not.toContain(SUPPORT_EMAIL);
    });

    test("pluralizes the advice for several scopes", () => {
      const text = message(
        scopeError([scopeEntry("payrolls:read"), scopeEntry("employees:read")], {
          tokenSource,
          environment: "sandbox",
        }),
      );
      expect(text).toContain("a token that grants them");
    });
  });

  const session: AuthContext = { tokenSource: "session", environment: "production" };

  test("reports every missing scope the body names", () => {
    const result = toResult(scopeError([scopeEntry("payrolls:read"), scopeEntry("company_benefits:read")], session));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.missing_scopes).toEqual(["payrolls:read", "company_benefits:read"]);
  });

  test.each([
    ["grantable first", ["payrolls:read", "company_benefits:read"]],
    ["ungrantable first", ["company_benefits:read", "payrolls:read"]],
  ])("a mix of scopes (%s) says what signing in again adds and that the command still fails", (_label, scopes) => {
    const text = message(scopeError(scopes.map(scopeEntry), session));
    expect(text).toContain(
      "Signing in again with `gusto auth login --env production` can add payrolls:read, but company_benefits:read isn't part of the CLI's OAuth grant, so this command will still fail - ",
    );
    expect(text).toContain("gusto feedback");
  });

  test.each([
    [
      "two outside the grant, one in it",
      ["company_benefits:read", "company_bank_accounts:write", "payrolls:read"],
      "can add payrolls:read, but company_benefits:read, company_bank_accounts:write aren't part",
    ],
    [
      "one outside the grant, two in it",
      ["payrolls:read", "company_benefits:read", "employees:read"],
      "can add payrolls:read, employees:read, but company_benefits:read isn't part",
    ],
  ])("a mix with %s lists each side and agrees in number", (_label, scopes, expected) => {
    expect(message(scopeError(scopes.map(scopeEntry), session))).toContain(expected);
  });

  test("repeated entries naming the same scope are reported once", () => {
    const result = toResult(scopeError([scopeEntry("payrolls:read"), scopeEntry("payrolls:read")], session));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.missing_scopes).toEqual(["payrolls:read"]);
    expect(result.error.message).toContain("(payrolls:read)");
  });

  test("scope entries win over a top-level scope when a body carries both, matching the category", () => {
    const err = new ApiError(
      403,
      { scope: "payrolls:read", errors: [scopeEntry("company_benefits:read")] },
      ExitCode.ApiClient,
      "GET /v1/x -> 403",
      { auth: session },
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.category).toBe("missing_oauth_scopes");
    expect(result.error.missing_scopes).toEqual(["company_benefits:read"]);
  });

  test.each([
    ["whitespace-only", { error: "insufficient_scope", scope: "   " }],
    ["absent", { error: "insufficient_scope" }],
  ])("an RFC 6750 body with a %s scope is treated as unnamed", (_label, body) => {
    const result = toResult(new ApiError(403, body, ExitCode.ApiClient, "GET /v1/x -> 403", { auth: session }));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.category).toBe("insufficient_scope");
    expect("missing_scopes" in result.error).toBe(false);
    expect(result.error.message).toContain("gusto auth whoami");
  });

  test("an empty RFC 6750 scope falls back to the scope entries", () => {
    const err = new ApiError(
      403,
      { scope: "", errors: [scopeEntry("company_benefits:read")] },
      ExitCode.ApiClient,
      "GET /v1/x -> 403",
      { auth: session },
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.missing_scopes).toEqual(["company_benefits:read"]);
  });

  test("a space-separated RFC 6750 scope list is read as separate scopes", () => {
    const err = new ApiError(
      403,
      { error: "insufficient_scope", scope: "payrolls:read employees:read" },
      ExitCode.ApiClient,
      "GET /v1/payrolls -> 403",
      { auth: session },
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.missing_scopes).toEqual(["employees:read", "payrolls:read"]);
    expect(result.error.message).toContain("gusto auth login");
    expect("details" in result.error).toBe(false);
  });

  test("an empty scope name is treated as unnamed", () => {
    const result = toResult(scopeError([scopeEntry("")], session));
    if (result.ok) throw new Error("unreachable");
    expect("missing_scopes" in result.error).toBe(false);
    expect(result.error.message).toContain("gusto auth whoami");
    expect(result.error.message).not.toContain("(, ");
    expect(result.error.message).not.toContain(" isn't part");
  });

  test.each([
    ["requested", "payrolls:read"],
    ["outside the grant", "company_benefits:read"],
    ["unnamed", undefined],
  ])("a %s scope's error never mentions the API's support address", (_label, scope) => {
    const result = toResult(gustoScopeError(scope, session));
    if (result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.error)).not.toContain(SUPPORT_EMAIL);
  });

  test("keeps the scope names, category, request ID, and environment as their own fields", () => {
    const result = toResult(gustoScopeError("company_benefits:read", session));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.missing_scopes).toEqual(["company_benefits:read"]);
    expect(result.error.category).toBe("missing_oauth_scopes");
    expect(result.error.request_id).toBe("req-scope-1");
    expect(result.error.environment).toBe("production");
    expect("details" in result.error).toBe(false);
  });

  test("leaves out the request ID and scope names when the API supplied neither", () => {
    const result = toResult(scopeError([scopeEntry(undefined)], session, null));
    if (result.ok) throw new Error("unreachable");
    expect("request_id" in result.error).toBe(false);
    expect("missing_scopes" in result.error).toBe(false);
  });

  test("an RFC 6750 scope error carries its own category", () => {
    const err = new ApiError(
      403,
      { error: "insufficient_scope", scope: "payrolls:read" },
      ExitCode.ApiClient,
      "GET /v1/payrolls -> 403",
    );
    const result = toResult(err);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.category).toBe("insufficient_scope");
    expect(result.error.missing_scopes).toEqual(["payrolls:read"]);
    expect("details" in result.error).toBe(false);
  });

  test("unrelated errors in the same body stay in details, without the scope entries", () => {
    const other = { error_key: "company", category: "forbidden", message: "Company is suspended" };
    const result = toResult(scopeError([other, scopeEntry("company_benefits:read")], session));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.details).toEqual({ errors: [other] });
    expect(JSON.stringify(result.error)).not.toContain(SUPPORT_EMAIL);
  });

  test("a non-scope 403 still passes the full API body through", () => {
    const body = { errors: [{ error_key: "request", category: "forbidden", message: "nope" }] };
    const result = toResult(new ApiError(403, body, ExitCode.ApiClient, "GET /v1/companies/x -> 403"));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual(body);
  });

  test("a 5xx still passes the full API body through", () => {
    const body = { errors: [{ message: "upstream timeout" }] };
    const result = toResult(new ApiError(503, body, ExitCode.ApiServer, "GET /v1/companies/x -> 503"));
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual(body);
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
        message: "bank account created but verify failed: nope (PUT /x -> 422)",
        details: {
          bank_account: "ba-1",
          completed: ["bank_account"],
          // The server's 422 body is preserved (structured) under failed.error.details.
          failed: {
            domain: "verify",
            error: { code: "api_client_error", message: "nope (PUT /x -> 422)", details: { errors: ["nope"] } },
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

  test.each([
    [401, { error: "unauthorized" }, "credential_rejected"],
    [403, { error: "insufficient_scope" }, "insufficient_scope"],
  ])("an auth failure at HTTP %i keeps environment on the outer partial-failure envelope", (status, body, code) => {
    const err = new ApiError(status, body, ExitCode.ApiClient, `GET /follow-up -> ${status}`, {
      auth: { tokenSource: "session", environment: "sandbox" },
    });
    const result = partialFailure({
      code: "compliance_nudge_fetch_failed",
      message: "work address changed but tax requirements failed",
      err,
      completed: { work_address: { uuid: "wa-1" } },
      failedDomain: "tax_requirements",
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.environment).toBe("sandbox");
    expect((result.error.details as { failed: { error: { code: string } } }).failed.error.code).toBe(code);
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
