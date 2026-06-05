import type { Command } from "commander";
import { createCompanyResource, fetchCompanyResource, fetchResource } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { parsePositiveNumber } from "../lib/parse.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

type ContractorType = "individual" | "business";
type WageType = "Fixed" | "Hourly";

/** Common fields the Gusto API requires on every contractor regardless of type:
 * `wage_type` (Fixed|Hourly), `start_date`, and `hourly_rate` only when Hourly. */
interface ContractorCommon {
  email: string;
  wage_type: WageType;
  start_date: string;
  self_onboarding: boolean;
  hourly_rate?: string;
}

export type ContractorBody =
  | ({ type: "Individual"; first_name: string; last_name: string } & ContractorCommon)
  | ({ type: "Business"; business_name: string } & ContractorCommon);

export type ContractorValidation =
  | { ok: true; body: ContractorBody }
  | { ok: false; message: string; blocked: BlockedOn[] };

// Accepts YYYY-MM-DD and confirms it's a real calendar date (rejects e.g. 2026-13-40).
function isValidStartDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

/** Validate contractor-add args and, on success, return the fully-populated request body.
 * `--type` drives which identity fields are required (individual: first/last name; business:
 * business-name). `--wage-type` and `--start-date` are required for every contractor, and
 * `--hourly-rate` is required when wage-type is hourly. Returning the body lets the compiler
 * prove it's complete. */
export function validateContractorAdd(
  opts: Pick<
    ContractorAddOpts,
    | "type"
    | "firstName"
    | "lastName"
    | "businessName"
    | "email"
    | "wageType"
    | "startDate"
    | "hourlyRate"
    | "selfOnboarding"
  >,
): ContractorValidation {
  if (opts.type !== "individual" && opts.type !== "business") {
    return {
      ok: false,
      message: "missing or invalid --type",
      blocked: [{ field: "type", reason: "must be 'individual' or 'business'" }],
    };
  }

  const blocked: BlockedOn[] = [];

  let wageType: WageType | undefined;
  if (!opts.wageType) {
    blocked.push({ field: "wage-type", reason: "required: 'fixed' or 'hourly'" });
  } else if (opts.wageType === "fixed") {
    wageType = "Fixed";
  } else if (opts.wageType === "hourly") {
    wageType = "Hourly";
  } else {
    blocked.push({ field: "wage-type", reason: "must be 'fixed' or 'hourly'" });
  }

  const startDate = opts.startDate;
  if (!startDate) {
    blocked.push({ field: "start-date", reason: "required (YYYY-MM-DD)" });
  } else if (!isValidStartDate(startDate)) {
    blocked.push({ field: "start-date", reason: `must be a valid YYYY-MM-DD date, got: ${startDate}` });
  }

  let hourlyRate: string | undefined;
  if (wageType === "Hourly") {
    if (!opts.hourlyRate) {
      blocked.push({ field: "hourly-rate", reason: "required when --wage-type is hourly" });
    } else {
      const parsed = parsePositiveNumber(opts.hourlyRate);
      if (!parsed.ok) {
        blocked.push({ field: "hourly-rate", reason: parsed.reason });
      } else {
        hourlyRate = opts.hourlyRate;
      }
    }
  }

  const { email } = opts;
  if (!email) blocked.push({ field: "email", reason: "required" });

  // Default to admin-driven: the caller supplies the contractor's details rather than
  // emailing them a self-onboarding invite. Opt in with --self-onboarding.
  const selfOnboarding = opts.selfOnboarding ?? false;

  if (opts.type === "individual") {
    const { firstName, lastName } = opts;
    if (!firstName) blocked.push({ field: "first-name", reason: "required for individual" });
    if (!lastName) blocked.push({ field: "last-name", reason: "required for individual" });
    if (blocked.length > 0 || !firstName || !lastName || !email || !wageType || !startDate) {
      return { ok: false, message: "missing or invalid arguments", blocked };
    }
    return {
      ok: true,
      body: {
        type: "Individual",
        first_name: firstName,
        last_name: lastName,
        email,
        wage_type: wageType,
        start_date: startDate,
        self_onboarding: selfOnboarding,
        ...(hourlyRate ? { hourly_rate: hourlyRate } : {}),
      },
    };
  }

  const { businessName } = opts;
  if (!businessName) blocked.push({ field: "business-name", reason: "required for business" });
  if (blocked.length > 0 || !businessName || !email || !wageType || !startDate) {
    return { ok: false, message: "missing or invalid arguments", blocked };
  }
  return {
    ok: true,
    body: {
      type: "Business",
      business_name: businessName,
      email,
      wage_type: wageType,
      start_date: startDate,
      self_onboarding: selfOnboarding,
      ...(hourlyRate ? { hourly_rate: hourlyRate } : {}),
    },
  };
}

