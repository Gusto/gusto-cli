import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { ApiClient } from "../lib/api-client.ts";
import { createCompanyResource, resolveApiContext, withCompanyContext } from "../lib/api-context.ts";
import { bankCreateNoUuidError } from "../lib/bank-account.ts";
import { DRY_RUN_OPT, EXAMPLE_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { errMsg } from "../lib/errors.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { partialFailure, toResult } from "../lib/handle-api-error.ts";
import { fetchCompanyLocations, pickPrimaryLocation } from "../lib/locations.ts";
import type { BlockedOn } from "../lib/output.ts";
import { type CommandHandler, type CommandResult, missingArgs, runCommand, validationFailure } from "../lib/runner.ts";

// `employee add` mirrors `company setup`: bare `employee add` creates the employee, then each
// sub-domain is its own subcommand (`employee add <domain> <employee_uuid>`) with typed flags, a
// blockers() validator, and a body builder. The `state-tax` and `payment-method` commands carry a
// little orchestration (discovery / bank-account create) behind their single command.

/** Every subcommand accepts --token-stdin (auth: session > env > stdin). */
interface TokenOpts {
  tokenStdin?: boolean;
}

/** Only the company-scoped create (`personal-details`) registers and reads --company-uuid; the
 * per-employee subcommands act on an employee uuid, not the company. */
interface CompanyContextOpts extends TokenOpts {
  companyUuid?: string;
}

// ───────────────────────────── add (create) ─────────────────────────────

export interface EmployeeCreateOpts extends CompanyContextOpts {
  firstName?: string;
  lastName?: string;
  email?: string;
  ssn?: string;
  dateOfBirth?: string;
  adminDriven?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

export function employeeCreateBlockers(opts: EmployeeCreateOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.firstName) blocked.push({ field: "first-name", reason: "required" });
  if (!opts.lastName) blocked.push({ field: "last-name", reason: "required" });
  if (!opts.email) blocked.push({ field: "email", reason: "required" });
  return blocked;
}

/** Create body: explicit name/email plus optional typed personal details (ssn, date_of_birth).
 * `self_onboarding` defaults true (send the invite) unless --admin-driven supplies all data. */
export function employeeCreateBody(opts: EmployeeCreateOpts): Record<string, unknown> {
  return {
    ...(opts.ssn !== undefined ? { ssn: opts.ssn } : {}),
    ...(opts.dateOfBirth !== undefined ? { date_of_birth: opts.dateOfBirth } : {}),
    first_name: opts.firstName,
    last_name: opts.lastName,
    email: opts.email,
    self_onboarding: !opts.adminDriven,
  };
}

function employeeCreateHandler(opts: EmployeeCreateOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/employees",
          body: { first_name: "Jane", last_name: "Doe", email: "jane@example.com", self_onboarding: true },
          note: "example: create the employee, then configure sub-domains with `employee add <domain> <employee_uuid>`",
        },
      };
    }
    const blocked = employeeCreateBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    return createCompanyResource(globals, "employees", employeeCreateBody(opts), {
      tokenStdin: opts.tokenStdin,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}

// ───────────────────────────── add home-address ─────────────────────────────

export interface HomeAddressOpts extends TokenOpts {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  effectiveDate?: string;
  dryRun?: boolean;
}

export function homeAddressBlockers(opts: HomeAddressOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.street1) blocked.push({ field: "street-1", reason: "required" });
  if (!opts.city) blocked.push({ field: "city", reason: "required" });
  if (!opts.state) blocked.push({ field: "state", reason: "required (2-letter code)" });
  if (!opts.zip) blocked.push({ field: "zip", reason: "required" });
  return blocked;
}

export function homeAddressBody(opts: HomeAddressOpts): Record<string, unknown> {
  return {
    street_1: opts.street1,
    ...(opts.street2 !== undefined ? { street_2: opts.street2 } : {}),
    city: opts.city,
    state: opts.state,
    zip: opts.zip,
    ...(opts.effectiveDate !== undefined ? { effective_date: opts.effectiveDate } : {}),
  };
}

function homeAddressHandler(employeeUuid: string, opts: HomeAddressOpts): CommandHandler {
  return postSubdomainHandler(
    opts,
    () => homeAddressBlockers(opts),
    `/v1/employees/${employeeUuid}/home_addresses`,
    () => homeAddressBody(opts),
  );
}

// ───────────────────────────── add work-address ─────────────────────────────

export interface WorkAddressOpts extends CompanyContextOpts {
  locationUuid?: string;
  effectiveDate?: string;
  dryRun?: boolean;
}

export function workAddressBlockers(opts: WorkAddressOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.effectiveDate) blocked.push({ field: "effective-date", reason: "required (YYYY-MM-DD)" });
  return blocked;
}

export function workAddressBody(opts: WorkAddressOpts): Record<string, unknown> {
  return { location_uuid: opts.locationUuid, effective_date: opts.effectiveDate };
}

/** Resolve the location uuid: prefer the explicit override, else pick the company's primary
 * location. Returns CommandResult so the caller can `if (!resolved.ok) return resolved;`
 * for both the fetch's structured error (e.g. malformed_response) and the zero-locations
 * validation block. */
export async function resolveWorkAddressLocation(
  client: ApiClient,
  companyUuid: string,
  override: string | undefined,
): Promise<CommandResult<{ locationUuid: string }>> {
  if (override) return { ok: true, data: { locationUuid: override } };
  const res = await fetchCompanyLocations(client, companyUuid);
  if (!res.ok) return res;
  const primary = pickPrimaryLocation(res.data ?? []);
  if (!primary) {
    return missingArgs([
      {
        field: "location-uuid",
        reason: "no company locations found; run `gusto company setup address` first, or pass --location-uuid <uuid>",
      },
    ]);
  }
  return { ok: true, data: { locationUuid: primary.uuid } };
}

export function workAddressHandler(employeeUuid: string, opts: WorkAddressOpts): CommandHandler {
  return async ({ globals }) => {
    const blocked = workAddressBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    const path = `/v1/employees/${employeeUuid}/work_addresses`;

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "POST",
          path,
          body: workAddressBody(opts),
          ...(opts.locationUuid
            ? {}
            : { note: "dry-run: without --location-uuid the company's primary location is resolved at send time" }),
        },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const resolved = await resolveWorkAddressLocation(ctx.client, ctx.companyUuid, opts.locationUuid);
      if (!resolved.ok) return resolved;
      const { locationUuid } = resolved.data!;
      const res = await ctx.client.post(path, { location_uuid: locationUuid, effective_date: opts.effectiveDate });
      const body =
        res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : { result: res.body };
      return { ok: true, data: { ...body, location_uuid_used: locationUuid } };
    });
  };
}

