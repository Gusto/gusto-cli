import type { Command } from "commander";
import { type CompanyApiContext, withCompanyContext } from "../lib/api-context.ts";
import { ApiError, type ReadClient } from "../lib/api-client.ts";
import { bankCreateNoUuidError } from "../lib/bank-account.ts";
import { DRY_RUN_OPT, EXAMPLE_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { errMsg } from "../lib/errors.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { partialFailure } from "../lib/handle-api-error.ts";
import { type LocationRec, pickPrimaryLocation } from "../lib/locations.ts";
import { type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { defaultOpenBrowser } from "../lib/browser.ts";
import {
  type StateTaxBuildStatus,
  type TaxRequirementsResponse,
  TEMPORARY_RATE_STATES,
  buildTaxRequirementSets,
} from "../lib/state-tax.ts";
import { type BlockedOn } from "../lib/output.ts";
import { companyHasSignatory } from "../lib/signatory.ts";
import { type CommandHandler, type CommandResult, missingArgs, runCommand } from "../lib/runner.ts";
import { addPayScheduleOptions, type PayScheduleCreateOpts, payScheduleCreateHandler } from "../lib/pay-schedule.ts";

interface ContextOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
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

/** A fabricated 9-digit EIN in XX-XXXXXXX form. Used only outside production
 * (the sandbox env) when the provided EIN collides with another company. */
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

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}/federal_tax_details`;

      const attempt = async (ein: string): Promise<unknown> => {
        const current = (await ctx.client.get<{ version?: string }>(base)).body;
        return (await ctx.client.put(base, federalTaxBody({ ...fields, ein }, current.version))).body;
      };

      // Sandbox persists EINs across runs, so a fixture EIN often collides on a
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
        try {
          result = await attempt(einUsed);
        } catch (retryErr) {
          // The rotated EIN also failed - surface the rotation context instead of a
          // generic error that hides that a fabricated EIN was tried.
          return {
            ok: false,
            exitCode: retryErr instanceof ApiError ? retryErr.exitCode : ExitCode.General,
            error: {
              code: "ein_rotation_failed",
              message: `EIN ${einProvided} was already in use; retried with a fabricated EIN (${einUsed}) which also failed.`,
              details: { ein_provided: einProvided, ein_used: einUsed, error: errMsg(retryErr) },
            },
          };
        }
      }

      return {
        ok: true,
        data: {
          federal_tax: result,
          ein_used: einUsed,
          tax_payer_type: taxPayerType,
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

interface BankAccountFields {
  routing: string;
  accountNumber: string;
  accountType: string;
}

/** The bank_accounts create body. Built once so dry-run and the real POST can't drift. */
function bankAccountBody(fields: BankAccountFields): Record<string, unknown> {
  return { routing_number: fields.routing, account_number: fields.accountNumber, account_type: fields.accountType };
}

export function bankAccountHandler(opts: BankAccountOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/bank_accounts",
          // https://docs.gusto.com/embedded-payroll/docs/manage-company-bank-accounts
          body: { routing_number: "102001017", account_number: "9775014007", account_type: "Checking" },
          note: "example: connect runs create -> send_test_deposits -> verify in one shot",
        },
      };
    }

    const blocked = bankAccountBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    const { routing, accountNumber, accountType } = opts;
    // blockers guarantee these; re-check narrows the types without assertions.
    if (!routing || !accountNumber || !accountType) return missingArgs(blocked);
    const fields: BankAccountFields = { routing, accountNumber, accountType };

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/bank_accounts",
          body: bankAccountBody(fields),
          note: "dry-run: send_test_deposits + verify follow on send",
        },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}/bank_accounts`;
      const bank = (await ctx.client.post<{ uuid?: string }>(base, bankAccountBody(fields))).body;
      if (!bank.uuid) {
        return bankCreateNoUuidError(bank);
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
        // partialFailure routes through toResult, so the server response body
        // (e.g. a 422's errors[].message) is preserved under failed.error.details -
        // the agent gets the actual reason verify failed, not just "PUT ... -> 422".
        return partialFailure({
          code: "bank_verification_failed",
          message: `Bank account ${bankUuid} was created but ${phase} failed; retry verification on this account rather than re-creating it`,
          err,
          completed: { bank_account: bankUuid },
          failedDomain: phase,
        });
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
    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
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
      // `ready` reconciles the readback against this run's submit results. A state
      // whose submit errored this run can never count as ready, even if the
      // readback reports ready_to_run_payroll (that reflects out-of-band state and
      // would otherwise mask the failure — AINT-609 secondary issue).
      const erroredStates = new Set(results.filter((r) => r.status === "error").map((r) => r.state));
      const allReady = found.every((s) => stateStatuses[s]?.ready_to_run_payroll === true && !erroredStates.has(s));

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
  const primaryLocationUuid = pickPrimaryLocation(locations)?.uuid;

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
    const backFill = await provisionAndReloadWorkAddresses(ctx, emp, primaryLocationUuid);
    workAddresses = backFill.workAddresses;
    errors.push(...backFill.errors);
  }
  for (const wa of workAddresses) {
    if (wa.active === true && wa.state) found.push(wa.state);
  }
  return { found, errors };
}

