export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
}

export interface StoredSession {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  // Persisted from a company-scoped login so resource commands resolve a company without --company-uuid/env.
  companyUuid?: string;
  // The OAuth scopes the token was granted (from the token response / token_info).
  // Surfaced by `whoami`; absent on sessions saved before this existed.
  scopes?: string[];
}

export function hasClientCreds(s: StoredSession | null): s is StoredSession & ClientCreds {
  return s != null && typeof s.clientId === "string" && typeof s.clientSecret === "string";
}
