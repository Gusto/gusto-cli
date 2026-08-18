import { type AuthOpts, type ResolvedTokenSource, buildApiClient, resolveAuthToken } from "./api-context.ts";
import { defaultEnv, resolveMcpBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { Environment, GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

export type CallMcpToolOpts = AuthOpts;

interface JsonRpcError {
  error: {
    code: number;
    message?: string;
    data?: { details?: string; type?: string | null; retryable?: boolean };
  };
}

interface JsonRpcSuccess {
  result: object;
}

interface ResolvedAuthContext {
  tokenSource: ResolvedTokenSource;
  environment: Environment;
}

// Mirrors the JSON-RPC error codes returned by the Gusto MCP endpoint.
const RPC_TOOL_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL = -32603;
const RPC_AUTH = -32000;
const RPC_NOT_FOUND = -32001;
const RPC_BAD_REQUEST = -32002;
const RPC_RATE_LIMIT = -32003;

export async function callMcpTool(
  globals: GlobalFlags,
  opts: CallMcpToolOpts,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CommandResult> {
  const resolved = await resolveAuthToken(globals, opts);
  if (!resolved.ok) return resolved.result;

  const environment = defaultEnv(globals.env);
  const client = buildApiClient(globals, {
    baseUrl: resolveMcpBaseUrl(globals.env),
    token: resolved.token,
    auth: { tokenSource: resolved.source, environment },
  });

  const body = {
    jsonrpc: "2.0" as const,
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  try {
    const response = await client.post<unknown>("/", body);
    return interpretJsonRpc(response.body, toolName, { tokenSource: resolved.source, environment });
  } catch (err) {
    return toResult(err);
  }
}

function interpretJsonRpc(body: unknown, toolName: string, auth: ResolvedAuthContext): CommandResult {
  if (isJsonRpcError(body)) return mapRpcError(body, toolName, auth);
  if (isJsonRpcSuccess(body)) return unwrapResult(body);
  return {
    ok: false,
    exitCode: ExitCode.ApiServer,
    error: { code: "mcp_invalid_response", message: "Server response is missing both `result` and `error`" },
  };
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const err = (value as { error: unknown }).error;
  return typeof err === "object" && err !== null && typeof (err as { code: unknown }).code === "number";
}

function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const { result } = value as { result: unknown };
  return typeof result === "object" && result !== null;
}

function parseTextBlock(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapResult(rpc: JsonRpcSuccess): CommandResult {
  const { content } = rpc.result as { content?: unknown };
  if (!Array.isArray(content) || content.length === 0) {
    return { ok: true, data: rpc.result };
  }
  const textBlocks = content.filter(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" &&
      c !== null &&
      (c as { type?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string",
  );
  if (textBlocks.length === 0) return { ok: true, data: rpc.result };
  if (textBlocks.length === 1) return { ok: true, data: parseTextBlock(textBlocks[0]!.text) };
  return { ok: true, data: textBlocks.map((b) => parseTextBlock(b.text)) };
}

/** Auth context is only attached to the two auth-family codes below. A scope is granted per
 * credential and a credential is per environment, so those two need both fields to identify the
 * failing token and prescribe a recovery that can replace it. Being JSON-RPC rather than HTTP, they
 * never pass through an `ApiError`, so the context the client stamps can't reach them. */
function mapRpcError(rpc: JsonRpcError, toolName: string, auth: ResolvedAuthContext): CommandResult<never> {
  const { code, message, data } = rpc.error;
  const { environment } = auth;
  // `||` (not `??`) so an empty-string `details` falls back to `message` instead of swallowing it.
  const display = (data?.details || message) ?? "";
  switch (code) {
    case RPC_TOOL_NOT_FOUND:
      // tool_not_found doubles as the under-scoped response (security: don't reveal tool existence).
      return {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "mcp_tool_not_found",
          message: `'${toolName}' is not available to this ${environment} token. This usually means the token is missing the required OAuth scope. ${mcpScopeRecovery(auth)}${display ? ` Details: ${display}` : ""}`,
          environment,
        },
      };
    case RPC_INVALID_PARAMS:
      return { ok: false, exitCode: ExitCode.ApiClient, error: { code: "mcp_invalid_params", message: display } };
    case RPC_AUTH:
      // `display` is the gateway's own string and can be empty, which would leave an exit-3 failure
      // with no message at all - the one outcome this taxonomy exists to prevent. Fall back to
      // wording that at least names the credential and the environment it was aimed at.
      return {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "mcp_unauthorized",
          message: display || mcpRejectedCredential(auth),
          environment,
        },
      };
    case RPC_NOT_FOUND:
      return { ok: false, exitCode: ExitCode.ApiClient, error: { code: "mcp_not_found", message: display } };
    case RPC_BAD_REQUEST:
      return { ok: false, exitCode: ExitCode.ApiClient, error: { code: "mcp_bad_request", message: display } };
    case RPC_RATE_LIMIT:
      return {
        ok: false,
        exitCode: ExitCode.Network,
        error: { code: "mcp_rate_limited", message: display, details: { retryable: true } },
      };
    case RPC_INTERNAL:
      return { ok: false, exitCode: ExitCode.ApiServer, error: { code: "mcp_internal_error", message: display } };
    default:
      return { ok: false, exitCode: ExitCode.ApiServer, error: { code: "mcp_error", message: display } };
  }
}

function mcpScopeRecovery(auth: ResolvedAuthContext): string {
  switch (auth.tokenSource) {
    case "session":
      return `Re-run \`gusto auth login --env ${auth.environment}\` and grant the scope, or run \`gusto auth whoami --env ${auth.environment}\` to inspect what you have.`;
    case "env":
      return `Replace GUSTO_ACCESS_TOKEN with a token that grants the scope, or run \`gusto auth whoami --env ${auth.environment}\` to inspect it.`;
    case "stdin":
      return `Pipe a token that grants the scope via --token-stdin; pipe the same token to \`gusto auth whoami --token-stdin --env ${auth.environment}\` to inspect it.`;
  }
}

function mcpRejectedCredential(auth: ResolvedAuthContext): string {
  switch (auth.tokenSource) {
    case "session":
      return `the stored ${auth.environment} session was refused by the MCP gateway. Re-run \`gusto auth login --env ${auth.environment}\` to sign in again, or run \`gusto auth whoami --env ${auth.environment}\` to inspect it.`;
    case "env":
      return `the token in GUSTO_ACCESS_TOKEN was refused by the ${auth.environment} MCP gateway. Replace that token, or run \`gusto auth whoami --env ${auth.environment}\` to inspect it.`;
    case "stdin":
      return `the token piped via --token-stdin was refused by the ${auth.environment} MCP gateway. Pipe a replacement token, or pipe the same token to \`gusto auth whoami --token-stdin --env ${auth.environment}\` to inspect it.`;
  }
}