// ───────────────────────────── add job (+ compensation) ─────────────────────────────

export interface JobOpts extends TokenOpts {
  title?: string;
  hireDate?: string;
  rate?: string;
  paymentUnit?: string;
  flsaStatus?: string;
  dryRun?: boolean;
  example?: boolean;
}

export function jobBlockers(opts: JobOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.title) blocked.push({ field: "title", reason: "required" });
  if (!opts.hireDate) blocked.push({ field: "hire-date", reason: "required (YYYY-MM-DD)" });
  // Compensation is all-or-nothing: a partial set can't form a valid compensation, so requiring any
  // one of the three requires the others.
  if (opts.rate !== undefined || opts.paymentUnit !== undefined || opts.flsaStatus !== undefined) {
    if (!opts.rate) blocked.push({ field: "rate", reason: "required with --payment-unit/--flsa-status" });
    if (!opts.paymentUnit) blocked.push({ field: "payment-unit", reason: "required with --rate/--flsa-status" });
    if (!opts.flsaStatus) blocked.push({ field: "flsa-status", reason: "required with --rate/--payment-unit" });
  }
  return blocked;
}

export function jobBody(opts: JobOpts): Record<string, unknown> {
  return { title: opts.title, hire_date: opts.hireDate };
}

/** The compensation body, or undefined when no comp flags were passed (job-only). */
export function compensationBody(opts: JobOpts): Record<string, unknown> | undefined {
  if (opts.rate === undefined && opts.paymentUnit === undefined && opts.flsaStatus === undefined) return undefined;
  return { rate: opts.rate, payment_unit: opts.paymentUnit, flsa_status: opts.flsaStatus };
}

/** POST the job, then (when comp flags are given) UPDATE the job's auto-created current compensation
 * in place — never POST a second one — carrying the version from the job response so the PUT can't
 * 409. Returns data keyed by domain (`job`, optionally `compensation`). */

const JOB_REFETCH_DELAYS_MS = [250, 500, 1000];

export async function runJob(
  client: ApiClient,
  employeeUuid: string,
  opts: JobOpts,
  refetchDelaysMs: readonly number[] = JOB_REFETCH_DELAYS_MS,
): Promise<CommandResult> {
  let job: unknown;
  try {
    const jobRes = await client.post(`/v1/employees/${employeeUuid}/jobs`, jobBody(opts));
    job = jobRes.body;
  } catch (err) {
    // Nothing was created; surface the API error as-is.
    return toResult(err);
  }

  const comp = compensationBody(opts);
  if (!comp) return { ok: true, data: { job } };

  // POST /jobs sometimes returns before the backend populates the seed
  // current_compensation. Retry GET with backoff a few times to let it catch up.
  // DELETE rollback isn't an option here: the API refuses to delete a fresh
  // employee's only active job ("must have at least one active job" 422), so if
  // the comp never materializes the only path forward is manual fix in the dashboard.
  const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const jobUuid = readString(job, "uuid");
  let current = currentCompensation(job);
  let refetchErr: unknown;
  if (!current?.uuid && jobUuid) {
    for (let attempt = 0; !current?.uuid && attempt < refetchDelaysMs.length; attempt++) {
      await sleep(refetchDelaysMs[attempt]);
      try {
        const res = await client.get(`/v1/jobs/${jobUuid}`);
        job = res.body;
        current = currentCompensation(res.body);
      } catch (err) {
        refetchErr = err;
        break;
      }
    }
  }

  if (!current?.uuid) {
    if (refetchErr) {
      return {
        ok: false,
        exitCode: ExitCode.ApiServer,
        error: {
          code: "job_compensation_check_failed",
          message:
            "job was created (uuid in details.job_uuid) but the follow-up GET to verify its compensation failed. Do NOT retry this command - the job already exists; another retry would create a duplicate. Inspect the job via `gusto api request GET /v1/jobs/{job_uuid}` or in the Gusto dashboard; if it has a rate, you're done.",
          details: { job, job_uuid: jobUuid, check_error: errMsg(refetchErr) },
        },
      };
    }
    return {
      ok: false,
      exitCode: ExitCode.ApiServer,
      error: {
        code: "job_created_without_compensation",
        message:
          "job was created but its compensation never appeared after retries; fix the rate manually in the Gusto dashboard - the job can't be deleted via API while it is the employee's only active job",
        details: { job, job_uuid: jobUuid },
      },
    };
  }

  try {
    const compRes = await client.put(`/v1/compensations/${current.uuid}`, withVersion(comp, current.version));
    return { ok: true, data: { job, compensation: compRes.body } };
  } catch (err) {
    // The job already exists. Surface it (uuid + completed steps) so a retry can target the
    // compensation update against the existing job rather than POSTing a duplicate job.
    return partialFailure({
      code: "compensation_failed",
      message: "job created but updating its compensation failed",
      err,
      completed: { job },
      failedDomain: "compensation",
    });
  }
}

/** The positional employee_uuid is optional on subcommands that take `--example` (so a canned
 * sample needs no real uuid); every non-example path requires it. */
function missingEmployeeUuid(): CommandResult<never> {
  return missingArgs([{ field: "employee_uuid", reason: "required" }]);
}

function jobHandler(employeeUuid: string | undefined, opts: JobOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          steps: [
            {
              method: "POST",
              path: "/v1/employees/{employee_uuid}/jobs",
              body: { title: "Engineer", hire_date: "2026-01-06" },
            },
            {
              method: "PUT",
              path: "/v1/compensations/{compensation_uuid}",
              body: { rate: "120000", payment_unit: "Year", flsa_status: "Exempt" },
            },
          ],
          note: "example: --rate/--payment-unit/--flsa-status UPDATE the job's auto-created compensation",
        },
      };
    }
    if (!employeeUuid) return missingEmployeeUuid();
    const blocked = jobBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    if (opts.dryRun) {
      const steps: Record<string, unknown>[] = [
        { method: "POST", path: `/v1/employees/${employeeUuid}/jobs`, body: jobBody(opts) },
      ];
      const comp = compensationBody(opts);
      if (comp) steps.push({ method: "PUT", path: "/v1/compensations/{compensation_uuid}", body: comp });
      return { ok: true, data: { steps } };
    }
    return withEmployeeClient(globals, opts.tokenStdin, (client) => runJob(client, employeeUuid, opts));
  };
}

