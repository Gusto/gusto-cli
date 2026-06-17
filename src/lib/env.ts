import type { Environment } from "./global-flags.ts";

const SANDBOX_BASE_URL = "https://api.gusto-demo.com";
const PRODUCTION_BASE_URL = "https://api.gusto.com";

const SANDBOX_MCP_BASE_URL = "https://mcp.api.gusto-demo.com";
const PRODUCTION_MCP_BASE_URL = "https://mcp.api.gusto.com";

export const DEFAULT_API_VERSION = "2026-02-01";

export type EnvSource = Record<string, string | undefined>;

function resolveHttpsBaseUrl(
  envVarName: string,
  defaults: { sandbox: string; production: string },
  env: Environment | undefined,
  source: EnvSource,
): string {
  const override = source[envVarName];
  if (override) {
    let parsed: URL;
    try {
      parsed = new URL(override);
    } catch {
      throw new Error(`${envVarName} is not a valid URL: ${override}`);
    }
    if (parsed.protocol === "https:") return override;
    if (parsed.protocol === "http:" && isTruthy(source.GUSTO_ALLOW_HTTP)) return override;
    throw new Error(`${envVarName} must be https:// (set GUSTO_ALLOW_HTTP=1 to allow http for local testing)`);
  }
  return env === "production" ? defaults.production : defaults.sandbox;
}

export function resolveBaseUrl(env: Environment | undefined, source: EnvSource = process.env as EnvSource): string {
  return resolveHttpsBaseUrl(
    "GUSTO_API_BASE_URL",
    { sandbox: SANDBOX_BASE_URL, production: PRODUCTION_BASE_URL },
    env,
    source,
  );
}

export function resolveMcpBaseUrl(env: Environment | undefined, source: EnvSource = process.env as EnvSource): string {
  return resolveHttpsBaseUrl(
    "GUSTO_MCP_BASE_URL",
    { sandbox: SANDBOX_MCP_BASE_URL, production: PRODUCTION_MCP_BASE_URL },
    env,
    source,
  );
}

/** Parse a boolean-ish env var: truthy only for `1`/`true`/`yes` (case-insensitive). */
export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function resolveApiVersion(source: EnvSource = process.env as EnvSource): string {
  return source.GUSTO_API_VERSION ?? DEFAULT_API_VERSION;
}

export function getAccessToken(source: EnvSource = process.env as EnvSource): string | null {
  const token = source.GUSTO_ACCESS_TOKEN;
  return token && token.length > 0 ? token : null;
}

export function getCompanyUuid(override?: string, source: EnvSource = process.env as EnvSource): string | null {
  if (override && override.length > 0) return override;
  const uuid = source.GUSTO_COMPANY_UUID;
  return uuid && uuid.length > 0 ? uuid : null;
}
