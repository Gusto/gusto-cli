import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import type { CommandResult } from "../lib/runner.ts";
import { payScheduleCreateHandler } from "./pay-schedule.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };
const ctx = { command: "test", globals };
const auth = { token: "tkn", companyUuid: "co-1" };

function blockedFields(result: CommandResult): string[] {
  if (result.ok) throw new Error("expected validation failure");
  return (result.error.blocked_on ?? []).map((b) => b.field);
}

describe("payScheduleCreateHandler anchor_end_of_pay_period validation", () => {
  test("biweekly without --anchor-end-of-pay-period is refused pre-flight", async () => {
    const result = await payScheduleCreateHandler({ ...auth, frequency: "biweekly", firstPayday: "2026-07-03" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toContain("anchor-end-of-pay-period");
  });

  test("weekly also requires it", async () => {
    const result = await payScheduleCreateHandler({ ...auth, frequency: "weekly", firstPayday: "2026-07-03" })(ctx);
    expect(blockedFields(result)).toContain("anchor-end-of-pay-period");
  });

  test("biweekly with the anchor end date proceeds (dry-run shows it in the body)", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "biweekly",
      firstPayday: "2026-07-03",
      anchorEndOfPayPeriod: "2026-06-26",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      body: { frequency: "Every other week", anchor_pay_date: "2026-07-03", anchor_end_of_pay_period: "2026-06-26" },
    });
  });

  test("monthly does not require it", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
  });
});
