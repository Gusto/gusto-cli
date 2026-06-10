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
  // The OAuth scopes the token was granted, parsed at login from the token
  // response / token_info. Persisted for offline use; `whoami` itself reads
  // scopes live from token_info. Absent on sessions saved before this existed.
  scopes?: string[];
}

export function hasClientCreds(s: StoredSession | null): s is StoredSession & ClientCreds {
  return s != null && typeof s.clientId === "string" && typeof s.clientSecret === "string";
}
