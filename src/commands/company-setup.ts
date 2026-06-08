import type { Command } from "commander";
import { withCompanyContext } from "../lib/api-context.ts";
import { ApiError } from "../lib/api-client.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { defaultOpenBrowser } from "../lib/oauth/login.ts";
import { type TaxRequirementsResponse, TEMPORARY_RATE_STATES, buildTaxRequirementSets } from "../lib/state-tax.ts";
import { type BlockedOn } from "../lib/output.ts";
import { type CommandHandler, type CommandResult, runCommand } from "../lib/runner.ts";
import { type PayScheduleCreateOpts, payScheduleCreateHandler } from "./pay-schedule.ts";

interface ContextOpts {
  companyUuid?: string;
  token?: string;
}

function missingArgs(blocked: BlockedOn[]): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.Validation,
    error: { code: "validation", message: "missing required arguments", blocked_on: blocked },
  };
}

function asArray<T>(body: unknown): T[] {
  return Array.isArray(body) ? (body as T[]) : [];
}

// ───────────────────────────── setup federal-tax ─────────────────────────────

interface FederalTaxOpts extends ContextOpts {
  ein?: string;
  taxPayerType?: string;
  filingForm?: string;
  legalName?: string;
  taxableAsScorp?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

/** Validation blockers for the four fields that complete federal_tax_setup. */
export function federalTaxBlockers(opts: FederalTaxOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.ein) blocked.push({ field: "ein", reason: "required (9-digit EIN)" });
  if (!opts.taxPayerType) blocked.push({ field: "tax-payer-type", reason: "required (IRS entity classification)" });
  if (!opts.filingForm) blocked.push({ field: "filing-form", reason: 'required ("941" or "944")' });
  if (!opts.legalName) blocked.push({ field: "legal-name", reason: "required (legal name on file with the IRS)" });
  return blocked;
}

/** S-corp election is implied by the S-Corporation taxpayer type. */
export function resolveTaxableAsScorp(opts: FederalTaxOpts): boolean | undefined {
  if (opts.taxableAsScorp !== undefined) return opts.taxableAsScorp;
  if (opts.taxPayerType === "S-Corporation") return true;
  return undefined;
}

/** A fabricated 9-digit EIN in XX-XXXXXXX form. Used only on staging when the
 * provided EIN collides with another company. */
function fabricateEin(): string {
  const prefix = 10 + Math.floor(Math.random() * 90);
  const suffix = Math.floor(Math.random() * 10_000_000)
    .toString()
    .padStart(7, "0");
  return `${prefix}-${suffix}`;
}

function einAlreadyInUse(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 422) return false;
  const haystack = `${err.message} ${JSON.stringify(err.body ?? "")}`;
  return /ein.*already in use/i.test(haystack);
}

