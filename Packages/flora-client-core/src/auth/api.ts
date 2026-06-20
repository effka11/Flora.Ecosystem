import {
  authDelete,
  authGetJson,
  authPatchJson,
  authPostForm,
  authPostJson,
  getApiClientConfig,
  publicPostJson,
} from "../api/client.js";
import {
  parseLoginPayload,
  parseMePayload,
  parseRegisterInitPayload,
  parseTwoFactorChallenge,
  type LoginResponse,
  type LoginResult,
  type MeResponse,
  type RegisterInitResponse,
} from "../contracts/auth.js";
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

export async function apiGetMe(): Promise<MeResponse> {
  const raw = await authGetJson("/api/auth/me");
  return parseMePayload(raw, parseCtx());
}

export async function apiUpdateProfile(payload: {
  displayName: string;
  username: string;
  status?: string;
}): Promise<MeResponse> {
  await authPatchJson("/api/auth/profile", payload);
  return apiGetMe();
}

export async function apiLogout(): Promise<void> {
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

export async function saveLoginResponse(
  session: { saveSession: (t: SessionTokens) => Promise<void> },
  raw: LoginResponse,
): Promise<void> {
  await session.saveSession({
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: raw.expiresAt,
  });
}