// ───────────────────────────── add federal-tax ─────────────────────────────

export interface FederalTaxOpts extends TokenOpts {
  filingStatus?: string;
  w4DataType?: string;
  twoJobs?: boolean;
  dependentsAmount?: string;
  otherIncome?: string;
  extraWithholding?: string;
  deductions?: string;
  dryRun?: boolean;
  example?: boolean;
}

export function federalTaxBlockers(opts: FederalTaxOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.filingStatus) blocked.push({ field: "filing-status", reason: "required" });
  return blocked;
}

export function federalTaxBody(opts: FederalTaxOpts): Record<string, unknown> {
  return {
    filing_status: opts.filingStatus,
    ...(opts.w4DataType !== undefined ? { w4_data_type: opts.w4DataType } : {}),
    ...(opts.twoJobs !== undefined ? { two_jobs: opts.twoJobs } : {}),
    ...(opts.dependentsAmount !== undefined ? { dependents_amount: opts.dependentsAmount } : {}),
    ...(opts.otherIncome !== undefined ? { other_income: opts.otherIncome } : {}),
    ...(opts.extraWithholding !== undefined ? { extra_withholding: opts.extraWithholding } : {}),
    ...(opts.deductions !== undefined ? { deductions: opts.deductions } : {}),
  };
}

/** Version-guarded PUT to federal_taxes: putVersioned GETs the current version first so the PUT
 * can't 409. */
export async function runFederalTax(
  client: ApiClient,
  employeeUuid: string,
  opts: FederalTaxOpts,
): Promise<CommandResult> {
  const path = `/v1/employees/${employeeUuid}/federal_taxes`;
  try {
    // The federal_taxes PUT REPLACES the record (it 422s on a missing w4_data_type), so a partial
    // update built only from the passed flags would silently zero every unset W-4 field. Read the
    // current record and carry over each field whose flag wasn't supplied, making `--filing-status`
    // alone a safe in-place edit. The version comes from the same GET to avoid a 409.
    const current = await client.get(path);
    const body = federalTaxBody(opts);
    const cur = current.body as Record<string, unknown> | null;
    for (const field of CARRY_OVER_FEDERAL_TAX_FIELDS) {
      if (body[field] === undefined && cur?.[field] != null) body[field] = cur[field];
    }
    // The rev_2020_w4 form requires its four numeric fields to be numbers, but a fresh record
    // supplies none — so a `--filing-status`-only PUT 422s. Default any still-unset numeric field to
    // "0" (the same default the server stores). Only for rev_2020_w4: these fields don't exist on the
    // pre_2020_w4 form, which uses allowances instead.
    if (body.w4_data_type === "rev_2020_w4") {
      for (const field of NUMERIC_W4_FIELDS) {
        if (body[field] == null) body[field] = "0";
      }
    }
    const res = await client.put(path, withVersion(body, readString(current.body, "version")));
    return { ok: true, data: res.body };
  } catch (err) {
    return toResult(err);
  }
}

/** W-4 fields carried over from the current federal_taxes when their flag is unset, so a partial
 * update doesn't wipe them (the PUT replaces the record). `filing_status` is required, never carried. */
const CARRY_OVER_FEDERAL_TAX_FIELDS = [
  "w4_data_type",
  "two_jobs",
  "dependents_amount",
  "other_income",
  "extra_withholding",
  "deductions",
] as const;

/** The rev_2020_w4 numeric (dollar-amount) fields. The API validates each as a number, so when
 * neither the caller nor the current record supplies one, default it to "0" (the server's own
 * default) rather than 422. This is the complete set of numeric fields on the 2020 W-4. */
const NUMERIC_W4_FIELDS = ["dependents_amount", "other_income", "extra_withholding", "deductions"] as const;

function federalTaxHandler(employeeUuid: string | undefined, opts: FederalTaxOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/employees/{employee_uuid}/federal_taxes",
          body: { filing_status: "Single", w4_data_type: "rev_2020_w4" },
          note: "example: version and any unset W-4 fields are read from current federal_taxes at send time",
        },
      };
    }
    if (!employeeUuid) return missingEmployeeUuid();
    const blocked = federalTaxBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: `/v1/employees/${employeeUuid}/federal_taxes`,
          body: federalTaxBody(opts),
          note: "dry-run: version and any unset W-4 fields are read from current federal_taxes at send time",
        },
      };
    }
    return withEmployeeClient(globals, opts.tokenStdin, (client) => runFederalTax(client, employeeUuid, opts));
  };
}

// ───────────────────────────── add payment-method (absorbs bank-account) ─────────────────────────────

export interface PaymentMethodOpts extends TokenOpts {
  type?: string;
  name?: string;
  routingNumber?: string;
  accountNumber?: string;
  accountType?: string;
  dryRun?: boolean;
  example?: boolean;
}

const PAYMENT_TYPES: Record<string, string> = { check: "Check", "direct-deposit": "Direct Deposit" };

export function paymentMethodBlockers(opts: PaymentMethodOpts): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  if (!opts.type || !(opts.type in PAYMENT_TYPES)) {
    // Can't validate the bank fields until the type is known, so stop here.
    blocked.push({ field: "type", reason: 'required ("check" or "direct-deposit")' });
    return blocked;
  }
  if (opts.type === "direct-deposit") {
    if (!opts.name) blocked.push({ field: "name", reason: "required for direct-deposit" });
    if (!opts.routingNumber) blocked.push({ field: "routing-number", reason: "required for direct-deposit" });
    if (!opts.accountNumber) blocked.push({ field: "account-number", reason: "required for direct-deposit" });
    if (opts.accountType !== "Checking" && opts.accountType !== "Savings")
      blocked.push({ field: "account-type", reason: 'required ("Checking" or "Savings")' });
  }
  return blocked;
}

/** The employee bank-account create body (direct-deposit path). */
function bankAccountBody(opts: PaymentMethodOpts): Record<string, unknown> {
  return {
    name: opts.name,
    routing_number: opts.routingNumber,
    account_number: opts.accountNumber,
    account_type: opts.accountType,
  };
}

/** A Direct Deposit payment_method body routing 100% to one bank account. Built once so the dry-run
 * preview and the real PUT can't drift. */
function directDepositPmBody(bankUuid: string): Record<string, unknown> {
  return {
    type: "Direct Deposit",
    split_by: "Percentage",
    splits: [{ uuid: bankUuid, priority: 1, split_amount: 100 }],
  };
}

