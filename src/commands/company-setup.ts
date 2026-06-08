import type { Command } from "commander";
import { type CompanyApiContext, withCompanyContext } from "../lib/api-context.ts";
import { ApiError } from "../lib/api-client.ts";
import { errMsg } from "../lib/errors.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { defaultOpenBrowser } from "../lib/oauth/login.ts";
import {
  type StateTaxBuildStatus,
  type TaxRequirementsResponse,
  TEMPORARY_RATE_STATES,
  buildTaxRequirementSets,
} from "../lib/state-tax.ts";
import { type BlockedOn } from "../lib/output.ts";
import { type CommandHandler, type CommandResult, missingArgs, runCommand } from "../lib/runner.ts";
import { type PayScheduleCreateOpts, payScheduleCreateHandler } from "./pay-schedule.ts";

interface ContextOpts {
  companyUuid?: string;
  token?: string;
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

interface FederalTaxFields {
  ein: string;
  taxPayerType: string;
  filingForm: string;
  legalName: string;
  taxableAsScorp?: boolean;
}

/** The federal_tax_details request body. Built once so the dry-run preview and
 * the real PUT can't drift. `version` is omitted for dry-run (read at send time). */
function federalTaxBody(fields: FederalTaxFields, version?: string): Record<string, unknown> {
  return {
    ...(version !== undefined ? { version } : {}),
    ein: fields.ein,
    tax_payer_type: fields.taxPayerType,
    filing_form: fields.filingForm,
    legal_name: fields.legalName,
    ...(fields.taxableAsScorp !== undefined ? { taxable_as_scorp: fields.taxableAsScorp } : {}),
  };
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

export function einAlreadyInUse(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 422) return false;
  // Test each error message in isolation - matching over a concatenated blob
  // could splice "ein" from one error and "already in use" from another and
  // trigger an EIN rotation the user never authorized.
  const re = /ein\b.*already in use/i;
  const messages: string[] = [err.message];
  const body = err.body;
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; error?: unknown; errors?: unknown[] };
    if (typeof b.message === "string") messages.push(b.message);
    if (typeof b.error === "string") messages.push(b.error);
    if (Array.isArray(b.errors)) {
      for (const e of b.errors) {
        const m = (e as { message?: unknown })?.message;
        if (typeof m === "string") messages.push(m);
      }
    }
  }
  return messages.some((m) => re.test(m));
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
    const { ein, taxPayerType, filingForm, legalName } = opts;
    // blockers already guaranteed these; re-check narrows the types via control
    // flow (no non-null assertions). Unreachable when blocked was empty.
    if (!ein || !taxPayerType || !filingForm || !legalName) return missingArgs(blocked);
    const fields: FederalTaxFields = {
      ein,
      taxPayerType,
      filingForm,
      legalName,
      ...(taxableAsScorp !== undefined ? { taxableAsScorp } : {}),
    };

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/companies/{company_uuid}/federal_tax_details",
          body: federalTaxBody(fields),
          note: "dry-run: version is read from current federal_tax_details at send time",
        },
      };
    }

    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}/federal_tax_details`;

      const attempt = async (ein: string): Promise<unknown> => {
        const current = (await ctx.client.get<{ version?: string }>(base)).body;
        return (await ctx.client.put(base, federalTaxBody({ ...fields, ein }, current.version))).body;
      };

      // Staging persists EINs across runs, so a fixture EIN often collides on a
      // re-run. On a 422 "already in use", rotate to a fresh fabricated EIN once.
      // NEVER in production - fabricating an EIN there would register a bogus
      // number for the company's IRS filings. There, surface the 422 instead.
      const mayRotate = globals.env !== "production";
      let einUsed = fields.ein;
      let result: unknown;
      let einAutoRotated = false;
      let einProvided: string | null = null;
      try {
        result = await attempt(einUsed);
      } catch (err) {
        if (!mayRotate || !einAlreadyInUse(err)) throw err;
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

/** The bank_accounts create body. Built once so dry-run and the real POST can't drift. */
function bankAccountBody(opts: BankAccountOpts): Record<string, unknown> {
  return { routing_number: opts.routing, account_number: opts.accountNumber, account_type: opts.accountType };
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
          body: bankAccountBody(opts),
          note: "dry-run: send_test_deposits + verify follow on send",
        },
      };
    }

    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}/bank_accounts`;
      const bank = (await ctx.client.post<{ uuid?: string }>(base, bankAccountBody(opts))).body;
      if (!bank.uuid) {
        return {
          ok: false,
          exitCode: ExitCode.ApiServer,
          error: { code: "bank_create_no_uuid", message: "bank account create returned no uuid", details: bank },
        };
      }
      const bankUuid = bank.uuid;

      // The account now exists. If a later phase fails, surface the uuid + which
      // phase so the agent can resume verification instead of re-creating it.
      let phase: "send_test_deposits" | "verify" = "send_test_deposits";
      try {
        const deposits = (
          await ctx.client.post<{ deposit_1?: number | string | null; deposit_2?: number | string | null }>(
            `${base}/${bankUuid}/send_test_deposits`,
          )
        ).body;
        // Guard a malformed test-deposit response so we don't PUT bogus amounts and
        // mask the real cause behind a generic verify 422. null/undefined/empty/
        // non-numeric are all rejected - Number(null) and Number("") are both 0
        // (finite), so isFinite alone isn't enough.
        const badAmount = (v: unknown) =>
          v == null || (typeof v === "string" && v.trim() === "") || !Number.isFinite(Number(v));
        if (badAmount(deposits.deposit_1) || badAmount(deposits.deposit_2)) {
          throw new Error(
            `send_test_deposits returned non-numeric amounts (deposit_1=${deposits.deposit_1}, deposit_2=${deposits.deposit_2})`,
          );
        }
        phase = "verify";
        await ctx.client.put(`${base}/${bankUuid}/verify`, {
          deposit_1: Number(deposits.deposit_1),
          deposit_2: Number(deposits.deposit_2),
        });
      } catch (err) {
        return {
          ok: false,
          exitCode: err instanceof ApiError ? err.exitCode : ExitCode.General,
          error: {
            code: "bank_verification_failed",
            message: `Bank account ${bankUuid} was created but ${phase} failed. Retry verification on this account rather than re-creating it.`,
            details: { bank_account_uuid: bankUuid, phase, error: errMsg(err) },
          },
        };
      }

      const last4 = (opts.accountNumber ?? "").slice(-4);
      return {
        ok: true,
        data: {
          bank_account_uuid: bankUuid,
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

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          note: "state-tax setup is discovery-driven: it reads states from employee work addresses, then PUTs /v1/companies/{company_uuid}/tax_requirements/{state} to opt into the new-employer default rate where supported.",
          temporary_rate_states: TEMPORARY_RATE_STATES,
          use_temporary_rates: useTemporaryRates,
        },
      };
    }

    // 3-step orchestrator: discover states -> submit requirements -> read back readiness.
    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const { states, errors: discoverErrors } = await discoverEmployeeStates(ctx);
      const partialErrors: PartialError[] = [...discoverErrors];
      if (states.size === 0) {
        return {
          ok: false,
          exitCode: ExitCode.Blocked,
          error: {
            code: "no_work_addresses",
            message: "No employee work addresses found. Add employees before setting up state taxes.",
            ...(partialErrors.length > 0 ? { details: partialErrors } : {}),
          },
        };
      }
      const results = await submitStateRequirements(ctx, states, useTemporaryRates);
      const { statuses: stateStatuses, errors: readinessErrors } = await loadReadiness(ctx);
      partialErrors.push(...readinessErrors);
      const found = [...states];
      const allReady = found.every((s) => stateStatuses[s]?.ready_to_run_payroll === true);

      return {
        ok: true,
        data: {
          ready: allReady,
          states_found: found,
          results,
          state_statuses: stateStatuses,
          ...(partialErrors.length > 0 ? { partial_errors: partialErrors } : {}),
        },
      };
    });
  };
}

