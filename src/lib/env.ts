import type { Environment } from "./global-flags.ts";

const SANDBOX_BASE_URL = "https://api.gusto-demo.com";
const PRODUCTION_BASE_URL = "https://api.gusto.com";

export const DEFAULT_API_VERSION = "2026-02-01";

export type EnvSource = Record<string, string | undefined>;

export function resolveBaseUrl(env: Environment | undefined, source: EnvSource = process.env as EnvSource): string {
  const override = source.GUSTO_API_BASE_URL;
  if (override) {
    const parsed = new URL(override);
    if (parsed.protocol !== "https:" && !isTruthy(source.GUSTO_ALLOW_HTTP)) {
      throw new Error("GUSTO_API_BASE_URL must be https:// (set GUSTO_ALLOW_HTTP=1 to allow http for local testing)");
    }
    return override;
  }
  if (env === "production") return PRODUCTION_BASE_URL;
  return SANDBOX_BASE_URL;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function resolveApiVersion(source: EnvSource = process.env as EnvSource): string {
  return source.GUSTO_API_VERSION ?? DEFAULT_API_VERSION;
}

export function getAccessToken(override?: string, source: EnvSource = process.env as EnvSource): string | null {
  if (override && override.length > 0) return override;
  const token = source.GUSTO_ACCESS_TOKEN;
  return token && token.length > 0 ? token : null;
}

export function getCompanyUuid(override?: string, source: EnvSource = process.env as EnvSource): string | null {
  if (override && override.length > 0) return override;
  const uuid = source.GUSTO_COMPANY_UUID;
  return uuid && uuid.length > 0 ? uuid : null;
}
