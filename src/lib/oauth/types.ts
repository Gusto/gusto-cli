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
  companyUuid?: string;
}

export function hasClientCreds(s: StoredSession | null): s is StoredSession & ClientCreds {
  return s != null && typeof s.clientId === "string" && typeof s.clientSecret === "string";
}