type PartialError = { label: string; error: string };
// Discriminated on `status` so callers can't read `reason`/`error` for the wrong state.
type StateResult =
  | { state: string; status: "submitted" }
  | { state: string; status: "needs_manual_setup" | "no_default_rate_question"; reason: string }
  | { state: string; status: "error"; error: string };
type StateStatuses = Record<string, { setup_complete?: boolean; ready_to_run_payroll?: boolean }>;

/** Discover the states to set up from employee work addresses, back-filling a
 * missing work address from the primary location. Per-employee failures are
 * recorded in `partialErrors` rather than silently shrinking the set. */
async function discoverEmployeeStates(
  ctx: CompanyApiContext,
): Promise<{ states: Set<string>; errors: PartialError[] }> {
  const companyBase = `/v1/companies/${ctx.companyUuid}`;
  // Independent reads - fetch together.
  const [employeesRes, locationsRes] = await Promise.all([
    ctx.client.get(`${companyBase}/employees`),
    ctx.client.get(`${companyBase}/locations`),
  ]);
  const employees = asArray<EmployeeRec>(employeesRes.body);
  const locations = asArray<LocationRec>(locationsRes.body);
  const primaryLocationUuid = locations[0]?.uuid;

  // Each employee is independent, so resolve them in parallel and merge. Per-employee
  // failures are collected locally so one bad employee doesn't abort the rest.
  const perEmployee = await Promise.all(employees.map((emp) => statesForEmployee(ctx, emp, primaryLocationUuid)));

  const states = new Set<string>();
  const errors: PartialError[] = [];
  for (const r of perEmployee) {
    for (const s of r.found) states.add(s);
    errors.push(...r.errors);
  }
  return { states, errors };
}