/** Check → version-guarded PUT {type:"Check"}. Direct deposit → create the bank account, then PUT a
 * Direct Deposit payment_method routing 100% to it (splits reference the new bank-account uuid). */
export async function runPaymentMethod(
  client: ApiClient,
  employeeUuid: string,
  opts: PaymentMethodOpts,
): Promise<CommandResult> {
  const pmPath = `/v1/employees/${employeeUuid}/payment_method`;

  if (opts.type === "check") {
    try {
      const res = await putVersioned(client, pmPath, { type: "Check" });
      return { ok: true, data: res.body };
    } catch (err) {
      return toResult(err);
    }
  }

  // Direct deposit: create the bank account first.
  let bank: unknown;
  try {
    const bankRes = await client.post(`/v1/employees/${employeeUuid}/bank_accounts`, bankAccountBody(opts));
    bank = bankRes.body;
  } catch (err) {
    // Nothing was created; surface the API error as-is.
    return toResult(err);
  }
  const bankUuid = readString(bank, "uuid");
  if (!bankUuid) {
    return bankCreateNoUuidError(bank);
  }

  try {
    const pmRes = await putVersioned(client, pmPath, directDepositPmBody(bankUuid));
    return { ok: true, data: { bank_account: bank, payment_method: pmRes.body } };
  } catch (err) {
    // The bank account already exists. Surface it (uuid + completed steps) so a retry can route the
    // payment method to the existing account rather than POSTing a duplicate bank account.
    return partialFailure({
      code: "payment_method_failed",
      message: "bank account created but setting the payment method failed",
      err,
      completed: { bank_account: bank },
      failedDomain: "payment_method",
    });
  }
}

function paymentMethodHandler(employeeUuid: string | undefined, opts: PaymentMethodOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/employees/{employee_uuid}/payment_method",
          body: { type: "Check" },
          note: "example: --type direct-deposit also creates a bank account and routes 100% to it",
        },
      };
    }
    if (!employeeUuid) return missingEmployeeUuid();
    const blocked = paymentMethodBlockers(opts);
    if (blocked.length > 0) return missingArgs(blocked);
    if (opts.dryRun) {
      const pmPath = `/v1/employees/${employeeUuid}/payment_method`;
      if (opts.type === "check") {
        return { ok: true, data: { steps: [{ method: "PUT", path: pmPath, body: { type: "Check" } }] } };
      }
      return {
        ok: true,
        data: {
          steps: [
            {
              method: "POST",
              path: `/v1/employees/${employeeUuid}/bank_accounts`,
              body: bankAccountBody(opts),
            },
            { method: "PUT", path: pmPath, body: directDepositPmBody("{bank_account_uuid}") },
          ],
        },
      };
    }
    return withEmployeeClient(globals, opts.tokenStdin, (client) => runPaymentMethod(client, employeeUuid, opts));
  };
}

// ───────────────────────────── add state-tax (discovery-driven) ─────────────────────────────
// The state_taxes endpoint returns, per state the employee owes tax in, a dynamic set of
// withholding questions (label + input format). We discover them, accept human `--answer` flags
// (STATE:key=value), map Select labels to API values, validate per type, and PUT. With no
// `--answer` and a TTY we prompt interactively; otherwise we return the questions for an agent.

interface StateTaxOption {
  // Discovery lists Select option values as strings, but some questions use booleans or numbers
  // (e.g. file_new_hire_report → { value: true }). Keep the original type so it round-trips.
  value: string | number | boolean;
  label: string;
}
interface StateTaxQuestion {
  key: string;
  label?: string;
  description?: string;
  input_question_format?: { type?: string; options?: StateTaxOption[] };
  answers?: { value?: unknown }[];
}
interface StateTaxStateRec {
  state: string;
  is_work_state?: boolean;
  questions?: StateTaxQuestion[];
}

/** One parsed `--answer` flag: `key=value` (applies to every state with that key) or
 * `STATE:key=value` (scoped to one state). */
export interface ParsedAnswer {
  state?: string;
  key: string;
  value: string;
}

export type AnswerParseResult = { ok: true; answers: ParsedAnswer[] } | { ok: false; blocked: BlockedOn[] };

/** Parse repeatable `--answer` flags. Splits on the FIRST `=` so values may contain `=`; an optional
 * `STATE:` prefix (before the key) scopes the answer to one state. */
export function parseAnswerFlags(raw: string[]): AnswerParseResult {
  const answers: ParsedAnswer[] = [];
  const blocked: BlockedOn[] = [];
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      blocked.push({ field: "answer", reason: `must be key=value or STATE:key=value, got: ${entry}` });
      continue;
    }
    const left = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    const colon = left.indexOf(":");
    if (colon === -1) answers.push({ key: left, value });
    else answers.push({ state: left.slice(0, colon), key: left.slice(colon + 1), value });
  }
  if (blocked.length > 0) return { ok: false, blocked };
  return { ok: true, answers };
}

function asStateArray(body: unknown): StateTaxStateRec[] {
  return Array.isArray(body) ? (body as StateTaxStateRec[]) : [];
}

/** Resolve a raw answer string against a question's type: Select accepts the value, the human label
 * (case-insensitive), or (for boolean-valued options) `yes`/`no` as aliases for `true`/`false`,
 * and returns the API value; Number/Currency/Date are format-checked. */
function resolveAnswerValue(
  q: StateTaxQuestion,
  value: string,
): { ok: true; value: string | number | boolean } | { ok: false; reason: string } {
  const type = q.input_question_format?.type;
  if (type === "Select") {
    const options = q.input_question_format?.options ?? [];
    const lowered = value.toLowerCase();
    const yesNo = lowered === "yes" ? true : lowered === "no" ? false : null;
    const match = options.find(
      (o) =>
        String(o.value) === value ||
        o.label.toLowerCase() === lowered ||
        (yesNo !== null && typeof o.value === "boolean" && o.value === yesNo),
    );
    if (!match) return { ok: false, reason: `must be one of: ${options.map((o) => o.label).join(", ")}` };
    return { ok: true, value: match.value };
  }
  if (type === "Number" || type === "Currency") {
    if (!/^-?\d+(\.\d+)?$/.test(value)) return { ok: false, reason: "must be a number" };
    return { ok: true, value };
  }
  if (type === "Date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, reason: "must be a date (YYYY-MM-DD)" };
    return { ok: true, value };
  }
  return { ok: true, value };
}

