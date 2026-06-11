import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { InputError } from "../lib/oauth/provision-input.ts";
import { companyProvisionHandler, provisionPayloadError, provisionResultData } from "./company.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };

describe("provisionResultData", () => {
  test("returns the claim url and points at `auth login` as the next step", () => {
    expect(provisionResultData({ accountClaimUrl: "https://claim/co-1" })).toEqual({
      account_claim_url: "https://claim/co-1",
      next_command: "gusto auth login",
      next_step: "Claim the account in your browser, then run `gusto auth login` to authenticate.",
    });
  });
});

describe("provisionPayloadError", () => {
  test("maps an InputError to a validation result", () => {
    expect(provisionPayloadError(new InputError("bad payload"))).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: { code: "invalid_input", message: "bad payload" },
    });
  });

  test("routes a non-InputError through toResult", () => {
    const result = provisionPayloadError(new Error("boom"));
    expect(result.ok).toBe(false);
  });
});

describe("companyProvisionHandler", () => {
  test("dry-run returns the request shape without touching stdin", async () => {
    const result = await companyProvisionHandler({ example: true, dryRun: true })({
      command: "gusto company provision",
      globals,
    });
    expect(result.ok).toBe(true);
    expect((result as { data: { method: string; path: string } }).data.method).toBe("POST");
    expect((result as { data: { method: string; path: string } }).data.path).toBe("/v1/provision");
  });

  test("bare invocation returns the standard missing-args envelope with blocked_on", async () => {
    const result = await companyProvisionHandler({})({ command: "gusto company provision", globals });
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: {
        code: "validation",
        message: "missing required arguments",
        blocked_on: [
          {
            field: "input",
            reason: "provide --input <file.json> with a {user, company} payload, or --example for a sample run",
          },
        ],
      },
    });
  });

  test("an unreadable --input still returns the invalid_input shape (not blocked_on)", async () => {
    const result = await companyProvisionHandler({ input: "/does/not/exist.json" })({
      command: "gusto company provision",
      globals,
    });
    expect(result.ok).toBe(false);
    const err = result as { ok: false; exitCode: number; error: { code: string; message: string } };
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.error.code).toBe("invalid_input");
    expect(err.error.message).toContain("/does/not/exist.json");
  });
});
