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

/** Methods that carry an optimistic-concurrency `version`. --auto-version fetches
 * the resource's current version for these before sending the write. See AINT-610. */
const VERSIONED_METHODS = new Set(["PUT", "PATCH"]);

interface ApiRequestOpts {
  data?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  companyUuid?: string;
  autoVersion?: boolean;
}

export function registerApiCommand(parent: Command): void {
  const cmd = parent.command("api").description("Raw call to any Gusto REST endpoint (escape hatch)");

  cmd
    .command("request <method> <path>")
    .description("Raw call to a Gusto REST endpoint; returns the response unchanged")
    .option("--data <json>", "Request body as a JSON string")
    .option("--company-uuid <uuid>", "Company UUID for {company_uuid} (overrides GUSTO_COMPANY_UUID)")
    .option("--auto-version", "PUT/PATCH only: GET the resource and inject its current version")
    .option(...TOKEN_STDIN_OPT)
    .option("--dry-run", "Build the request without sending")
    .addHelpText(
      "after",
      `
A literal {company_uuid} in the path is replaced with the bound company UUID
(from --company-uuid, GUSTO_COMPANY_UUID, or a company-scoped login).

--auto-version grabs the resource's latest version and injects it into PUT/PATCH update requests (a version you pass in --data always wins).

Examples:
  $ gusto api request GET /v1/me
  $ gusto api request GET /v1/companies/{company_uuid}/employees
  $ gusto api request POST /v1/companies/{company_uuid}/employees --data '{"first_name":"Jane"}'
  $ gusto api request PUT /v1/companies/{company_uuid}/federal_tax_details --auto-version --data '{"filing_form":"941"}'
`,
    )
    .action((method: string, path: string, opts: ApiRequestOpts) =>
      runCommand("gusto api request", readGlobalFlags(parent.opts()), apiRequestHandler(method, path, opts)),
    );
}

export function apiRequestHandler(
  rawMethod: string,
  path: string,
  opts: ApiRequestOpts,
  warn: (msg: string) => void = (m) => void process.stderr.write(`${m}\n`),
): CommandHandler {
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

    const isVersioned = VERSIONED_METHODS.has(method);
    if (opts.autoVersion && !isVersioned) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "auto_version_unsupported", message: "--auto-version only applies to PUT or PATCH requests" },
      };
    }

    // A dry-run never sends; when --auto-version is pending it notes that the version is read at
    // send time (matching the setup/add commands) rather than firing the version GET now.
    const autoVersionPending = opts.autoVersion === true && isVersioned && readString(body, "version") === undefined;
    const dryRunResult = (finalPath: string): CommandResult => ({
      ok: true,
      data: autoVersionPending
        ? { method, path: finalPath, body, note: "dry-run: version is read from the current resource at send time" }
        : { method, path: finalPath, body },
    });

    // Send (real request): substitute is already done; auto-version GETs finalPath for its version.
    // The whole thing is in the try so a failing version GET maps through toResult too (a clean
    // api_client_error envelope), rather than escaping as an unhandled internal_error.
    const send = async (client: ApiClient, finalPath: string): Promise<CommandResult> => {
      try {
        let finalBody = body;
        if (opts.autoVersion && isVersioned) {
          const resolved = await resolveVersion(client, finalPath, body);
          if (!resolved.ok) return resolved.result;
          finalBody = resolved.body;
        }
        const response = await client.request(method as Method, finalPath, finalBody);
        return { ok: true, data: response.body };
      } catch (err) {
        return toResult(err);
      }
    };

    // Plain path: unchanged behavior - no company required, and a dry-run needs no auth.
    if (!path.includes(COMPANY_UUID_PLACEHOLDER)) {
      // --company-uuid only feeds the placeholder; on a plain path it does nothing, so flag the
      // likely mistake (a forgotten `{company_uuid}` token) rather than silently dropping it.
      if (opts.companyUuid) {
        warn(
          `warning: --company-uuid was set but the path has no ${COMPANY_UUID_PLACEHOLDER} placeholder; ignoring it`,
        );
      }
      if (opts.dryRun) return dryRunResult(path);
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
    if (opts.dryRun) return dryRunResult(resolvedPath);
    return send(ctx.ctx.client, resolvedPath);
  };
}

type VersionResolution = { ok: true; body: unknown } | { ok: false; result: CommandResult<never> };

/** GET `path` to learn the resource's current `version` and inject it into `body`,
 * unless the caller already supplied one (theirs always wins). Mirrors the version
 * dance the `company setup` / `employee add` commands run internally. */
async function resolveVersion(client: ApiClient, path: string, body: unknown): Promise<VersionResolution> {
  if (readString(body, "version") !== undefined) return { ok: true, body };

  if (body !== undefined && (typeof body !== "object" || Array.isArray(body))) {
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "auto_version_requires_object",
          message: "--auto-version needs --data to be a JSON object (or omitted) so version can be injected",
        },
      },
    };
  }

  const current = await client.get(path);
  const version = readString(current.body, "version");
  if (version === undefined) {
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "version_unresolved",
          message: `no \`version\` field in the GET ${path} response; pass it explicitly in --data`,
        },
      },
    };
  }

  // Spread the body first so the fetched `version` wins: we only reach here when the
  // caller's version was absent or invalid (empty/non-string), so it must not clobber it.
  const base = (body ?? {}) as Record<string, unknown>;
  return { ok: true, body: { ...base, version } };
}

/** Read a non-empty string field from an unknown object body. */
function readString(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