function requiredReason(q: StateTaxQuestion): string {
  const base = `required${q.label ? `: ${q.label}` : ""}`;
  const options = q.input_question_format?.options;
  if (q.input_question_format?.type === "Select" && options?.length) {
    return `${base} (one of: ${options.map((o) => o.label).join(", ")})`;
  }
  return base;
}

interface StateTaxAnswerOut {
  key: string;
  answers: { value: string | number | boolean }[];
}
interface StateTaxStateOut {
  state: string;
  questions: StateTaxAnswerOut[];
}
export type EmployeeStateTaxBuildResult =
  | { ok: true; body: { states: StateTaxStateOut[] } }
  | { ok: false; blocked: BlockedOn[] };

/** Answers that matched no discovered question (unknown key, or scoped to the wrong state) — almost
 * always a typo. `matched` is the set of answers a question consumed; the rest are checked here.
 * An unscoped answer is known if any state has the key; a scoped one only if that state has it. */
function findUnknownAnswers(
  states: StateTaxStateRec[],
  answers: ParsedAnswer[],
  matched: Set<ParsedAnswer>,
): BlockedOn[] {
  const keysByState = new Map<string, Set<string>>();
  const allKeys = new Set<string>();
  for (const st of states) {
    const keys = new Set((st.questions ?? []).map((q) => q.key));
    keysByState.set(st.state, keys);
    for (const k of keys) allKeys.add(k);
  }
  const blocked: BlockedOn[] = [];
  for (const a of answers) {
    if (matched.has(a)) continue;
    const known = a.state !== undefined ? (keysByState.get(a.state)?.has(a.key) ?? false) : allKeys.has(a.key);
    if (!known) {
      blocked.push({
        field: a.state ? `${a.state}:${a.key}` : a.key,
        reason: "no such state-tax question for this employee",
      });
    }
  }
  return blocked;
}

/** Map parsed `--answer` flags onto the discovered questions, producing the state_taxes PUT body.
 * A required question (no existing answer) with no supplied answer blocks; an invalid value blocks
 * (echoing allowed choices); an answer matching no question blocks (likely typo). A scoped answer
 * wins over an unscoped one for the same state+key.
 *
 * Only states the caller is actually answering are included; a fully-answered state with no new
 * `--answer` is omitted. That's safe because `PUT /v1/employees/{uuid}/state_taxes` UPSERTS — it
 * applies the answers it's given and leaves everything else untouched (verified against sandbox:
 * PUTting one question for a state preserved that state's other answers, so omitting a whole state
 * can't wipe it). */
export function buildStateTaxBody(states: StateTaxStateRec[], answers: ParsedAnswer[]): EmployeeStateTaxBuildResult {
  const blocked: BlockedOn[] = [];
  const matched = new Set<ParsedAnswer>();
  const outStates: StateTaxStateOut[] = [];

  for (const st of states) {
    const outQuestions: StateTaxAnswerOut[] = [];
    for (const q of st.questions ?? []) {
      const required = (q.answers ?? []).length === 0;
      const ans =
        answers.find((a) => a.key === q.key && a.state === st.state) ??
        answers.find((a) => a.key === q.key && a.state === undefined);
      if (!ans) {
        if (required) blocked.push({ field: `${st.state}:${q.key}`, reason: requiredReason(q) });
        continue;
      }
      matched.add(ans);
      const resolved = resolveAnswerValue(q, ans.value);
      if (!resolved.ok) {
        blocked.push({ field: `${st.state}:${q.key}`, reason: resolved.reason });
        continue;
      }
      outQuestions.push({ key: q.key, answers: [{ value: resolved.value }] });
    }
    if (outQuestions.length > 0) outStates.push({ state: st.state, questions: outQuestions });
  }

  // Flag answers that matched no question (unknown key, or wrong state) so typos surface.
  blocked.push(...findUnknownAnswers(states, answers, matched));

  if (blocked.length > 0) return { ok: false, blocked };
  return { ok: true, body: { states: outStates } };
}

function renderStateTaxQuestions(states: StateTaxStateRec[]): Record<string, unknown>[] {
  return states.map((st) => ({
    state: st.state,
    is_work_state: st.is_work_state ?? null,
    questions: (st.questions ?? []).map((q) => ({
      key: q.key,
      label: q.label ?? null,
      type: q.input_question_format?.type ?? null,
      ...(q.input_question_format?.options ? { options: q.input_question_format.options } : {}),
      required: (q.answers ?? []).length === 0,
    })),
  }));
}

/** Step 1: GET the questions and report them (rendered) plus the `STATE:key` list still needing an
 * answer. Used for the no-`--answer` / agent path. */
export async function introspectStateTax(client: ApiClient, employeeUuid: string): Promise<CommandResult> {
  try {
    const res = await client.get(`/v1/employees/${employeeUuid}/state_taxes`);
    const states = asStateArray(res.body);
    const answersNeeded: string[] = [];
    for (const st of states) {
      for (const q of st.questions ?? []) {
        if ((q.answers ?? []).length === 0) answersNeeded.push(`${st.state}:${q.key}`);
      }
    }
    return { ok: true, data: { states: renderStateTaxQuestions(states), answers_needed: answersNeeded } };
  } catch (err) {
    return toResult(err);
  }
}

/** Step 2: GET the questions, map the supplied `--answer` flags onto them, and PUT. Missing/invalid
 * answers block (exit 7) without sending. A state set with nothing to answer is a no-op success. */
export async function runStateTax(
  client: ApiClient,
  employeeUuid: string,
  answers: ParsedAnswer[],
  dryRun: boolean = false,
): Promise<CommandResult> {
  let states: StateTaxStateRec[];
  try {
    const res = await client.get(`/v1/employees/${employeeUuid}/state_taxes`);
    states = asStateArray(res.body);
  } catch (err) {
    return toResult(err);
  }
  const build = buildStateTaxBody(states, answers);
  if (!build.ok) return validationFailure("missing or invalid state-tax answers", build.blocked);
  if (build.body.states.length === 0) {
    return { ok: true, data: { message: "no state-tax answers needed", states: renderStateTaxQuestions(states) } };
  }
  const path = `/v1/employees/${employeeUuid}/state_taxes`;
  if (dryRun) {
    // The body is built from the discovered questions (one GET), then shown rather than PUT.
    return { ok: true, data: { method: "PUT", path, body: build.body, note: "dry-run: built but not sent" } };
  }
  try {
    const res = await client.put(path, build.body);
    return { ok: true, data: res.body };
  } catch (err) {
    return toResult(err);
  }
}