/** Active work-address states for one employee, back-filling a missing address from
 * the primary location when the employee has a job. Failures surface as partial errors. */
async function statesForEmployee(
  ctx: CompanyApiContext,
  emp: EmployeeRec,
  primaryLocationUuid: string | undefined,
): Promise<{ found: string[]; errors: PartialError[] }> {
  const found: string[] = [];
  const errors: PartialError[] = [];
  let workAddresses: WorkAddressRec[];
  try {
    workAddresses = await loadWorkAddresses(ctx.client, emp.uuid);
  } catch (err) {
    errors.push({ label: `work_addresses:${emp.uuid}`, error: errMsg(err) });
    return { found, errors };
  }

  const hasJob = Array.isArray(emp.jobs) && emp.jobs.length > 0;
  if (hasJob && workAddresses.length === 0) {
    if (!primaryLocationUuid) {
      errors.push({
        label: `no_location_to_provision:${emp.uuid}`,
        error: "employee has a job but no work address and no company location to back-fill from",
      });
    } else {
      try {
        await ctx.client.post(`/v1/employees/${emp.uuid}/work_addresses`, {
          location_uuid: primaryLocationUuid,
          active: true,
          effective_date: new Date().toISOString().slice(0, 10),
        });
        workAddresses = await loadWorkAddresses(ctx.client, emp.uuid);
      } catch (err) {
        errors.push({ label: `provision_work_address:${emp.uuid}`, error: errMsg(err) });
      }
    }
  }
  for (const wa of workAddresses) {
    if (wa.active === true && wa.state) found.push(wa.state);
  }
  return { found, errors };
}

/** Opt each state into the new-employer default rate where supported. Per-state
 * try/catch so a mid-loop failure doesn't discard states already submitted. */
async function submitStateRequirements(
  ctx: CompanyApiContext,
  states: Set<string>,
  useTemporaryRates: boolean,
): Promise<StateResult[]> {
  const companyBase = `/v1/companies/${ctx.companyUuid}`;
  // States are independent; submit in parallel. Per-state try/catch keeps one
  // failure from discarding the others, and Promise.all preserves result order.
  return Promise.all(
    [...states].map(async (state): Promise<StateResult> => {
      try {
        const reqs = (await ctx.client.get<TaxRequirementsResponse>(`${companyBase}/tax_requirements/${state}`)).body;
        const built = buildTaxRequirementSets(reqs, state, useTemporaryRates);
        if (built.status !== "submitted") {
          return { state, status: built.status, reason: reasonFor(built.status, state) };
        }
        await ctx.client.put(`${companyBase}/tax_requirements/${state}`, { requirement_sets: built.requirement_sets });
        return { state, status: "submitted" };
      } catch (err) {
        return { state, status: "error", error: errMsg(err) };
      }
    }),
  );
}

