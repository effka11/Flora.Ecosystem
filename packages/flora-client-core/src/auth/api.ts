import {
  authDelete,
  authDeleteJson,
  authGetJson,
  authPatchJson,
  authPostForm,
  authPostJson,
  getApiClientConfig,
  publicPostJson,
  supersedeSessionRefresh,
} from "../api/client.js";
import {
  parseLoginPayload,
  parseMePayload,
  parsePasswordResetCompletePayload,
  parsePasswordResetStartPayload,
  parsePasswordResetVerifyPayload,
  parseRegisterInitPayload,
  parseTwoFactorChallenge,
  type LoginResponse,
  type LoginResult,
  type MeResponse,
  type PasswordResetCompleteResponse,
  type PasswordResetStartResponse,
  type PasswordResetVerifyResponse,
  type RegisterInitResponse,
} from "../contracts/auth.js";
import { readBool, readStr } from "../contracts/parse.js";
import {
  privacyDraftFromApi,
  privacyDraftToApiPayload,
  type SettingsPrivacyDraft,
} from "./privacySettings.js";
import type { SessionTokens } from "./types.js";

function parseCtx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export async function apiLogin(
  email: string,
  password: string,
  twoFactorCode?: string,
): Promise<LoginResult> {
  const raw = await publicPostJson("/api/auth/login", {
    email,
    password,
    ...(twoFactorCode ? { twoFactorCode } : {}),
  });
  const challenge = parseTwoFactorChallenge(raw);
  if (challenge) return challenge;
  return parseLoginPayload(raw, parseCtx());
}

export async function apiRegister(email: string, password: string): Promise<RegisterInitResponse> {
  const raw = await publicPostJson("/api/auth/register", { email, password });
  return parseRegisterInitPayload(raw, parseCtx());
}

export async function apiVerifyRegistration(input: {
  verificationToken: string;
  code: string;
}): Promise<LoginResponse> {
  const raw = await publicPostJson("/api/auth/verify-registration", input);
  return parseLoginPayload(raw, parseCtx());
}

export async function apiCancelRegistration(verificationToken: string): Promise<void> {
  await publicPostJson("/api/auth/cancel-registration", { verificationToken });
}

export async function apiPasswordResetStart(email: string): Promise<PasswordResetStartResponse> {
  const raw = await publicPostJson("/api/auth/password-reset/start", { email });
  return parsePasswordResetStartPayload(raw, parseCtx());
}

export async function apiPasswordResetVerify(input: {
  resetToken: string;
  code: string;
}): Promise<PasswordResetVerifyResponse> {
  const raw = await publicPostJson("/api/auth/password-reset/verify", input);
  return parsePasswordResetVerifyPayload(raw, parseCtx());
}

export async function apiPasswordResetComplete(input: {
  completionToken: string;
  newPassword: string;
}): Promise<PasswordResetCompleteResponse> {
  const raw = await publicPostJson("/api/auth/password-reset/complete", input);
  return parsePasswordResetCompletePayload(raw, parseCtx());
}

export async function apiGetMe(): Promise<MeResponse> {
  const raw = await authGetJson("/api/auth/me");
  return parseMePayload(raw, parseCtx());
}

export async function apiUpdateProfile(payload: {
  displayName: string;
  username: string;
  /** Необязательно; до 150 символов на сервере. */
  status?: string;
  /** `yyyy-MM-dd` или пустая строка, чтобы сбросить. */
  birthDate?: string | null;
}): Promise<MeResponse> {
  const body: Record<string, unknown> = {
    displayName: payload.displayName,
    username: payload.username,
  };
  if (payload.status !== undefined) body.status = payload.status;
  if (payload.birthDate !== undefined) body.birthDate = payload.birthDate;
  await authPatchJson("/api/auth/profile", body);
  return apiGetMe();
}

export async function apiGetPrivacySettings(): Promise<SettingsPrivacyDraft> {
  const raw = await authGetJson("/api/auth/me/privacy");
  return privacyDraftFromApi(raw);
}

export async function apiUpdatePrivacySettings(
  payload: SettingsPrivacyDraft,
): Promise<SettingsPrivacyDraft> {
  const raw = await authPatchJson(
    "/api/auth/me/privacy",
    privacyDraftToApiPayload(payload) as unknown as Record<string, unknown>,
  );
  return privacyDraftFromApi(raw);
}

export async function apiLogout(): Promise<void> {
  supersedeSessionRefresh();
  await authPostJson("/api/auth/logout", {});
}

