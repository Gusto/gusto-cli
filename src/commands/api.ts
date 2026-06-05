import type { Command } from "commander";
import { resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

const SUPPORTED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof SUPPORTED_METHODS)[number];

interface ApiRequestOpts {
  data?: string;
  token?: string;
  dryRun?: boolean;
}

export function registerApiCommand(parent: Command): void {
  const cmd = parent.command("api").description("Raw call to any Gusto REST endpoint (escape hatch)");

  cmd
    .command("request <method> <path>")
    .description("Raw call to a Gusto REST endpoint; returns the response unchanged")
    .option("--data <json>", "Request body as a JSON string")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto api request GET /v1/me
  $ gusto api request POST /v1/companies/uuid/employees --data '{"first_name":"Jane"}'
`,
    )
    .action((method: string, path: string, opts: ApiRequestOpts) =>
      runCommand("gusto api request", readGlobalFlags(parent.opts()), apiRequestHandler(method, path, opts)),
    );
}

function apiRequestHandler(rawMethod: string, path: string, opts: ApiRequestOpts): CommandHandler {
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

    if (opts.dryRun) {
      return { ok: true, data: { method, path, body } };
    }

    const ctx = await resolveApiContext(globals, { tokenOverride: opts.token, requireCompany: false });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.request(method as Method, path, body);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}