export function federalTaxHandler(opts: FederalTaxOpts): CommandHandler {
  return async ({ globals }) => {
    const taxableAsScorp = resolveTaxableAsScorp(opts);

    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/companies/{company_uuid}/federal_tax_details",
          body: {
            ein: "12-3456789",
            tax_payer_type: "S-Corporation",
            filing_form: "941",
            legal_name: "Acme Widgets Inc.",
            taxable_as_scorp: true,
          },
          note: "example: version is read from current details at send time",
        },
      };
    }

    const blocked = federalTaxBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/companies/{company_uuid}/federal_tax_details",
          body: {
            ein: opts.ein,
            tax_payer_type: opts.taxPayerType,
            filing_form: opts.filingForm,
            legal_name: opts.legalName,
            ...(taxableAsScorp !== undefined ? { taxable_as_scorp: taxableAsScorp } : {}),
          },
          note: "dry-run: version is read from current federal_tax_details at send time",
        },
      };
    }

    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}/federal_tax_details`;

      const attempt = async (ein: string): Promise<unknown> => {
        const current = (await ctx.client.get<{ version?: string }>(base)).body;
        const body = {
          version: current.version,
          ein,
          tax_payer_type: opts.taxPayerType,
          filing_form: opts.filingForm,
          legal_name: opts.legalName,
          ...(taxableAsScorp !== undefined ? { taxable_as_scorp: taxableAsScorp } : {}),
        };
        return (await ctx.client.put(base, body)).body;
      };

      // Staging persists EINs across runs, so a fixture EIN often collides on a
      // re-run. On a 422 "already in use", rotate to a fresh fabricated EIN once.
      let einUsed = opts.ein as string;
      let result: unknown;
      let einAutoRotated = false;
      let einProvided: string | null = null;
      try {
        result = await attempt(einUsed);
      } catch (err) {
        if (!einAlreadyInUse(err)) throw err;
        einProvided = einUsed;
        einUsed = fabricateEin();
        einAutoRotated = true;
        result = await attempt(einUsed);
      }

      return {
        ok: true,
        data: {
          federal_tax: result,
          ein_used: einUsed,
          tax_payer_type: opts.taxPayerType,
          taxable_as_scorp: taxableAsScorp ?? null,
          ...(einAutoRotated ? { ein_auto_rotated: true, ein_provided: einProvided } : {}),
        },
      };
    });
  };
}

// ───────────────────────────── setup bank-account ─────────────────────────────

interface BankAccountOpts extends ContextOpts {
  routing?: string;
  accountNumber?: string;
  accountType?: string;
  dryRun?: boolean;
  example?: boolean;
}

export function bankAccountBlockers(opts: BankAccountOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.routing) blocked.push({ field: "routing", reason: "required (9-digit routing number)" });
  if (!opts.accountNumber) blocked.push({ field: "account-number", reason: "required" });
  if (!opts.accountType) blocked.push({ field: "account-type", reason: 'required ("Checking" or "Savings")' });
  return blocked;
}

export function bankAccountHandler(opts: BankAccountOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/bank_accounts",
          body: { routing_number: "123456789", account_number: "1234567890", account_type: "Checking" },
          note: "example: connect runs create -> send_test_deposits -> verify in one shot",
        },
      };
    }

    const blocked = bankAccountBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/bank_accounts",
          body: {
            routing_number: opts.routing,
            account_number: opts.accountNumber,
            account_type: opts.accountType,
          },
          note: "dry-run: send_test_deposits + verify follow on send",
        },
      };
    }

    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}/bank_accounts`;
      const bank = (
        await ctx.client.post<{ uuid: string }>(base, {
          routing_number: opts.routing,
          account_number: opts.accountNumber,
          account_type: opts.accountType,
        })
      ).body;

      const deposits = (
        await ctx.client.post<{ deposit_1: number | string; deposit_2: number | string }>(
          `${base}/${bank.uuid}/send_test_deposits`,
        )
      ).body;

      await ctx.client.put(`${base}/${bank.uuid}/verify`, {
        deposit_1: Number(deposits.deposit_1),
        deposit_2: Number(deposits.deposit_2),
      });

      const last4 = (opts.accountNumber ?? "").slice(-4);
      return {
        ok: true,
        data: {
          bank_account_uuid: bank.uuid,
          verification_status: "verified",
          message: `Bank account ending in ${last4} connected and verified.`,
        },
      };
    });
  };
}

// ───────────────────────────── setup state-tax ─────────────────────────────