export async function apiUploadAvatar(form: FormData): Promise<string> {
  const raw = await authPostForm("/api/auth/profile/avatar", form);
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fb = getApiClientConfig().onPascalFallback;
  const avatarUuid =
    (typeof o.avatarUuid === "string" && o.avatarUuid) ||
    (typeof o.AvatarUuid === "string" && o.AvatarUuid) ||
    (fb && typeof o.avatar_uuid === "string" ? o.avatar_uuid : "");
  if (!avatarUuid) throw new Error("Некорректный ответ загрузки аватара.");
  return avatarUuid;
}

export async function apiDeleteAvatar(): Promise<void> {
  await authDelete("/api/auth/profile/avatar");
}

export type SessionDto = {
  sessionId: string;
  createdAt: string;
  lastActivity: string;
  ipAddress: string;
  city?: string;
  countryCode?: string;
  isCurrent: boolean;
};

export type SecurityStatusDto = {
  twoFactorEnabled: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
};

export type EmailChangeBeginResult = {
  changeToken: string;
  expiresAt: string;
  devVerificationCode?: string;
};

export type TwoFactorSetupResult = {
  secret: string;
  otpAuthUri: string;
};

function parseSessionDto(raw: unknown): SessionDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = readStr(o, ["sessionId", "SessionId"]);
  if (!sessionId) return null;
  const city = readStr(o, ["city", "City"]);
  const countryCode = readStr(o, ["countryCode", "CountryCode"]);
  return {
    sessionId,
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    lastActivity: readStr(o, ["lastActivity", "LastActivity"]),
    ipAddress: readStr(o, ["ipAddress", "IpAddress"]),
    ...(city ? { city } : {}),
    ...(countryCode ? { countryCode } : {}),
    isCurrent: readBool(o, ["isCurrent", "IsCurrent"]),
  };
}

export async function apiChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  await authPatchJson("/api/auth/me/password", { currentPassword, newPassword });
}

export async function apiGetSessions(): Promise<SessionDto[]> {
  const raw = await authGetJson("/api/auth/me/sessions");
  if (!Array.isArray(raw)) return [];
  const out: SessionDto[] = [];
  for (const item of raw) {
    const row = parseSessionDto(item);
    if (row) out.push(row);
  }
  return out;
}

export async function apiRevokeOtherSessions(): Promise<void> {
  await authDelete("/api/auth/me/sessions/others");
}

export async function apiDeleteAccount(password: string): Promise<void> {
  await authPostJson("/api/auth/delete-account", { password });
}

export async function apiGetSecurityStatus(): Promise<SecurityStatusDto> {
  const raw = await authGetJson("/api/auth/me/security");
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    twoFactorEnabled: readBool(o, ["twoFactorEnabled", "TwoFactorEnabled"]),
    emailVerified: readBool(o, ["emailVerified", "EmailVerified"]),
    phoneVerified: readBool(o, ["phoneVerified", "PhoneVerified"]),
  };
}

export async function apiBeginEmailChange(
  password: string,
  newEmail: string,
): Promise<EmailChangeBeginResult> {
  const raw = (await authPostJson("/api/auth/me/email/change", {
    password,
    newEmail,
  })) as Record<string, unknown>;
  const devCode = readStr(raw, ["devVerificationCode", "DevVerificationCode"]);
  return {
    changeToken: readStr(raw, ["changeToken", "ChangeToken"]),
    expiresAt: readStr(raw, ["expiresAt", "ExpiresAt", "expiresAtUtc", "ExpiresAtUtc"]),
    ...(devCode ? { devVerificationCode: devCode } : {}),
  };
}

export async function apiConfirmEmailChange(changeToken: string, code: string): Promise<string> {
  const raw = (await authPostJson("/api/auth/me/email/confirm", {
    changeToken,
    code,
  })) as Record<string, unknown>;
  return readStr(raw, ["email", "Email"]);
}

export async function apiChangePhone(password: string, phone: string): Promise<void> {
  await authPatchJson("/api/auth/me/phone", { password, phone });
}

export async function apiBeginTwoFactorSetup(password: string): Promise<TwoFactorSetupResult> {
  const raw = (await authPostJson("/api/auth/me/2fa/setup", { password })) as Record<string, unknown>;
  return {
    secret: readStr(raw, ["secret", "Secret"]),
    otpAuthUri: readStr(raw, ["otpAuthUri", "OtpAuthUri"]),
  };
}

export async function apiEnableTwoFactor(code: string): Promise<void> {
  await authPostJson("/api/auth/me/2fa/enable", { code });
}

export async function apiDisableTwoFactor(password: string, code: string): Promise<void> {
  await authDeleteJson("/api/auth/me/2fa", { password, code });
}

export async function saveLoginResponse(
  session: { saveSession: (t: SessionTokens) => Promise<void> },
  raw: LoginResponse,
): Promise<void> {
  supersedeSessionRefresh();
  await session.saveSession({
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: raw.expiresAt,
  });
}
