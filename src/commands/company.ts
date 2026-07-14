import type { Command } from "commander";
import { ApiError } from "../lib/api-client.ts";
import { withCompanyContext } from "../lib/api-context.ts";
import { errMsg } from "../lib/errors.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { fetchCompanyLocations } from "../lib/locations.ts";
import { kvLines, table } from "../lib/human.ts";
import { type CommandHandler, runReadCommand } from "../lib/runner.ts";
import { withContextOptions } from "../lib/cli-options.ts";

interface CompanyShowOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
}

export function registerCompanyCommand(parent: Command): void {
  const cmd = parent.command("company").description("Inspect a company");

  withContextOptions(
    cmd
      .command("show")
      // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
      .alias("get")
      .description("Company overview: record, payment config, and pay schedule"),
  ).action((opts: CompanyShowOpts) =>
    runReadCommand("gusto company show", readGlobalFlags(parent.opts()), companyShowHandler(opts)),
  );

  withContextOptions(
    cmd
      .command("locations")
      .description("List the company's locations (employee work addresses reference these by uuid)"),
  ).action((opts: CompanyShowOpts) =>
    runReadCommand("gusto company locations", readGlobalFlags(parent.opts()), companyLocationsHandler(opts)),
  );
}

export function companyLocationsHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const res = await fetchCompanyLocations(ctx.client, ctx.companyUuid);
      if (!res.ok) return res;
      return { ok: true, data: { locations: res.data } };
    });
}

interface CompanyRecord {
  name?: string;
  trade_name?: string;
  company_status?: string;
  tier?: string;
  ein?: string;
  entity_type?: string;
  is_partner_managed?: boolean;
}
interface PaymentConfig {
  payment_speed?: string;
  fast_payment_limit?: unknown;
}
interface PaySchedule {
  uuid?: string;
  frequency?: string;
  anchor_pay_date?: string;
  anchor_end_of_pay_period?: string;
}

interface CompanyShowSummary {
  name: string | null;
  trade_name: string | null;
  status: string | null;
  tier: string | null;
  ein: string | null;
  entity_type: string | null;
  payment_speed: string | null;
  pay_schedule: { frequency?: string; anchor_pay_date?: string } | null;
}

interface PartialError {
  label: string;
  error: string;
}

interface CompanyShowBase {
  company_uuid: string;
  summary: CompanyShowSummary;
  company: CompanyRecord | null;
  payment_config: PaymentConfig | null;
  pay_schedules: PaySchedule[] | null;
}

/** The data envelope `company show` returns. Shared by the handler and the human renderer so the
 * two can't drift. Discriminated on `success`: partial_errors is present iff a section failed, so
 * the two can never contradict each other (no `{ success: true, partial_errors: [...] }`). */
export type CompanyShowData = CompanyShowBase &
  ({ success: true; partial_errors?: never } | { success: false; partial_errors: PartialError[] });

/** Render `company show` as human-readable key-value blocks + a pay-schedule table instead of raw
 * JSON. Missing fields are dropped; only the UUID is always shown. */
export function renderCompanyShow(data: CompanyShowData): string {
  const s = data.summary;
  const overview = kvLines([
    ["Company", s.name],
    ["Trade name", s.trade_name],
    ["UUID", data.company_uuid],
    ["Status", s.status],
    ["Tier", s.tier],
    ["EIN", s.ein],
    ["Entity type", s.entity_type],
    ["Payment speed", s.payment_speed],
  ]);

  const rows = data.pay_schedules ?? [];
  const schedule = table(
    ["UUID", "Frequency", "Anchor pay date"],
    rows.map((ps) => [ps.uuid, ps.frequency, ps.anchor_pay_date]),
  );
  const scheduleSection = schedule ? `Pay schedules\n${schedule}` : "";

  const errs = data.partial_errors ?? [];
  const errorSection =
    errs.length > 0
      ? [`⚠ ${errs.length} section(s) failed to load:`, ...errs.map((e) => `  - ${e.label}: ${e.error}`)].join("\n")
      : "";

  return [overview, scheduleSection, errorSection].filter((section) => section !== "").join("\n\n");
}

export function companyShowHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}`;
      const safe = async <T>(
        label: string,
        fn: () => Promise<T>,
      ): Promise<
        { ok: true; data: T } | { ok: false; label: string; error: string; status?: number; cause: unknown }
      > => {
        try {
          return { ok: true, data: await fn() };
        } catch (err) {
          const status = err instanceof ApiError ? err.status : undefined;
          return { ok: false, label, error: errMsg(err), status, cause: err };
        }
      };

      const [companyR, paymentR, scheduleR] = await Promise.all([
        safe("company", async () => (await ctx.client.get<CompanyRecord>(base)).body),
        safe("payment_config", async () => (await ctx.client.get<PaymentConfig>(`${base}/payment_configs`)).body),
        safe("pay_schedules", async () => (await ctx.client.get<PaySchedule[]>(`${base}/pay_schedules`)).body),
      ]);

      // The company record is the primary read; if it failed there's nothing to show, so rethrow
      // (mapped to the right exit code downstream) instead of burying it under partial_errors.
      if (!companyR.ok) throw companyR.cause;

      const company = companyR.data;
      const paymentConfig = paymentR.ok ? paymentR.data : null;
      // Sanitize once here so pay_schedules is genuinely PaySchedule[] | null downstream: the API
      // body is typed but not runtime-validated, and a malformed-but-200 non-array would otherwise
      // crash the human renderer's .map. Keeping the guard here lets callers trust the type.
      const paySchedules = scheduleR.ok && Array.isArray(scheduleR.data) ? scheduleR.data : null;
      const firstSchedule = paySchedules?.[0] ?? null;
      // payment_configs is gated on an active PartnerCompanyMapping; non-partner-managed
      // companies always 404 here, which reads as a bug to anyone watching the output. Drop only the 404 -
      // a 5xx or network error against the same endpoint is still a real failure.
      const suppressPaymentConfig404 = company?.is_partner_managed === false;
      const errors = [paymentR, scheduleR]
        .filter((r): r is { ok: false; label: string; error: string; status?: number; cause: unknown } => !r.ok)
        .filter((r) => !(r.label === "payment_config" && r.status === 404 && suppressPaymentConfig404))
        .map(({ label, error }) => ({ label, error }));

      const payload: CompanyShowBase = {
        company_uuid: ctx.companyUuid,
        summary: {
          name: company?.name ?? null,
          trade_name: company?.trade_name ?? null,
          status: company?.company_status ?? null,
          tier: company?.tier ?? null,
          ein: company?.ein ?? null,
          entity_type: company?.entity_type ?? null,
          payment_speed: paymentConfig?.payment_speed ?? null,
          pay_schedule: firstSchedule
            ? { frequency: firstSchedule.frequency, anchor_pay_date: firstSchedule.anchor_pay_date }
            : null,
        },
        company,
        payment_config: paymentConfig,
        pay_schedules: paySchedules,
      };
      const data: CompanyShowData =
        errors.length > 0 ? { ...payload, success: false, partial_errors: errors } : { ...payload, success: true };
      return { ok: true, data, human: () => renderCompanyShow(data) };
    });
}
