import type { Command } from "commander";
import { resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

type ContractorType = "individual" | "business";

interface ContractorAddOpts {
  type?: ContractorType;
  firstName?: string;
  lastName?: string;
  businessName?: string;
  email?: string;
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
    .description("One-call 1099 onboarding with auto-invite (Individual or Business)")
    .option("--type <type>", "Contractor type: individual or business")
    .option("--first-name <name>", "First name (required for individual)")
    .option("--last-name <name>", "Last name (required for individual)")
    .option("--business-name <name>", "Business name (required for business)")
    .option("--email <email>", "Email - also where the invite is sent")
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
                self_onboarding: true,
              }
            : {
                type: "Individual",
                first_name: "Sam",
                last_name: "Rivera",
                email: "sam@example.com",
                self_onboarding: true,
              },
          note: "example: canonical request shape, no args or auth required",
        },
      };
    }

    if (opts.type !== "individual" && opts.type !== "business") {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "validation",
          message: "missing or invalid --type",
          blocked_on: [{ field: "type", reason: "must be 'individual' or 'business'" }],
        },
      };
    }

    const blocked = [];
    if (!opts.email) blocked.push({ field: "email", reason: "required" });
    if (opts.type === "individual") {
      if (!opts.firstName) blocked.push({ field: "first-name", reason: "required for individual" });
      if (!opts.lastName) blocked.push({ field: "last-name", reason: "required for individual" });
    } else {
      if (!opts.businessName) blocked.push({ field: "business-name", reason: "required for business" });
    }
    if (blocked.length > 0) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "validation", message: "missing required arguments", blocked_on: blocked },
      };
    }

    const body =
      opts.type === "individual"
        ? {
            type: "Individual",
            first_name: opts.firstName,
            last_name: opts.lastName,
            email: opts.email,
            self_onboarding: true,
          }
        : {
            type: "Business",
            business_name: opts.businessName,
            email: opts.email,
            self_onboarding: true,
          };

    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) {
      if (opts.dryRun) {
        return {
          ok: true,
          data: {
            method: "POST",
            path: "/v1/companies/{company_uuid}/contractors",
            body,
            note: "dry-run: token/company not required",
          },
        };
      }
      return ctx.result;
    }

    const path = `/v1/companies/${ctx.ctx.companyUuid}/contractors`;
    if (opts.dryRun) {
      return { ok: true, data: { method: "POST", path, body } };
    }

    try {
      const response = await ctx.ctx.client.post(path, body);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}

function contractorShowHandler(contractorUuid: string, opts: ContractorShowOpts): CommandHandler {
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, requireCompany: false });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/contractors/${contractorUuid}`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}

function contractorListHandler(opts: ContractorListOpts): CommandHandler {
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/companies/${ctx.ctx.companyUuid}/contractors`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}