interface StateTaxOpts extends ContextOpts {
  temporaryRates?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

interface EmployeeRec {
  uuid: string;
  jobs?: unknown[];
}
interface WorkAddressRec {
  active?: boolean;
  state?: string;
}
interface LocationRec {
  uuid: string;
}
interface StateStatusRec {
  state: string;
  setup_complete?: boolean;
  ready_to_run_payroll?: boolean;
}

export function stateTaxHandler(opts: StateTaxOpts): CommandHandler {
  return async ({ globals }) => {
    const useTemporaryRates = opts.temporaryRates !== false;

    if (opts.example || opts.dryRun) {
      return {
        ok: true,
        data: {
          note: "state-tax setup is discovery-driven: it reads states from employee work addresses, then PUTs /v1/companies/{company_uuid}/tax_requirements/{state} to opt into the new-employer default rate where supported.",
          temporary_rate_states: TEMPORARY_RATE_STATES,
          use_temporary_rates: useTemporaryRates,
        },
      };
    }

    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const companyBase = `/v1/companies/${ctx.companyUuid}`;
      const employees = asArray<EmployeeRec>((await ctx.client.get(`${companyBase}/employees`)).body);
      const locations = asArray<LocationRec>((await ctx.client.get(`${companyBase}/locations`)).body);
      const primaryLocationUuid = locations[0]?.uuid;

      const states = new Set<string>();
      for (const emp of employees) {
        let workAddresses = await loadWorkAddresses(ctx.client, emp.uuid);
        const hasJob = Array.isArray(emp.jobs) && emp.jobs.length > 0;
        if (hasJob && workAddresses.length === 0 && primaryLocationUuid) {
          try {
            await ctx.client.post(`/v1/employees/${emp.uuid}/work_addresses`, {
              location_uuid: primaryLocationUuid,
              active: true,
              effective_date: new Date().toISOString().slice(0, 10),
            });
            workAddresses = await loadWorkAddresses(ctx.client, emp.uuid);
          } catch {
            // Fall through - report the state as needing manual setup below.
          }
        }
        for (const wa of workAddresses) {
          if (wa.active === true && wa.state) states.add(wa.state);
        }
      }

      if (states.size === 0) {
        return {
          ok: false,
          exitCode: ExitCode.Blocked,
          error: {
            code: "no_work_addresses",
            message: "No employee work addresses found. Add employees before setting up state taxes.",
          },
        };
      }

      const results: { state: string; status: string; reason?: string }[] = [];
      for (const state of states) {
        const reqs = (await ctx.client.get<TaxRequirementsResponse>(`${companyBase}/tax_requirements/${state}`)).body;
        const built = buildTaxRequirementSets(reqs, state, useTemporaryRates);
        if (built.status !== "submitted") {
          results.push({ state, status: built.status, reason: reasonFor(built.status, state) });
          continue;
        }
        await ctx.client.put(`${companyBase}/tax_requirements/${state}`, {
          requirement_sets: built.requirement_sets,
        });
        results.push({ state, status: "submitted" });
      }

      const statusList = await loadStateStatuses(ctx.client, companyBase);
      const stateStatuses: Record<string, { setup_complete?: boolean; ready_to_run_payroll?: boolean }> = {};
      for (const s of statusList) {
        stateStatuses[s.state] = { setup_complete: s.setup_complete, ready_to_run_payroll: s.ready_to_run_payroll };
      }
      const found = [...states];
      const allReady = found.every((s) => stateStatuses[s]?.ready_to_run_payroll === true);

      return {
        ok: true,
        data: {
          ready: allReady,
          states_found: found,
          results,
          state_statuses: stateStatuses,
        },
      };
    });
  };
}

async function loadWorkAddresses(client: { get: <T>(p: string) => Promise<{ body: T }> }, employeeUuid: string) {
  try {
    return asArray<WorkAddressRec>((await client.get(`/v1/employees/${employeeUuid}/work_addresses`)).body);
  } catch {
    return [];
  }
}

async function loadStateStatuses(
  client: { get: <T>(p: string) => Promise<{ body: T }> },
  companyBase: string,
): Promise<StateStatusRec[]> {
  try {
    return asArray<StateStatusRec>((await client.get(`${companyBase}/tax_requirements`)).body);
  } catch {
    return [];
  }
}

function reasonFor(status: string, state: string): string {
  if (status === "needs_manual_setup")
    return `${state} has no new-employer default rate available; enter the actual rate.`;
  return `${state} does not expose usedefaultsuirates - needs the employer's actual rate.`;
}

// ───────────────────────────── setup pay-schedule ─────────────────────────────
// Delegates to the existing pay-schedule create handler so setup is the unified
// surface without duplicating frequency/date-math logic.

// ───────────────────────────── company forms ─────────────────────────────

interface FormsOpts extends ContextOpts {
  note?: string;
  demoSign?: boolean;
  signatureText?: string;
  ipAddress?: string;
}

interface FormRec {
  uuid: string;
  name?: string;
  signed_at?: string | null;
  requires_signing?: boolean;
}

export function formsHandler(opts: FormsOpts, isTty = process.stdout.isTTY === true): CommandHandler {
  return async ({ globals }) => {
    if (opts.demoSign) return demoSignHandler(opts)({ command: "gusto company forms", globals });
    return hostedSigningFlow(opts, globals, isTty);
  };
}

async function hostedSigningFlow(opts: FormsOpts, globals: GlobalFlags, isTty: boolean): Promise<CommandResult> {
  return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
    const body = {
      flow_type: "sign_all_forms",
      ...(opts.note ? { options: { note: opts.note } } : {}),
    };
    const result = (await ctx.client.post<{ url: string }>(`/v1/companies/${ctx.companyUuid}/flows`, body)).body;
    if (isTty && !globals.agent && !globals.json) {
      // Best-effort: a headless/SSH box with no browser-opener must not fail the
      // command - the URL in the response is the deliverable.
      await defaultOpenBrowser(result.url).catch(() => {});
    }
    return {
      ok: true,
      data: {
        flow_type: "sign_all_forms",
        url: result.url,
        message: `Signing flow ready. Surface this URL to the signatory: ${result.url}`,
      },
    };
  });
}