/** Back-fill a missing work address from the company's primary location, then reload.
 * Returns whatever addresses we end up with (empty if provisioning failed) plus any
 * partial errors. Pulled out of statesForEmployee to keep that function flat. */
async function provisionAndReloadWorkAddresses(
  ctx: CompanyApiContext,
  emp: EmployeeRec,
  primaryLocationUuid: string | undefined,
): Promise<{ workAddresses: WorkAddressRec[]; errors: PartialError[] }> {
  if (!primaryLocationUuid) {
    return {
      workAddresses: [],
      errors: [
        {
          label: `no_location_to_provision:${emp.uuid}`,
          error: "employee has a job but no work address and no company location to back-fill from",
        },
      ],
    };
  }

  try {
    await ctx.client.post(`/v1/employees/${emp.uuid}/work_addresses`, {
      location_uuid: primaryLocationUuid,
      active: true,
      effective_date: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    return { workAddresses: [], errors: [{ label: `provision_work_address:${emp.uuid}`, error: errMsg(err) }] };
  }

  // Reload separately: the POST succeeded, so if the reload fails the address still
  // exists server-side. Label it as a reload failure (not a provisioning one) to avoid
  // implying the POST failed and prompting a duplicate re-POST.
  try {
    return { workAddresses: await loadWorkAddresses(ctx.client, emp.uuid), errors: [] };
  } catch (err) {
    return { workAddresses: [], errors: [{ label: `reload_work_addresses:${emp.uuid}`, error: errMsg(err) }] };
  }
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

async function loadWorkAddresses(client: ReadClient, employeeUuid: string): Promise<WorkAddressRec[]> {
  return asArray<WorkAddressRec>((await client.get(`/v1/employees/${employeeUuid}/work_addresses`)).body);
}

async function loadStateStatuses(client: ReadClient, companyBase: string): Promise<StateStatusRec[]> {
  return asArray<StateStatusRec>((await client.get(`${companyBase}/tax_requirements`)).body);
}

function reasonFor(status: Exclude<StateTaxBuildStatus, "submitted">, state: string): string {
  if (status === "needs_manual_setup")
    return `${state} has no new-employer default rate available; enter the actual rate.`;
  return `${state} does not expose usedefaultsuirates - needs the employer's actual rate.`;
}

// ───────────────────────────── setup pay-schedule ─────────────────────────────
// Delegates to the existing pay-schedule create handler so setup is the unified
// surface without duplicating frequency/date-math logic.

// ───────────────────────────── setup signatory ─────────────────────────────
// Assigns the company signatory as a discrete step, before form signing. Uses the
// invite flow (name + email; the signatory completes their own PII) so it's
// non-interactive and agent-drivable — mirroring the employee-add invite default.

interface SignatoryOpts extends ContextOpts {
  firstName?: string;
  lastName?: string;
  email?: string;
  title?: string;
  dryRun?: boolean;
  example?: boolean;
}

export function signatoryBlockers(opts: SignatoryOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.firstName) blocked.push({ field: "first-name", reason: "required" });
  if (!opts.lastName) blocked.push({ field: "last-name", reason: "required" });
  if (!opts.email) blocked.push({ field: "email", reason: "required (the invite is sent here)" });
  return blocked;
}

interface SignatoryFields {
  firstName: string;
  lastName: string;
  email: string;
  title?: string;
}

/** The signatories/invite request body. Built once so dry-run and the real POST can't drift. */
function signatoryBody(fields: SignatoryFields): Record<string, unknown> {
  return {
    first_name: fields.firstName,
    last_name: fields.lastName,
    email: fields.email,
    ...(fields.title ? { title: fields.title } : {}),
  };
}

export function signatoryHandler(opts: SignatoryOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/signatories/invite",
          body: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", title: "CEO" },
          note: "example: invites the signatory; they complete their own PII before signing forms",
        },
      };
    }

    const blocked = signatoryBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    const { firstName, lastName, email } = opts;
    // blockers guarantee these; re-check narrows the types without assertions.
    if (!firstName || !lastName || !email) return missingArgs(blocked);
    const fields: SignatoryFields = { firstName, lastName, email, ...(opts.title ? { title: opts.title } : {}) };

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/signatories/invite",
          body: signatoryBody(fields),
        },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const signatory = (
        await ctx.client.post<{ uuid?: string }>(
          `/v1/companies/${ctx.companyUuid}/signatories/invite`,
          signatoryBody(fields),
        )
      ).body;
      return {
        ok: true,
        data: {
          signatory,
          message: `Invited ${firstName} ${lastName} as the company signatory.`,
        },
      };
    });
  };
}