/** Read back per-state readiness. A failed GET is returned as an error entry
 * rather than masquerading as "not ready". */
async function loadReadiness(ctx: CompanyApiContext): Promise<{ statuses: StateStatuses; errors: PartialError[] }> {
  const companyBase = `/v1/companies/${ctx.companyUuid}`;
  const statuses: StateStatuses = {};
  try {
    for (const s of await loadStateStatuses(ctx.client, companyBase)) {
      statuses[s.state] = { setup_complete: s.setup_complete, ready_to_run_payroll: s.ready_to_run_payroll };
    }
  } catch (err) {
    return { statuses, errors: [{ label: "tax_requirements_status", error: errMsg(err) }] };
  }
  return { statuses, errors: [] };
}

/** Minimal read surface of ApiClient the load helpers need. */
type ReadClient = { get: <T>(p: string) => Promise<{ body: T }> };

async function loadWorkAddresses(client: ReadClient, employeeUuid: string): Promise<WorkAddressRec[]> {
  return asArray<WorkAddressRec>((await client.get(`/v1/employees/${employeeUuid}/work_addresses`)).body);
}

async function loadStateStatuses(client: ReadClient, companyBase: string): Promise<StateStatusRec[]> {
  return asArray<StateStatusRec>((await client.get(`${companyBase}/tax_requirements`)).body);
}

function reasonFor(status: StateTaxBuildStatus, state: string): string {
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
}

interface FormRec {
  uuid: string;
  name?: string;
  signed_at?: string | null;
  requires_signing?: boolean;
}

export function formsHandler(opts: FormsOpts, isTty = process.stdout.isTTY === true): CommandHandler {
  return async ({ globals }) => {
    if (opts.demoSign) return demoSign(opts, globals);
    return hostedSigningFlow(opts, globals, isTty);
  };
}

async function hostedSigningFlow(opts: FormsOpts, globals: GlobalFlags, isTty: boolean): Promise<CommandResult> {
  return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
    const body = {
      flow_type: "sign_all_forms",
      ...(opts.note ? { options: { note: opts.note } } : {}),
    };
    const result = (await ctx.client.post<{ url?: string }>(`/v1/companies/${ctx.companyUuid}/flows`, body)).body;
    if (!result.url) {
      return {
        ok: false,
        exitCode: ExitCode.ApiServer,
        error: { code: "flow_no_url", message: "flow create returned no signing url", details: result },
      };
    }
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

async function demoSign(opts: FormsOpts, globals: GlobalFlags): Promise<CommandResult> {
  // Demo escape hatch: never allow server-side signing against production - it
  // bypasses the legally-defensible hosted flow. Force the hosted path there.
  if (globals.env === "production") {
    return {
      ok: false,
      exitCode: ExitCode.Blocked,
      error: {
        code: "demo_only",
        message:
          "`--demo-sign` is a non-production demo escape hatch. In production run `gusto company forms` (the hosted signing flow) so the signatory signs in Gusto's hosted UI.",
      },
    };
  }
  if (!opts.signatureText) {
    return missingArgs([{ field: "signature-text", reason: "required for --demo-sign (full legal name)" }]);
  }
  // Always sign from localhost - a demo escape hatch has no business accepting a
  // caller-supplied IP, which would let the signer's location be spoofed in the
  // audit trail.
  const ip = "127.0.0.1";
  return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
    const forms = asArray<FormRec>((await ctx.client.get(`/v1/companies/${ctx.companyUuid}/forms`)).body);
    const unsigned = forms.filter((f) => !f.signed_at && f.requires_signing === true);
    if (unsigned.length === 0) {
      return { ok: true, data: { forms_signed: 0, total: 0, message: "All forms already signed." } };
    }
    // Each form signs independently; sign in parallel and collect failures.
    const outcomes = await Promise.all(
      unsigned.map(async (f) => {
        try {
          await ctx.client.put(`/v1/forms/${f.uuid}/sign`, {
            signature_text: opts.signatureText,
            agree: true,
            signed_by_ip_address: ip,
          });
          return null;
        } catch (err) {
          return { form: f.name ?? f.uuid, error: errMsg(err) };
        }
      }),
    );
    const failures = outcomes.filter((o): o is { form: string; error: string } => o !== null);
    const signed = unsigned.length - failures.length;
    if (failures.length === 0) {
      return {
        ok: true,
        data: {
          forms_signed: signed,
          total: unsigned.length,
          message: `Signed ${signed} of ${unsigned.length} forms.`,
        },
      };
    }
    return {
      ok: false,
      exitCode: ExitCode.ApiClient,
      error: {
        code: "form_signing_failed",
        message: `Signed ${signed} of ${unsigned.length} forms; ${failures.length} failed.`,
        details: failures,
      },
    };
  });
}