function demoSignHandler(opts: FormsOpts): CommandHandler {
  return async ({ globals }) => {
    if (!opts.signatureText) {
      return missingArgs([{ field: "signature-text", reason: "required for --demo-sign (full legal name)" }]);
    }
    const ip = opts.ipAddress ?? "127.0.0.1";
    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const forms = asArray<FormRec>((await ctx.client.get(`/v1/companies/${ctx.companyUuid}/forms`)).body);
      const unsigned = forms.filter((f) => !f.signed_at && f.requires_signing === true);
      if (unsigned.length === 0) {
        return { ok: true, data: { forms_signed: 0, total: 0, message: "All forms already signed." } };
      }
      let signed = 0;
      const failures: { form: string; error: string }[] = [];
      for (const f of unsigned) {
        try {
          await ctx.client.put(`/v1/forms/${f.uuid}/sign`, {
            signature_text: opts.signatureText,
            agree: true,
            signed_by_ip_address: ip,
          });
          signed++;
        } catch (err) {
          failures.push({ form: f.name ?? f.uuid, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return {
        ok: failures.length === 0,
        ...(failures.length === 0
          ? {
              data: {
                forms_signed: signed,
                total: unsigned.length,
                message: `Signed ${signed} of ${unsigned.length} forms.`,
              },
            }
          : {
              exitCode: ExitCode.ApiClient,
              error: {
                code: "form_signing_failed",
                message: `Signed ${signed} of ${unsigned.length} forms; ${failures.length} failed.`,
                details: failures,
              },
            }),
      } as CommandResult;
    });
  };
}

// ───────────────────────────── registration ─────────────────────────────

export function registerCompanySetup(company: Command, parent: Command): void {
  const setup = company.command("setup").description("Provide information for an onboarding sub-domain");

  setup
    .command("federal-tax")
    .description("Set EIN, taxpayer type, filing form, and legal name (completes federal_tax_setup)")
    .option("--ein <ein>", "9-digit EIN")
    .option("--tax-payer-type <type>", "IRS entity classification, e.g. S-Corporation, LLC, Sole proprietor")
    .option("--filing-form <form>", '"941" (quarterly) or "944" (annual)')
    .option("--legal-name <name>", "Legal name on file with the IRS")
    .option("--taxable-as-scorp", "S-corp election (auto-on for tax-payer-type=S-Corporation)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: FederalTaxOpts) =>
      runCommand("gusto company setup federal-tax", readGlobalFlags(parent.opts()), federalTaxHandler(opts)),
    );

  setup
    .command("bank-account")
    .description("Connect + verify a company bank account in one shot")
    .option("--routing <num>", "9-digit US routing number")
    .option("--account-number <num>", "Bank account number")
    .option("--account-type <type>", "Checking or Savings")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: BankAccountOpts) =>
      runCommand("gusto company setup bank-account", readGlobalFlags(parent.opts()), bankAccountHandler(opts)),
    );

  setup
    .command("state-tax")
    .description("Auto-detect states from employee work addresses; opt into new-employer default rates (CA/TX/FL)")
    .option("--no-temporary-rates", "Do not apply new-employer default rates")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Describe what setup would do without sending")
    .action((opts: StateTaxOpts) =>
      runCommand("gusto company setup state-tax", readGlobalFlags(parent.opts()), stateTaxHandler(opts)),
    );

  setup
    .command("pay-schedule")
    .description("Create the company pay schedule (frequency + anchor dates)")
    .option("--frequency <freq>", "Pay frequency: weekly, biweekly, semi-monthly, monthly")
    .option("--first-payday <date>", "First payday (YYYY-MM-DD); the API names this anchor_pay_date")
    .option("--anchor-pay-date <date>", "Alias for --first-payday")
    .option("--anchor-end-of-pay-period <date>", "Anchor end-of-period (YYYY-MM-DD)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: PayScheduleCreateOpts) =>
      runCommand("gusto company setup pay-schedule", readGlobalFlags(parent.opts()), payScheduleCreateHandler(opts)),
    );
}

export function registerCompanyForms(company: Command, parent: Command): void {
  company
    .command("forms")
    .description("Open the hosted signing flow for company forms (8655 + state agreements)")
    .option("--note <text>", "Optional note included in the signing flow")
    .option("--demo-sign", "[DEMO ONLY] server-side sign all pending forms instead of opening the hosted flow")
    .option("--signature-text <text>", "Full legal name of the signatory (required with --demo-sign)")
    .option("--ip-address <ip>", "Signer IP for --demo-sign (default 127.0.0.1)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: FormsOpts) => runCommand("gusto company forms", readGlobalFlags(parent.opts()), formsHandler(opts)));
}