// ───────────────────────────── setup address ─────────────────────────────

interface AddressOpts extends ContextOpts {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  // commander negatable flags: default true, --no-filing-address / --no-mailing-address opt out.
  filingAddress?: boolean;
  mailingAddress?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

export function addressBlockers(opts: AddressOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.street1) blocked.push({ field: "street-1", reason: "required (street address line 1)" });
  if (!opts.city) blocked.push({ field: "city", reason: "required" });
  if (!opts.state) blocked.push({ field: "state", reason: "required (2-letter state code, e.g. CA)" });
  if (!opts.zip) blocked.push({ field: "zip", reason: "required" });
  if (!opts.phone) blocked.push({ field: "phone", reason: "required (location phone number)" });
  return blocked;
}

interface AddressFields {
  street1: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  street2?: string;
  country?: string;
  filingAddress: boolean;
  mailingAddress: boolean;
}

/** The locations create body. Built once so dry-run and the real POST can't drift.
 * `filing_address`/`mailing_address` default true: the onboarding primary location
 * doubles as the filing + mailing address, and the filing address is what completes
 * `federal_tax_setup` (the step requires a company filing address, not just the EIN). */
function addressBody(fields: AddressFields): Record<string, unknown> {
  return {
    street_1: fields.street1,
    ...(fields.street2 ? { street_2: fields.street2 } : {}),
    city: fields.city,
    state: fields.state,
    zip: fields.zip,
    ...(fields.country ? { country: fields.country } : {}),
    phone_number: fields.phone,
    filing_address: fields.filingAddress,
    mailing_address: fields.mailingAddress,
  };
}