/** Step 3: prompt each still-unanswered question on a TTY (label + Select choices), returning the
 * collected, state-scoped answers. Empty input for a question skips it. */
async function promptStateTaxAnswers(client: ApiClient, employeeUuid: string): Promise<ParsedAnswer[]> {
  const res = await client.get(`/v1/employees/${employeeUuid}/state_taxes`);
  const states = asStateArray(res.body);
  const collected: ParsedAnswer[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (const st of states) {
      for (const q of st.questions ?? []) {
        if ((q.answers ?? []).length > 0) continue; // already has an answer/default
        const options = q.input_question_format?.options;
        const choices = options?.length ? ` [${options.map((o) => o.label).join(" / ")}]` : "";
        const answer = (await rl.question(`${st.state} — ${q.label ?? q.key}${choices}: `)).trim();
        if (answer) collected.push({ state: st.state, key: q.key, value: answer });
      }
    }
  } finally {
    rl.close();
  }
  return collected;
}

interface StateTaxOpts extends TokenOpts {
  answer?: string[];
  dryRun?: boolean;
  example?: boolean;
}

/** Canned state-tax sample: the discovery → answer → PUT shape, without calling the API. */
function stateTaxExample(): CommandResult {
  return {
    ok: true,
    data: {
      method: "PUT",
      path: "/v1/employees/{employee_uuid}/state_taxes",
      body: { states: [{ state: "CA", questions: [{ key: "filing_status", answers: [{ value: "S" }] }] }] },
      note: "example: run with no --answer first to discover each state's questions, then --answer STATE:key=value",
    },
  };
}

function stateTaxHandler(
  employeeUuid: string | undefined,
  opts: StateTaxOpts,
  isTty: boolean = process.stdin.isTTY === true,
): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) return stateTaxExample();
    if (!employeeUuid) return missingEmployeeUuid();
    const empUuid = employeeUuid;
    const parsed = parseAnswerFlags(opts.answer ?? []);
    if (!parsed.ok) return validationFailure("invalid --answer", parsed.blocked);
    return withEmployeeClient(globals, opts.tokenStdin, async (client) => {
      if (parsed.answers.length > 0) return runStateTax(client, empUuid, parsed.answers, opts.dryRun);
      // No --answer: prompt interactively on a TTY, else return the questions for an agent to fill.
      // --dry-run skips the prompt (a dry-run that asks questions is surprising) and just lists them.
      if (isTty && !globals.agent && !globals.json && !opts.dryRun) {
        const collected = await promptStateTaxAnswers(client, empUuid);
        if (collected.length > 0) return runStateTax(client, empUuid, collected, opts.dryRun);
      }
      return introspectStateTax(client, empUuid);
    });
  };
}

// ───────────────────────────── manage (update + onboarding-mode) ─────────────────────────────
// `employee manage <uuid>` admin-completes an existing employee the `add` flow can't reach: it
// updates identity (name/SSN/DOB, a version-guarded PUT /v1/employees/{uuid}) and/or switches the
// onboarding mode (--mode admin|invite, a PUT /v1/employees/{uuid}/onboarding_status). Either or
// both may be passed; when both are, the mode switch runs first so the identity update lands in the
// target mode.

/** The onboarding_status each `--mode` value selects. Values verified against the Gusto API's
 * onboarding_status enum (the only two an admin sets to move an employee between modes). */
const MANAGE_MODE_STATUS = {
  admin: "admin_onboarding_incomplete",
  invite: "self_onboarding_pending_invite",
} as const;

export interface ManageOpts extends TokenOpts {
  firstName?: string;
  lastName?: string;
  ssn?: string;
  dateOfBirth?: string;
  mode?: string;
  dryRun?: boolean;
  example?: boolean;
}

/** The version-guarded employee PUT body: only the identity flags that were supplied. */
export function manageIdentityBody(opts: ManageOpts): Record<string, unknown> {
  return {
    ...(opts.firstName !== undefined ? { first_name: opts.firstName } : {}),
    ...(opts.lastName !== undefined ? { last_name: opts.lastName } : {}),
    ...(opts.ssn !== undefined ? { ssn: opts.ssn } : {}),
    ...(opts.dateOfBirth !== undefined ? { date_of_birth: opts.dateOfBirth } : {}),
  };
}

/** The onboarding_status `--mode` selects: `null` when unset (no mode change); blocked when the
 * value isn't a known mode. */
export function resolveManageMode(
  opts: ManageOpts,
): { ok: true; status: string | null } | { ok: false; blocked: BlockedOn[] } {
  if (opts.mode === undefined) return { ok: true, status: null };
  if (opts.mode === "admin" || opts.mode === "invite") return { ok: true, status: MANAGE_MODE_STATUS[opts.mode] };
  return { ok: false, blocked: [{ field: "mode", reason: 'must be "admin" or "invite"' }] };
}

export function manageBlockers(opts: ManageOpts): BlockedOn[] {
  const mode = resolveManageMode(opts);
  if (!mode.ok) return mode.blocked;
  const hasIdentity = Object.keys(manageIdentityBody(opts)).length > 0;
  if (!hasIdentity && mode.status === null) {
    return [
      {
        field: "fields",
        reason: "nothing to manage: pass --first-name/--last-name/--ssn/--date-of-birth and/or --mode admin|invite",
      },
    ];
  }
  return [];
}

/** Switch onboarding mode (if a mode flag was passed) then version-guard the identity PUT (if any
 * identity flag was passed). A failed identity PUT after a successful mode switch surfaces the
 * completed switch so a retry only re-runs the identity update. */
export async function runManage(client: ApiClient, employeeUuid: string, opts: ManageOpts): Promise<CommandResult> {
  const mode = resolveManageMode(opts);
  if (!mode.ok) return validationFailure("invalid onboarding mode", mode.blocked);
  const data: Record<string, unknown> = {};

  if (mode.status !== null) {
    try {
      const res = await client.put(`/v1/employees/${employeeUuid}/onboarding_status`, {
        onboarding_status: mode.status,
      });
      data.onboarding_status = res.body;
    } catch (err) {
      return toResult(err);
    }
  }

  const identity = manageIdentityBody(opts);
  if (Object.keys(identity).length > 0) {
    try {
      const res = await putVersioned(client, `/v1/employees/${employeeUuid}`, identity);
      data.employee = res.body;
    } catch (err) {
      if (mode.status === null) return toResult(err);
      return partialFailure({
        code: "manage_identity_failed",
        message: "onboarding mode switched but updating the employee failed",
        err,
        completed: { onboarding_status: data.onboarding_status },
        failedDomain: "employee",
      });
    }
  }

  return { ok: true, data };
}