interface ContractorAddOpts {
  type?: ContractorType;
  firstName?: string;
  lastName?: string;
  businessName?: string;
  email?: string;
  wageType?: string;
  startDate?: string;
  hourlyRate?: string;
  selfOnboarding?: boolean;
  companyUuid?: string;
  token?: string;
  dryRun?: boolean;
  example?: boolean;
}

interface ContractorListOpts {
  companyUuid?: string;
  token?: string;
}

interface ContractorShowOpts {
  token?: string;
}

export function registerContractorCommand(parent: Command): void {
  const cmd = parent.command("contractor").description("Add and inspect 1099 contractors");

  cmd
    .command("add")
    .description("Add a 1099 contractor (Individual or Business); admin-driven by default")
    .option("--type <type>", "Contractor type: individual or business")
    .option("--first-name <name>", "First name (required for individual)")
    .option("--last-name <name>", "Last name (required for individual)")
    .option("--business-name <name>", "Business name (required for business)")
    .option("--email <email>", "Email - also where the self-onboarding invite is sent, if enabled")
    .option("--wage-type <type>", "Wage type: fixed or hourly (required)")
    .option("--start-date <date>", "Start date YYYY-MM-DD (required)")
    .option("--hourly-rate <amount>", "Hourly rate (required when --wage-type is hourly)")
    .option("--self-onboarding", "Email the contractor a self-onboarding invite (default: admin-driven)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option(
      "--example",
      "Print a canned sample payload without calling the API (pass --type business for the business shape)",
    )
    .action((opts: ContractorAddOpts) =>
      runCommand("gusto contractor add", readGlobalFlags(parent.opts()), contractorAddHandler(opts)),
    );

  cmd
    .command("show <contractor_uuid>")
    .description("Read contractor record")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((contractorUuid: string, opts: ContractorShowOpts) =>
      runCommand("gusto contractor show", readGlobalFlags(parent.opts()), contractorShowHandler(contractorUuid, opts)),
    );

  cmd
    .command("list")
    .description("List company contractors")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: ContractorListOpts) =>
      runCommand("gusto contractor list", readGlobalFlags(parent.opts()), contractorListHandler(opts)),
    );
}

function contractorAddHandler(opts: ContractorAddOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      const isBusiness = opts.type === "business";
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/contractors",
          body: isBusiness
            ? {
                type: "Business",
                business_name: "Acme LLC",
                email: "billing@acme.example.com",
                wage_type: "Fixed",
                start_date: "2026-06-03",
                self_onboarding: false,
              }
            : {
                type: "Individual",
                first_name: "Sam",
                last_name: "Rivera",
                email: "sam@example.com",
                wage_type: "Fixed",
                start_date: "2026-06-03",
                self_onboarding: false,
              },
          note: "example: canonical request shape, no args or auth required",
        },
      };
    }

    const validation = validateContractorAdd(opts);
    if (!validation.ok) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "validation", message: validation.message, blocked_on: validation.blocked },
      };
    }

    return createCompanyResource(globals, "contractors", validation.body, {
      token: opts.token,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}

function contractorShowHandler(contractorUuid: string, opts: ContractorShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { token: opts.token }, () => `/v1/contractors/${contractorUuid}`);
}

function contractorListHandler(opts: ContractorListOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/contractors`,
    );
}