export function addressHandler(opts: AddressOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/locations",
          body: {
            street_1: "300 3rd St",
            city: "San Francisco",
            state: "CA",
            zip: "94107",
            phone_number: "4155550100",
            filing_address: true,
            mailing_address: true,
          },
          note: "example: the company's primary location; filing_address completes federal_tax_setup, the location clears add_addresses",
        },
      };
    }

    const blocked = addressBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    const { street1, city, state, zip, phone } = opts;
    // blockers guarantee these; re-check narrows the types without assertions.
    if (!street1 || !city || !state || !zip || !phone) return missingArgs(blocked);
    const fields: AddressFields = {
      street1,
      city,
      state,
      zip,
      phone,
      ...(opts.street2 ? { street2: opts.street2 } : {}),
      ...(opts.country ? { country: opts.country } : {}),
      filingAddress: opts.filingAddress !== false,
      mailingAddress: opts.mailingAddress !== false,
    };

    if (opts.dryRun) {
      return {
        ok: true,
        data: { method: "POST", path: "/v1/companies/{company_uuid}/locations", body: addressBody(fields) },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const location = (
        await ctx.client.post<{ uuid?: string }>(`/v1/companies/${ctx.companyUuid}/locations`, addressBody(fields))
      ).body;
      return {
        ok: true,
        data: {
          location,
          message: `Company address added in ${city}, ${state}${fields.filingAddress ? " (filing address)" : ""}.`,
        },
      };
    });
  };
}

// ───────────────────────────── setup industry ─────────────────────────────

interface IndustryOpts extends ContextOpts {
  naicsCode?: string;
  title?: string;
  sicCode?: string[];
  dryRun?: boolean;
  example?: boolean;
}

export function industryBlockers(opts: IndustryOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.naicsCode) blocked.push({ field: "naics-code", reason: "required (NAICS industry code, e.g. 541511)" });
  return blocked;
}

interface IndustryFields {
  naicsCode: string;
  title?: string;
  sicCodes?: string[];
}

/** The industry_selection body. Built once so dry-run and the real PUT can't drift.
 * Title + SIC codes are optional - the API derives them from the NAICS code when omitted. */
function industryBody(fields: IndustryFields): Record<string, unknown> {
  return {
    naics_code: fields.naicsCode,
    ...(fields.title ? { title: fields.title } : {}),
    ...(fields.sicCodes && fields.sicCodes.length > 0 ? { sic_codes: fields.sicCodes } : {}),
  };
}

export function industryHandler(opts: IndustryOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/companies/{company_uuid}/industry_selection",
          body: { naics_code: "541511", title: "Custom Computer Programming Services" },
          note: "example: title + sic_codes are derived from the NAICS code when omitted",
        },
      };
    }

    const blocked = industryBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    const { naicsCode } = opts;
    // blockers guarantee this; re-check narrows the type without an assertion.
    if (!naicsCode) return missingArgs(blocked);
    const fields: IndustryFields = {
      naicsCode,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.sicCode && opts.sicCode.length > 0 ? { sicCodes: opts.sicCode } : {}),
    };

    if (opts.dryRun) {
      return {
        ok: true,
        data: { method: "PUT", path: "/v1/companies/{company_uuid}/industry_selection", body: industryBody(fields) },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const industry = (
        await ctx.client.put<{ naics_code?: string }>(
          `/v1/companies/${ctx.companyUuid}/industry_selection`,
          industryBody(fields),
        )
      ).body;
      return { ok: true, data: { industry, message: `Industry set to NAICS ${naicsCode}.` } };
    });
  };
}

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

export function formsHandler(
  opts: FormsOpts,
  isTty = process.stdout.isTTY === true,
  openBrowser: (url: string) => Promise<void> = defaultOpenBrowser,
): CommandHandler {
  return async ({ globals }) => {
    if (opts.demoSign) return demoSign(opts, globals);
    return hostedSigningFlow(opts, globals, isTty, openBrowser);
  };
}

