import { ApiClient } from "./api-client.ts";
import { type ApiContextOpts, resolveAuthToken } from "./api-context.ts";
import { resolveApiVersion, resolveMcpBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

export interface CallMcpToolOpts extends ApiContextOpts {
  client?: ApiClient;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: { content?: Array<{ type: string; text: string }> } & Record<string, unknown>;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: { details?: string; type?: string | null; retryable?: boolean } };
}

// Mirrors Api::V1::Mcp::BaseController::JsonRpcErrorCodes.
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

  const client =
    opts.client ??
    new ApiClient({
      baseUrl: resolveMcpBaseUrl(globals.env),
      token: resolved.token,
      apiVersion: resolveApiVersion(),
    });

  const body = {
    jsonrpc: "2.0" as const,
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  try {
    const response = await client.post<unknown>("/", body);
    return interpretJsonRpc(response.body, toolName);
  } catch (err) {
    return toResult(err);
  }
}

function interpretJsonRpc(body: unknown, toolName: string): CommandResult {
  if (isJsonRpcError(body)) return mapRpcError(body, toolName);
  if (isJsonRpcSuccess(body)) return unwrapResult(body);
  return {
    ok: false,
    exitCode: ExitCode.ApiServer,
    error: { code: "mcp_invalid_response", message: "MCP server response is missing both `result` and `error`" },
  };
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object" &&
    (value as { error: { code?: unknown } }).error !== null &&
    typeof (value as { error: { code: unknown } }).error.code === "number"
  );
}

function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const { result } = value as { result: unknown };
  return typeof result === "object" && result !== null;
}

function unwrapResult(rpc: JsonRpcSuccess): CommandResult {
  const first = rpc.result.content?.[0];
  if (first && first.type === "text" && typeof first.text === "string") {
    try {
      return { ok: true, data: JSON.parse(first.text) };
    } catch {
      return { ok: true, data: first.text };
    }
  }
  return { ok: true, data: rpc.result };
}

function mapRpcError(rpc: JsonRpcError, toolName: string): CommandResult<never> {
  const { code, message, data } = rpc.error;
  const details = data?.details;
  switch (code) {
    case RPC_TOOL_NOT_FOUND:
      // tool_not_found doubles as the under-scoped response (security: don't reveal tool existence).
      return {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "mcp_tool_not_found",
          message: `MCP tool '${toolName}' is not available to this token. This usually means the token is missing the required OAuth scope. Re-run \`gusto auth login\` and grant the scope, or run \`gusto auth whoami\` to inspect what you have.${details ? ` Details: ${details}` : ""}`,
        },
      };
    case RPC_INVALID_PARAMS:
      return {
        ok: false,
        exitCode: ExitCode.ApiClient,
        error: { code: "mcp_invalid_params", message: details ?? message },
      };
    case RPC_AUTH:
      return {
        ok: false,
        exitCode: ExitCode.Auth,
        error: { code: "mcp_unauthorized", message: details ?? message },
      };
    case RPC_NOT_FOUND:
      return {
        ok: false,
        exitCode: ExitCode.ApiClient,
        error: { code: "mcp_not_found", message: details ?? message },
      };
    case RPC_BAD_REQUEST:
      return {
        ok: false,
        exitCode: ExitCode.ApiClient,
        error: { code: "mcp_bad_request", message: details ?? message },
      };
    case RPC_RATE_LIMIT:
      return {
        ok: false,
        exitCode: ExitCode.Network,
        error: { code: "mcp_rate_limited", message: details ?? message, details: { retryable: true } },
      };
    case RPC_INTERNAL:
      return {
        ok: false,
        exitCode: ExitCode.ApiServer,
        error: { code: "mcp_internal_error", message: details ?? message },
      };
    default:
      return {
        ok: false,
        exitCode: ExitCode.ApiServer,
        error: { code: "mcp_error", message: details ?? message, details: { rpc_code: code } },
      };
  }
}
