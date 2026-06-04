import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { fetchCompanyResource } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { companyUuidFromTokenInfo, defaultOpenBrowser } from "../lib/oauth/login.ts";
import { type ProvisionResult, provision } from "../lib/oauth/provision.ts";
import { InputError, resolveProvisionPayload } from "../lib/oauth/provision-input.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import { type CommandHandler, type CommandResult, runCommand } from "../lib/runner.ts";

interface CompanyShowOpts {
  companyUuid?: string;
  token?: string;
}

interface ProvisionOpts {
  input?: string;
  example?: boolean;
  dryRun?: boolean;
}

export function registerCompanyCommand(parent: Command): void {
  const cmd = parent.command("company").description("Provision, inspect, and finish company onboarding");

  cmd
    .command("provision")
    .description("Create a Gusto company programmatically (the wedge command)")
    .option("--input <file>", "Path to a JSON file with the {user, company} payload")
    .option("--example", "Use the canned sample payload")
    .option("--dry-run", "Build the request without sending")
    .action((opts: ProvisionOpts) =>
      runCommand("gusto company provision", readGlobalFlags(parent.opts()), companyProvisionHandler(opts)),
    );

  cmd
    .command("status")
    .description("Show onboarding status + structured blocked_on list")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: CompanyShowOpts) =>
      runCommand("gusto company status", readGlobalFlags(parent.opts()), companyStatusHandler(opts)),
    );

  cmd
    .command("show")
    .description("Read company record (legal name, EIN, entity type, addresses)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: CompanyShowOpts) =>
      runCommand("gusto company show", readGlobalFlags(parent.opts()), companyShowHandler(opts)),
    );

  cmd
    .command("finish")
    .description("Transition to onboarded (endpoint TBD - landing with AINT-562)")
    .action(() => runCommand("gusto company finish", readGlobalFlags(parent.opts()), companyFinishHandler()));
}

function companyShowHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}`,
    );
}

function companyStatusHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/onboarding_status`,
    );
}

export interface ProvisionData {
  account_claim_url: string;
  company_uuid: string | null;
}

export function provisionResultData(result: ProvisionResult): ProvisionData {
  return {
    account_claim_url: result.accountClaimUrl,
    company_uuid: companyUuidFromTokenInfo(result.tokenInfo) ?? null,
  };
}

/** Map a payload-resolution failure: bad input is a validation error, anything else flows through toResult. */
export function provisionPayloadError(err: unknown): CommandResult<never> {
  if (err instanceof InputError) {
    return { ok: false, exitCode: ExitCode.Validation, error: { code: "invalid_input", message: err.message } };
  }
  return toResult(err);
}

const NOT_INTERACTIVE: CommandResult<never> = {
  ok: false,
  exitCode: ExitCode.General,
  error: {
    code: "not_interactive",
    message:
      "`gusto company provision` is interactive - it opens a browser and waits for you to claim the account. Run it in a terminal, or use --dry-run to preview the request.",
  },
};

function companyProvisionHandler(opts: ProvisionOpts): CommandHandler {
  return async ({ globals }) => {
    let payload;
    try {
      payload = await resolveProvisionPayload({ input: opts.input, example: opts.example }, (p) => Bun.file(p).text());
    } catch (err) {
      return provisionPayloadError(err);
    }

    if (opts.dryRun) {
      return { ok: true, data: { method: "POST", path: "/v1/provision", body: payload } };
    }
    if (!process.stdin.isTTY) return NOT_INTERACTIVE;

    try {
      const result = await provision(resolveEnv(globals), payload, {
        store: resolveStore(),
        http: oauthHttp(globals),
        openBrowser: defaultOpenBrowser,
        confirmClaim: waitForEnter,
      });
      return { ok: true, data: provisionResultData(result) };
    } catch (err) {
      return toResult(err);
    }
  };
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question("Press Enter once you've finished claiming the account in your browser...");
  } catch {
    // stdin closed/EOF before Enter (disconnected TTY etc.) - treat as continue rather than hang.
  } finally {
    rl.close();
  }
}

function companyFinishHandler(): CommandHandler {
  return async () => ({
    ok: false,
    exitCode: ExitCode.General,
    error: {
      code: "endpoint_unknown",
      message:
        "`gusto company finish` is deferred - the finalize endpoint depends on the Mode 1 path. Landing with AINT-562.",
    },
  });
}
