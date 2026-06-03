import { resolveBaseUrl } from "../env.ts";
import type { GlobalFlags } from "../global-flags.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import type { Env } from "./login.ts";

export function resolveEnv(globals: GlobalFlags): Env {
  return globals.env === "production" ? "production" : "sandbox";
}

export function oauthHttp(globals: GlobalFlags): OAuthHttpOptions {
  return { baseUrl: resolveBaseUrl(globals.env) };
}
