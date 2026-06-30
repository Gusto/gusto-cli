import { describe, expect, test } from "bun:test";
import { confirmationGate } from "./confirm.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";

function flags(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return { agent: false, human: false, json: false, verbose: false, ...overrides };
}

const TARGET = "/v1/companies/{company_uuid}/time_tracking/time_sheets";

describe("confirmationGate", () => {
  test("blocks an agent-mode write that lacks --confirm", () => {
    const result = confirmationGate(flags({ agent: true }), "POST", TARGET, {});
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.exitCode).toBe(ExitCode.Blocked);
      expect(result.error.code).toBe("confirmation_required");
    }
  });

  test("names the method and target, and points at --confirm and --dry-run", () => {
    const result = confirmationGate(flags({ agent: true }), "POST", TARGET, {});
    if (result?.ok === false) {
      expect(result.error.message).toContain("POST");
      expect(result.error.message).toContain(TARGET);
      expect(result.error.message).toContain("--confirm");
      expect(result.error.message).toContain("--dry-run");
      expect(result.error.details).toEqual({ retry_with: ["--confirm"], preview_with: ["--dry-run"] });
    }
  });

  test("lets the write through when --confirm is passed", () => {
    expect(confirmationGate(flags({ agent: true }), "POST", TARGET, { confirm: true })).toBeNull();
  });

  test("lets a --dry-run preview through without --confirm", () => {
    expect(confirmationGate(flags({ agent: true }), "POST", TARGET, { dryRun: true })).toBeNull();
  });

  test("never gates a read (GET)", () => {
    expect(confirmationGate(flags({ agent: true }), "GET", "/v1/companies/x/employees", {})).toBeNull();
  });

  test("does not gate in human mode - the operator at the TTY is the loop", () => {
    expect(confirmationGate(flags({ human: true }), "POST", TARGET, {})).toBeNull();
  });

  test("treats piped stdout (non-TTY) as agent mode and gates the write", () => {
    const result = confirmationGate(flags(), "POST", TARGET, {}, false);
    expect(result?.ok).toBe(false);
  });

  test("treats an interactive TTY with no flags as human mode and does not gate", () => {
    expect(confirmationGate(flags(), "POST", TARGET, {}, true)).toBeNull();
  });

  test("gates the other write verbs (PUT, PATCH, DELETE) in agent mode", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const result = confirmationGate(flags({ agent: true }), method, TARGET, {});
      expect(result?.ok).toBe(false);
    }
  });
});