function manageExample(): CommandResult {
  return {
    ok: true,
    data: {
      steps: [
        {
          method: "PUT",
          path: "/v1/employees/{employee_uuid}/onboarding_status",
          body: { onboarding_status: "admin_onboarding_incomplete" },
        },
        {
          method: "PUT",
          path: "/v1/employees/{employee_uuid}",
          body: { ssn: "123-45-6789", date_of_birth: "1990-01-01" },
        },
      ],
      note: "example: --mode admin|invite switches onboarding mode; identity flags version-guard PUT the employee. Pass either or both.",
    },
  };
}

function manageHandler(employeeUuid: string | undefined, opts: ManageOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) return manageExample();
    if (!employeeUuid) return missingEmployeeUuid();
    const blocked = manageBlockers(opts);
    if (blocked.length > 0) return validationFailure("nothing to manage or invalid --mode", blocked);
    if (opts.dryRun) {
      const mode = resolveManageMode(opts);
      const steps: Record<string, unknown>[] = [];
      // mode.ok is guaranteed here — manageBlockers already rejected an invalid --mode.
      if (mode.ok && mode.status !== null) {
        steps.push({
          method: "PUT",
          path: `/v1/employees/${employeeUuid}/onboarding_status`,
          body: { onboarding_status: mode.status },
        });
      }
      const identity = manageIdentityBody(opts);
      if (Object.keys(identity).length > 0) {
        steps.push({
          method: "PUT",
          path: `/v1/employees/${employeeUuid}`,
          body: identity,
          note: "version read from current employee at send time",
        });
      }
      return { ok: true, data: { steps } };
    }
    return withEmployeeClient(globals, opts.tokenStdin, (client) => runManage(client, employeeUuid, opts));
  };
}

