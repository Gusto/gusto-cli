import type { Environment } from "./global-flags.ts";

const SANDBOX_BASE_URL = "https://api.gusto-demo.com";
const PRODUCTION_BASE_URL = "https://api.gusto.com";

export const DEFAULT_API_VERSION = "2026-02-01";

export type EnvSource = Record<string, string | undefined>;

export function resolveBaseUrl(env: Environment | undefined, source: EnvSource = process.env as EnvSource): string {
  if (source.GUSTO_API_BASE_URL) return source.GUSTO_API_BASE_URL;
  if (env === "production") return PRODUCTION_BASE_URL;
  return SANDBOX_BASE_URL;
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
