export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

/** How the platform can authorize an Auth refresh request. */
export type RefreshCapability =
  | { kind: "cookie" }
  | { kind: "token"; token: string };

/** Auth material read or written as one logical value. */
export type SessionRecord = {
  accessToken: string | null;
  refresh: RefreshCapability | null;
  expiresAt: string | null;
};

/** A stable compare-and-set revision paired with its complete session value. */
export type SessionSnapshot = {
  revision: number;
  session: SessionRecord | null;
};

export type SessionStore = {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  getExpiresAt(): Promise<string | null>;
  saveSession(tokens: SessionTokens): Promise<void>;
  clearSession(clearKeys?: boolean): Promise<void>;
  hasPendingProfileSetup(): Promise<boolean>;
  setPendingProfileSetup(value: boolean): Promise<void>;
  /** Optional additive bridge; adapters must implement all three bridge methods together. */
  readSession?(): Promise<SessionSnapshot>;
  /** Atomically replace the expected snapshot and publish a newer revision. */
  compareAndSetSession?(expectedRevision: number, next: SessionRecord): Promise<boolean>;
  /** Atomically write an empty tombstone and publish a newer revision. */
  compareAndClearSession?(expectedRevision: number): Promise<boolean>;
};

export type ClientIdentity = {
  platform: "android" | "ios" | "web";
  appVersion: string;
  buildNumber?: string;
};

export function formatClientHeader(identity: ClientIdentity): string {
  const build = identity.buildNumber ? `+${identity.buildNumber}` : "";
  return `${identity.platform}/${identity.appVersion}${build}`;
}
