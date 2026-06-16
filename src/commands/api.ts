import type { Command } from "commander";
import type { ApiClient } from "../lib/api-client.ts";
import { resolveApiContext } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, type CommandResult, runCommand } from "../lib/runner.ts";

const SUPPORTED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof SUPPORTED_METHODS)[number];

/** Placeholder callers can write instead of pasting the bound company UUID into the
 * path; resolved from the token / GUSTO_COMPANY_UUID / --company-uuid. See AINT-610. */
const COMPANY_UUID_PLACEHOLDER = "{company_uuid}";

interface ApiRequestOpts {
  data?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  companyUuid?: string;
}

export function registerApiCommand(parent: Command): void {
  const cmd = parent.command("api").description("Raw call to any Gusto REST endpoint (escape hatch)");

  cmd
    .command("request <method> <path>")
    .description("Raw call to a Gusto REST endpoint; returns the response unchanged")
    .option("--data <json>", "Request body as a JSON string")
    .option("--company-uuid <uuid>", "Company UUID for {company_uuid} (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option("--dry-run", "Build the request without sending")
    .addHelpText(
      "after",
      `
A literal {company_uuid} in the path is replaced with the bound company UUID
(from --company-uuid, GUSTO_COMPANY_UUID, or a company-scoped login).

Examples:
  $ gusto api request GET /v1/me
  $ gusto api request GET /v1/companies/{company_uuid}/employees
  $ gusto api request POST /v1/companies/{company_uuid}/employees --data '{"first_name":"Jane"}'
`,
    )
    .action((method: string, path: string, opts: ApiRequestOpts) =>
      runCommand("gusto api request", readGlobalFlags(parent.opts()), apiRequestHandler(method, path, opts)),
    );
}

export function apiRequestHandler(rawMethod: string, path: string, opts: ApiRequestOpts): CommandHandler {
  return async ({ globals }) => {
    const method = rawMethod.toUpperCase();
    if (!(SUPPORTED_METHODS as readonly string[]).includes(method)) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "unsupported_method", message: `unsupported HTTP method: ${rawMethod}` },
      };
    }

    let body: unknown;
    if (opts.data !== undefined) {
      try {
        body = JSON.parse(opts.data);
      } catch (err) {
        return {
          ok: false,
          exitCode: ExitCode.Validation,
          error: {
            code: "invalid_json",
            message: `--data must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }

    const send = async (client: ApiClient, finalPath: string): Promise<CommandResult> => {
      try {
        const response = await client.request(method as Method, finalPath, body);
        return { ok: true, data: response.body };
      } catch (err) {
        return toResult(err);
      }
    };

    // Plain path: unchanged behavior - no company required, and a dry-run needs no auth.
    if (!path.includes(COMPANY_UUID_PLACEHOLDER)) {
      if (opts.dryRun) {
        return { ok: true, data: { method, path, body } };
      }
      const ctx = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
      if (!ctx.ok) return ctx.result;
      return send(ctx.ctx.client, path);
    }

    // Path carries {company_uuid}: resolve the bound company and substitute it in.
    const ctx = await resolveApiContext(globals, {
      tokenStdin: opts.tokenStdin,
      companyOverride: opts.companyUuid,
    });
    if (!ctx.ok) {
      if (opts.dryRun) {
        return { ok: true, data: { method, path, body, note: "dry-run: token/company not required" } };
      }
      return ctx.result;
    }

    const resolvedPath = path.replaceAll(COMPANY_UUID_PLACEHOLDER, ctx.ctx.companyUuid);
    if (opts.dryRun) {
      return { ok: true, data: { method, path: resolvedPath, body } };
    }
    return send(ctx.ctx.client, resolvedPath);
  };
}