async function hostedSigningFlow(
  opts: FormsOpts,
  globals: GlobalFlags,
  isTty: boolean,
  openBrowser: (url: string) => Promise<void>,
): Promise<CommandResult> {
  return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
    // Signatory must exist before signing: the hosted flow signs on behalf of the
    // signatory, and without one the flow folds signatory setup into what should be
    // a pure signing experience. Refuse early with an actionable next step so the
    // agent assigns the signatory first (AINT-618) rather than landing in the
    // bundled flow.
    if (!(await companyHasSignatory(ctx.client, ctx.companyUuid))) {
      return {
        ok: false,
        exitCode: ExitCode.Blocked,
        error: {
          code: "signatory_required",
          message:
            "No signatory assigned. Run `gusto company setup signatory --first-name <name> --last-name <name> --email <email>` before signing forms — the hosted flow signs on behalf of the signatory.",
        },
      };
    }
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
    // Best-effort browser open in interactive mode. A headless/SSH box with no
    // browser-opener must not fail the command - the URL is always returned in
    // `message`, and `browser_opened: false` makes a failed open observable
    // rather than silent.
    let browserOpened: boolean | undefined;
    if (isTty && !globals.agent && !globals.json) {
      browserOpened = await openBrowser(result.url).then(
        () => true,
        () => false,
      );
    }
    const couldntOpen = browserOpened === false;
    return {
      ok: true,
      data: {
        flow_type: "sign_all_forms",
        url: result.url,
        ...(couldntOpen ? { browser_opened: false } : {}),
        message: couldntOpen
          ? `Couldn't open a browser automatically. Surface this URL to the signatory: ${result.url}`
          : `Signing flow ready. Surface this URL to the signatory: ${result.url}`,
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
  // Capture after the guard so the async closure sees the narrowed `string`, not
  // `string | undefined` (the parameter narrowing is widened back inside the closure).
  const signatureText = opts.signatureText;
  // Always sign from localhost - a demo escape hatch has no business accepting a
  // caller-supplied IP, which would let the signer's location be spoofed in the
  // audit trail.
  const ip = "127.0.0.1";
  return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
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
            signature_text: signatureText,
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

/** The --company-uuid / --token-stdin auth options every company command shares. */
export function withContextOptions(cmd: Command): Command {
  return cmd.option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)").option(...TOKEN_STDIN_OPT);
}

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
    addPayScheduleOptions(
      setup.command("pay-schedule").description("Create the company pay schedule (frequency + anchor dates)"),
    ),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: PayScheduleCreateOpts) =>
      runCommand("gusto company setup pay-schedule", readGlobalFlags(parent.opts()), payScheduleCreateHandler(opts)),
    );

  withContextOptions(
    setup
      .command("signatory")
      .description("Assign the company signatory (invite) before signing forms")
      .option("--first-name <name>", "Signatory's first name")
      .option("--last-name <name>", "Signatory's last name")
      .option("--email <email>", "Email the signatory invite is sent to")
      .option("--title <title>", "Signatory's title, e.g. CEO, Owner"),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: SignatoryOpts) =>
      runCommand("gusto company setup signatory", readGlobalFlags(parent.opts()), signatoryHandler(opts)),
    );

  withContextOptions(
    setup
      .command("address")
      .description(
        "Add the company's primary location (completes add_addresses + the federal_tax_setup filing address)",
      )
      .option("--street-1 <street>", "Street address line 1")
      .option("--street-2 <street>", "Street address line 2")
      .option("--city <city>", "City")
      .option("--state <state>", "2-letter state code, e.g. CA")
      .option("--zip <zip>", "ZIP code")
      .option("--country <country>", "Country (defaults to USA server-side)")
      .option("--phone <phone>", "Location phone number (required by the locations API)")
      .option("--no-filing-address", "Don't use this location as the company's filing address")
      .option("--no-mailing-address", "Don't use this location as the company's mailing address"),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: AddressOpts) =>
      runCommand("gusto company setup address", readGlobalFlags(parent.opts()), addressHandler(opts)),
    );

  withContextOptions(
    setup
      .command("industry")
      .description("Select the company's industry (completes select_industry)")
      .option("--naics-code <code>", "NAICS industry code, e.g. 541511")
      .option("--title <title>", "Industry title (derived from the NAICS code when omitted)")
      .option("--sic-code <codes...>", "SIC code(s) (derived from the NAICS code when omitted)"),
  )
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: IndustryOpts) =>
      runCommand("gusto company setup industry", readGlobalFlags(parent.opts()), industryHandler(opts)),
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
