import type { Command } from "commander";
import type { ApiClient } from "../lib/api-client.ts";
import { fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { ALL_OPT, CURSOR_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { createdWithoutUuidError, partialFailure, toResult } from "../lib/handle-api-error.ts";
import type { BlockedOn } from "../lib/output.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
import { parsePositiveNumber, pushRequiredIsoDate } from "../lib/parse.ts";
import { readString } from "../lib/read-string.ts";
import {
  type CommandHandler,
  type CommandResult,
  type ValidationResult,
  runCommand,
  runReadCommand,
  validationFailure,
} from "../lib/runner.ts";

type ContractorType = "individual" | "business";
type WageType = "Fixed" | "Hourly";

type ContractorWage = { wage_type: "Fixed" } | { wage_type: "Hourly"; hourly_rate: string };

/** The surface is self-onboarding-only: `self_onboarding` is fixed true and `email` is always
 * required - the admin-driven path that would take a contractor's SSN/EIN/bank through the agent
 * is deliberately not exposed. */
type ContractorCommon = {
  start_date: string;
  self_onboarding: true;
  email: string;
} & ContractorWage;

export type ContractorBody =
  | ({ type: "Individual"; first_name: string; last_name: string } & ContractorCommon)
  | ({ type: "Business"; business_name: string } & ContractorCommon);

export type ContractorValidation = ValidationResult<ContractorBody>;

interface ContractorAddOpts {
  type?: ContractorType;
  firstName?: string;
  lastName?: string;
  businessName?: string;
  email?: string;
  wageType?: string;
  startDate?: string;
  hourlyRate?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

interface ContractorListOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

interface ContractorShowOpts {
  tokenStdin?: boolean;
}

export function validateContractorAdd(
  opts: Pick<
    ContractorAddOpts,
    "type" | "firstName" | "lastName" | "businessName" | "email" | "wageType" | "startDate" | "hourlyRate"
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
  pushRequiredIsoDate(blocked, "start-date", startDate);

  let wage: ContractorWage | undefined;
  if (wageType === "Hourly") {
    if (!opts.hourlyRate) {
      blocked.push({ field: "hourly-rate", reason: "required when --wage-type is hourly" });
    } else {
      const parsed = parsePositiveNumber(opts.hourlyRate);
      if (!parsed.ok) {
        blocked.push({ field: "hourly-rate", reason: parsed.reason });
      } else {
        // Forward the value we actually validated, not the raw input: Number() accepts forms the
        // API won't (e.g. "1e3", "0x10", " 45 "), so normalize them to a plain decimal string.
        wage = { wage_type: "Hourly", hourly_rate: String(parsed.value) };
      }
    }
  } else if (wageType === "Fixed") {
    if (opts.hourlyRate) {
      blocked.push({ field: "hourly-rate", reason: "not allowed when --wage-type is fixed" });
    } else {
      wage = { wage_type: "Fixed" };
    }
  }

  const { email } = opts;
  if (!email) blocked.push({ field: "email", reason: "required (where the self-onboarding invite is sent)" });

  if (opts.type === "individual") {
    const { firstName, lastName } = opts;
    if (!firstName) blocked.push({ field: "first-name", reason: "required for individual" });
    if (!lastName) blocked.push({ field: "last-name", reason: "required for individual" });
    if (opts.businessName) blocked.push({ field: "business-name", reason: "not allowed for --type individual" });
    if (blocked.length > 0 || !firstName || !lastName || !email || !wage || !startDate) {
      return { ok: false, message: "missing or invalid arguments", blocked };
    }
    return {
      ok: true,
      body: {
        type: "Individual",
        first_name: firstName,
        last_name: lastName,
        start_date: startDate,
        self_onboarding: true,
        email,
        ...wage,
      },
    };
  }

  const { businessName } = opts;
  if (!businessName) blocked.push({ field: "business-name", reason: "required for business" });
  if (opts.firstName) blocked.push({ field: "first-name", reason: "not allowed for --type business" });
  if (opts.lastName) blocked.push({ field: "last-name", reason: "not allowed for --type business" });
  if (blocked.length > 0 || !businessName || !email || !wage || !startDate) {
    return { ok: false, message: "missing or invalid arguments", blocked };
  }
  return {
    ok: true,
    body: {
      type: "Business",
      business_name: businessName,
      start_date: startDate,
      self_onboarding: true,
      email,
      ...wage,
    },
  };
}

export function registerContractorCommand(parent: Command): void {
  const cmd = parent.command("contractor").description("Add and inspect 1099 contractors");

  cmd
    .command("add")
    .description("Add a 1099 contractor (Individual or Business) and email them a self-onboarding invite")
    .option("--type <type>", "Contractor type: individual or business")
    .option("--first-name <name>", "First name (required for individual)")
    .option("--last-name <name>", "Last name (required for individual)")
    .option("--business-name <name>", "Business name (required for business)")
    .option("--email <email>", "Email where the self-onboarding invite is sent (required)")
    .option("--wage-type <type>", "Wage type: fixed or hourly (required)")
    .option("--start-date <date>", "Start date YYYY-MM-DD (required)")
    .option("--hourly-rate <amount>", "Hourly rate (required when --wage-type is hourly)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option("--dry-run", "Build the request without sending")
    .option(
      "--example",
      "Print a canned sample payload without calling the API (pass --type business for the business shape)",
    )
    .addHelpText(
      "after",
      `
The contractor enters their own SSN/EIN and bank details in Gusto's hosted self-onboarding
flow - the CLI only collects the non-sensitive fields the invite needs and never handles a
contractor's identity or payment data.
`,
    )
    .action((opts: ContractorAddOpts) =>
      runCommand("gusto contractor add", readGlobalFlags(parent.opts()), contractorAddHandler(opts)),
    );

  cmd
    .command("show <contractor_uuid>")
    .description("Read contractor record")
    .option(...TOKEN_STDIN_OPT)
    .action((contractorUuid: string, opts: ContractorShowOpts) =>
      runReadCommand(
        "gusto contractor show",
        readGlobalFlags(parent.opts()),
        contractorShowHandler(contractorUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company contractors")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum contractors to return across pages")
    .option(...ALL_OPT)
    .action((opts: ContractorListOpts) =>
      runReadCommand("gusto contractor list", readGlobalFlags(parent.opts()), contractorListHandler(opts)),
    );
}

function contractorAddHandler(opts: ContractorAddOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      const isBusiness = opts.type === "business";
      return {
        ok: true,
        data: {
          steps: contractorSelfOnboardSteps(
            isBusiness
              ? {
                  type: "Business",
                  business_name: "Acme LLC",
                  email: "billing@acme.example.com",
                  wage_type: "Fixed",
                  start_date: "2026-06-03",
                  self_onboarding: true,
                }
              : {
                  type: "Individual",
                  first_name: "Sam",
                  last_name: "Rivera",
                  email: "sam@example.com",
                  wage_type: "Fixed",
                  start_date: "2026-06-03",
                  self_onboarding: true,
                },
          ),
          note: "example: canonical request shape, no args or auth required",
        },
      };
    }

    const validation = validateContractorAdd(opts);
    if (!validation.ok) return validationFailure(validation.message, validation.blocked);
    const body = validation.body;

    if (opts.dryRun) {
      return { ok: true, data: { steps: contractorSelfOnboardSteps(body) } };
    }
    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, (ctx) =>
      runContractorAdd(ctx.client, ctx.companyUuid, body),
    );
  };
}

const SELF_ONBOARDING_INVITE_STATUS = "self_onboarding_invited";

/** Two calls: the POST only registers the contractor as not-yet-invited; the invite is a separate
 * PUT to onboarding_status. If the invite fails after the create, surface the created contractor
 * and its uuid so a retry resends the invite rather than POSTing a duplicate. */
export async function runContractorAdd(
  client: ApiClient,
  companyUuid: string,
  body: ContractorBody,
): Promise<CommandResult> {
  let contractor: unknown;
  try {
    const res = await client.post(`/v1/companies/${companyUuid}/contractors`, body);
    contractor = res.body;
  } catch (err) {
    return toResult(err);
  }

  const contractorUuid = readString(contractor, "uuid");
  if (!contractorUuid) {
    return createdWithoutUuidError({
      code: "contractor_created_without_uuid",
      message:
        "contractor was created but the response carried no uuid, so the self-onboarding invite couldn't be sent. Find the contractor via `gusto contractor list`, then invite them in the Gusto dashboard.",
      details: { contractor },
    });
  }

  try {
    const res = await client.put(`/v1/contractors/${contractorUuid}/onboarding_status`, {
      onboarding_status: SELF_ONBOARDING_INVITE_STATUS,
    });
    return { ok: true, data: { contractor, onboarding_status: res.body } };
  } catch (err) {
    return partialFailure({
      code: "self_onboarding_invite_failed",
      message: "contractor created but sending the self-onboarding invite failed",
      err,
      completed: { contractor },
      failedDomain: "onboarding_status",
    });
  }
}

/** Steps for --dry-run/--example. The uuid isn't known until the POST returns, so the invite PUT
 * carries a `{contractor_uuid}` placeholder. */
function contractorSelfOnboardSteps(body: ContractorBody): Record<string, unknown>[] {
  return [
    { method: "POST", path: "/v1/companies/{company_uuid}/contractors", body },
    {
      method: "PUT",
      path: "/v1/contractors/{contractor_uuid}/onboarding_status",
      body: { onboarding_status: SELF_ONBOARDING_INVITE_STATUS },
    },
  ];
}

function contractorShowHandler(contractorUuid: string, opts: ContractorShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/contractors/${contractorUuid}`);
}

export function contractorListHandler(opts: ContractorListOpts): CommandHandler {
  return async ({ globals }) => {
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);
    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const { items, next } = await ctx.client.paginate(`/v1/companies/${ctx.companyUuid}/contractors`, pg.body);
      return { ok: true, data: items, next: pg.body.surfaceNext ? next : undefined };
    });
  };
}
