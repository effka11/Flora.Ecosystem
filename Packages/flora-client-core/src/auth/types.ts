export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

export type SessionStore = {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  saveSession(tokens: SessionTokens): Promise<void>;
  clearSession(clearKeys?: boolean): Promise<void>;
  hasPendingProfileSetup(): Promise<boolean>;
  setPendingProfileSetup(value: boolean): Promise<void>;
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