// ───────────────────────────── registration ─────────────────────────────

/** The --company-uuid / --token override options every company command shares. */
export function withContextOptions(cmd: Command): Command {
  return cmd
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)");
}

const DRY_RUN_OPT = ["--dry-run", "Build the request without sending"] as const;
const EXAMPLE_OPT = ["--example", "Print a canned sample payload without calling the API"] as const;

export function registerCompanySetup(company: Command, parent: Command): void {
  const setup = company.command("setup").description("Provide information for an onboarding sub-domain");

  withContextOptions(
    setup
      .command("federal-tax")
      .description("Set EIN, taxpayer type, filing form, and legal name (completes federal_tax_setup)")
      .option("--ein <ein>", "9-digit EIN")
      .option("--tax-payer-type <type>", "IRS entity classification, e.g. S-Corporation, LLC, Sole proprietor")
      .option("--filing-form <form>", '"941" (quarterly) or "944" (annual)')
      .option("--legal-name <name>", "Legal name on file with the IRS")
      .option("--taxable-as-scorp", "S-corp election (auto-on for tax-payer-type=S-Corporation)"),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: FederalTaxOpts) =>
      runCommand("gusto company setup federal-tax", readGlobalFlags(parent.opts()), federalTaxHandler(opts)),
    );

  withContextOptions(
    setup
      .command("bank-account")
      .description("Connect + verify a company bank account in one shot")
      .option("--routing <num>", "9-digit US routing number")
      .option("--account-number <num>", "Bank account number")
      .option("--account-type <type>", "Checking or Savings"),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: BankAccountOpts) =>
      runCommand("gusto company setup bank-account", readGlobalFlags(parent.opts()), bankAccountHandler(opts)),
    );

  withContextOptions(
    setup
      .command("state-tax")
      .description("Auto-detect states from employee work addresses; opt into new-employer default rates (CA/TX/FL)")
      .option("--no-temporary-rates", "Do not apply new-employer default rates"),
  )
    .option("--dry-run", "Describe what setup would do without sending")
    .action((opts: StateTaxOpts) =>
      runCommand("gusto company setup state-tax", readGlobalFlags(parent.opts()), stateTaxHandler(opts)),
    );

  withContextOptions(
    setup
      .command("pay-schedule")
      .description("Create the company pay schedule (frequency + anchor dates)")
      .option("--frequency <freq>", "Pay frequency: weekly, biweekly, semi-monthly, monthly")
      .option("--first-payday <date>", "First payday (YYYY-MM-DD); the API names this anchor_pay_date")
      .option("--anchor-pay-date <date>", "Alias for --first-payday")
      .option("--anchor-end-of-pay-period <date>", "Anchor end-of-period (YYYY-MM-DD)"),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: PayScheduleCreateOpts) =>
      runCommand("gusto company setup pay-schedule", readGlobalFlags(parent.opts()), payScheduleCreateHandler(opts)),
    );
}

export function registerCompanyForms(company: Command, parent: Command): void {
  withContextOptions(
    company
      .command("forms")
      .description("Open the hosted signing flow for company forms (8655 + state agreements)")
      .option("--note <text>", "Optional note included in the signing flow")
      .option(
        "--demo-sign",
        "[DEMO ONLY, non-production] server-side sign all pending forms instead of the hosted flow",
      )
      .option("--signature-text <text>", "Full legal name of the signatory (required with --demo-sign)"),
  ).action((opts: FormsOpts) => runCommand("gusto company forms", readGlobalFlags(parent.opts()), formsHandler(opts)));
}