export function registerEmployeeManage(employee: Command, parent: Command): void {
  employee
    .command("manage [employee_uuid]")
    .description("Update an existing employee's name/SSN/DOB and/or switch onboarding mode (admin ↔ invite)")
    .option("--first-name <name>", "Employee first name")
    .option("--last-name <name>", "Employee last name")
    .option("--ssn <ssn>", "Social Security Number")
    .option("--date-of-birth <date>", "Date of birth (YYYY-MM-DD)")
    .option("--mode <mode>", 'Switch onboarding mode: "admin" (admin-driven) or "invite" (self-onboarding)')
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
Examples:
  # complete an invited employee the admin is driving: switch to admin mode, then set SSN/DOB
  $ gusto employee manage <employee_uuid> --mode admin --ssn 123-45-6789 --date-of-birth 1990-01-01
  # hand an admin-created employee back to self-onboarding
  $ gusto employee manage <employee_uuid> --mode invite
  # fix a name on an existing employee
  $ gusto employee manage <employee_uuid> --first-name Jane
`,
    )
    .action((employeeUuid: string | undefined, opts: ManageOpts) =>
      runCommand("gusto employee manage", readGlobalFlags(parent.opts()), manageHandler(employeeUuid, opts)),
    );
}

// ───────────────────────────── shared helpers ─────────────────────────────

function readString(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** The job's currently-active compensation (uuid + version), found in its embedded `compensations`
 * by `current_compensation_uuid`. Falls back to the sole compensation if the pointer is absent. */
function currentCompensation(jobBody: unknown): { uuid: string; version?: string } | undefined {
  if (typeof jobBody !== "object" || jobBody === null) return undefined;
  const job = jobBody as Record<string, unknown>;
  const comps = Array.isArray(job.compensations) ? (job.compensations as Record<string, unknown>[]) : [];
  const currentUuid = readString(job, "current_compensation_uuid");
  // Take uuid AND version from the same record so a PUT can't pair one comp's uuid with another's
  // version (which would 409). Falls back to the sole compensation when there's no current pointer.
  const match = comps.find((c) => readString(c, "uuid") === currentUuid) ?? comps[0];
  const uuid = readString(match, "uuid");
  if (!uuid) return undefined;
  return { uuid, version: readString(match, "version") };
}

/** Inject `version` into a PUT body when the caller didn't supply one (it can't be known for a
 * resource created earlier in this same flow). A caller-supplied version always wins. */
function withVersion(body: Record<string, unknown>, version: string | undefined): Record<string, unknown> {
  if (version === undefined || readString(body, "version") !== undefined) return body;
  return { version, ...body };
}

/** PUT a version-guarded resource: if the body lacks a `version`, GET the current resource to learn
 * it, then PUT. Avoids the 409 `invalid_resource_version` these endpoints return otherwise. */
async function putVersioned(
  client: ApiClient,
  path: string,
  body: Record<string, unknown>,
): Promise<{ body: unknown }> {
  let merged = body;
  if (readString(merged, "version") === undefined) {
    const current = await client.get(path);
    merged = withVersion(merged, readString(current.body, "version"));
  }
  return client.put(path, merged);
}

/** Resolve a token-only (no company required) client for employee-scoped endpoints and run `fn`,
 * mapping any API/network error it throws. Sibling of `withCompanyContext` for `/v1/employees/...`. */
async function withEmployeeClient(
  globals: GlobalFlags,
  tokenStdin: boolean | undefined,
  fn: (client: ApiClient) => Promise<CommandResult>,
): Promise<CommandResult> {
  const ctx = await resolveApiContext(globals, { tokenStdin, requireCompany: false });
  if (!ctx.ok) return ctx.result;
  try {
    return await fn(ctx.ctx.client);
  } catch (err) {
    return toResult(err);
  }
}

/** Shared shape for the address subcommands: validate, honor --dry-run, else POST the body. */
function postSubdomainHandler(
  opts: { tokenStdin?: boolean; dryRun?: boolean },
  blockers: () => BlockedOn[],
  path: string,
  body: () => Record<string, unknown>,
): CommandHandler {
  return async ({ globals }) => {
    const blocked = blockers();
    if (blocked.length > 0) return missingArgs(blocked);
    if (opts.dryRun) return { ok: true, data: { method: "POST", path, body: body() } };
    return withEmployeeClient(globals, opts.tokenStdin, async (client) => {
      const res = await client.post(path, body());
      return { ok: true, data: res.body };
    });
  };
}

// ───────────────────────────── registration ─────────────────────────────

const collectAnswer = (value: string, previous: string[]): string[] => previous.concat(value);

export function registerEmployeeAdd(employee: Command, parent: Command): void {
  // `add` is a pure command group (like `company setup`): `personal-details` creates the employee,
  // the rest configure an existing one by uuid.
  const add = employee
    .command("add")
    .description("Create and configure a W-2 employee (`personal-details` creates; the rest take an employee uuid)")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee add personal-details --first-name Jane --last-name Doe --email jane@example.com
  # then, using the returned employee uuid:
  $ gusto employee add home-address <employee_uuid> --street-1 "300 3rd St" --city "San Francisco" --state CA --zip 94107
  $ gusto employee add job <employee_uuid> --title Engineer --hire-date 2026-01-06 --rate 120000 --payment-unit Year --flsa-status Exempt
  $ gusto employee add federal-tax <employee_uuid> --filing-status Single --w4-data-type rev_2020_w4
  $ gusto employee add payment-method <employee_uuid> --type direct-deposit --name Checking --routing-number 266905059 --account-number 5809431207 --account-type Checking
  $ gusto employee add state-tax <employee_uuid> --answer CA:filing_status=Single --answer CA:withholding_allowance=2
`,
    );

  add
    .command("personal-details")
    .description("Create the W-2 employee (name, email, and optional SSN / date of birth)")
    .option("--first-name <name>", "Employee first name")
    .option("--last-name <name>", "Employee last name")
    .option("--email <email>", "Employee email - also where the invite is sent")
    .option("--ssn <ssn>", "Social Security Number")
    .option("--date-of-birth <date>", "Date of birth (YYYY-MM-DD)")
    .option("--admin-driven", "Caller supplies all employee data (default: send a self-onboarding invite)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((opts: EmployeeCreateOpts) =>
      runCommand("gusto employee add personal-details", readGlobalFlags(parent.opts()), employeeCreateHandler(opts)),
    );

  add
    .command("home-address <employee_uuid>")
    .description("Set the employee's home address")
    .option("--street-1 <street>", "Street line 1")
    .option("--street-2 <street>", "Street line 2")
    .option("--city <city>", "City")
    .option("--state <state>", "2-letter state code")
    .option("--zip <zip>", "ZIP code")
    .option("--effective-date <date>", "Effective date (YYYY-MM-DD)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .action((employeeUuid: string, opts: HomeAddressOpts) =>
      runCommand(
        "gusto employee add home-address",
        readGlobalFlags(parent.opts()),
        homeAddressHandler(employeeUuid, opts),
      ),
    );

  add
    .command("work-address <employee_uuid>")
    .description("Set the employee's work address (defaults to the company's primary location)")
    .option(
      "--location-uuid <uuid>",
      "Company location UUID (defaults to the primary location; see `gusto company locations`)",
    )
    .option("--effective-date <date>", "Effective date (YYYY-MM-DD, required)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .action((employeeUuid: string, opts: WorkAddressOpts) =>
      runCommand(
        "gusto employee add work-address",
        readGlobalFlags(parent.opts()),
        workAddressHandler(employeeUuid, opts),
      ),
    );

  add
    .command("job [employee_uuid]")
    .description("Create a job; --rate/--payment-unit/--flsa-status also set its compensation")
    .option("--title <title>", "Job title")
    .option("--hire-date <date>", "Hire date (YYYY-MM-DD)")
    .option("--rate <rate>", "Compensation rate (requires --payment-unit and --flsa-status)")
    .option("--payment-unit <unit>", "Hour, Week, Month, Year, Paycheck")
    .option("--flsa-status <status>", "Exempt, Nonexempt, ...")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((employeeUuid: string | undefined, opts: JobOpts) =>
      runCommand("gusto employee add job", readGlobalFlags(parent.opts()), jobHandler(employeeUuid, opts)),
    );

  add
    .command("federal-tax [employee_uuid]")
    .description("Set the employee's federal W-4 withholding (version-guarded)")
    .option("--filing-status <status>", "W-4 filing status")
    .option("--w4-data-type <type>", "e.g. rev_2020_w4")
    .option("--two-jobs", "W-4 step 2 (multiple jobs) checkbox")
    .option("--dependents-amount <amt>", "W-4 dependents amount")
    .option("--other-income <amt>", "W-4 other income")
    .option("--extra-withholding <amt>", "W-4 extra withholding")
    .option("--deductions <amt>", "W-4 deductions")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((employeeUuid: string | undefined, opts: FederalTaxOpts) =>
      runCommand(
        "gusto employee add federal-tax",
        readGlobalFlags(parent.opts()),
        federalTaxHandler(employeeUuid, opts),
      ),
    );

  add
    .command("payment-method [employee_uuid]")
    .description("Set how the employee is paid: check, or direct-deposit (also creates the bank account)")
    .option("--type <type>", '"check" or "direct-deposit"')
    .option("--name <name>", "Bank account nickname (direct-deposit)")
    .option("--routing-number <num>", "9-digit US routing number (direct-deposit)")
    .option("--account-number <num>", "Bank account number (direct-deposit)")
    .option("--account-type <type>", "Checking or Savings (direct-deposit)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((employeeUuid: string | undefined, opts: PaymentMethodOpts) =>
      runCommand(
        "gusto employee add payment-method",
        readGlobalFlags(parent.opts()),
        paymentMethodHandler(employeeUuid, opts),
      ),
    );

  add
    .command("state-tax [employee_uuid]")
    .description("Set state withholding. With no --answer: lists the questions (or prompts on a TTY)")
    .option(
      "--answer <STATE:key=value>",
      "A withholding answer; repeatable (e.g. CA:filing_status=Single)",
      collectAnswer,
      [],
    )
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
Run with no --answer to discover each state's questions, then answer them:
  $ gusto employee add state-tax <employee_uuid>
  $ gusto employee add state-tax <employee_uuid> --answer CA:filing_status=Single --answer CA:withholding_allowance=2

Select answers accept the human label ("Single"), the API value ("S"), or for true/false
questions also "Yes"/"No". A bare key (--answer filing_status=Single) applies to every state
that asks it; STATE:key scopes it to one.
`,
    )
    .action((employeeUuid: string | undefined, opts: StateTaxOpts) =>
      runCommand("gusto employee add state-tax", readGlobalFlags(parent.opts()), stateTaxHandler(employeeUuid, opts)),
    );
}
