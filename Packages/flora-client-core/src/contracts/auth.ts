import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type LoginResponse = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType?: string;
  requiresProfileCompletion?: boolean;
};

/** Server accepted the password but a TOTP (2FA) code is still required. No tokens yet. */
export type TwoFactorChallenge = {
  requiresTwoFactor: true;
  /** Present when retrying with a wrong code. */
  error?: string;
};

export type LoginResult = LoginResponse | TwoFactorChallenge;

export function isTwoFactorChallenge(result: LoginResult): result is TwoFactorChallenge {
  return (result as TwoFactorChallenge).requiresTwoFactor === true;
}

export function parseTwoFactorChallenge(raw: unknown): TwoFactorChallenge | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (o.requiresTwoFactor === true || o.RequiresTwoFactor === true) {
    const error = readStr(o, ["error", "Error", "errorMessage", "ErrorMessage"]);
    return { requiresTwoFactor: true, ...(error ? { error } : {}) };
  }
  return null;
}

export type RegisterInitResponse = {
  verificationToken: string;
  expiresAt: string;
  devVerificationCode?: string;
};

export type MeResponse = {
  userUuid: string;
  username: string;
  displayName: string;
  email?: string;
  phone?: string;
  status?: string;
  birthDate?: string;
  avatarUuid?: string;
  followersCount?: number;
  followingCount?: number;
};

export function parseLoginPayload(raw: unknown, ctx?: ParseContext): LoginResponse {
  const o = asRecord(raw);
  if (!o) throw new Error("Некорректный ответ сервера при входе.");
  const fb = ctx?.onPascalFallback;
  const accessToken = readStr(o, ["accessToken", "AccessToken"], fb);
  const refreshToken = readStr(o, ["refreshToken", "RefreshToken"], fb);
  let expiresAt = readStr(o, ["expiresAt", "ExpiresAt"], fb);
  if (!expiresAt) {
    const exp = o.expiresAtUtc ?? o.ExpiresAtUtc;
    if (typeof exp === "string") expiresAt = exp;
  }
  if (!accessToken || !refreshToken || !expiresAt) {
    throw new Error("Некорректный ответ сервера при входе (нет токенов).");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    tokenType: readStr(o, ["tokenType", "TokenType"], fb) || undefined,
    requiresProfileCompletion: readBool(o, ["requiresProfileCompletion", "RequiresProfileCompletion"], fb),
  };
}

export function parseRegisterInitPayload(raw: unknown, ctx?: ParseContext): RegisterInitResponse {
  const o = asRecord(raw);
  if (!o) throw new Error("Некорректный ответ регистрации.");
  const fb = ctx?.onPascalFallback;
  const verificationToken = readStr(o, ["verificationToken", "VerificationToken"], fb);
  const expiresAt = readStr(o, ["expiresAt", "ExpiresAt"], fb);
  if (!verificationToken || !expiresAt) throw new Error("Некорректный ответ регистрации.");
  const devVerificationCode = readStr(o, ["devVerificationCode", "DevVerificationCode"], fb);
  return {
    verificationToken,
    expiresAt,
    ...(devVerificationCode ? { devVerificationCode } : {}),
  };
}

export function parseMePayload(raw: unknown, ctx?: ParseContext): MeResponse {
  const o = asRecord(raw);
  if (!o) throw new Error("Некорректный ответ профиля.");
  const fb = ctx?.onPascalFallback;
  const email = readStr(o, ["email", "Email"], fb);
  const phone = readStr(o, ["phone", "Phone"], fb);
  const status = readStr(o, ["status", "Status"], fb);
  const birthDate = readStr(o, ["birthDate", "BirthDate", "birth_date"], fb);
  const avatarUuid = readStr(o, ["avatarUuid", "AvatarUuid", "avatar_uuid"], fb);
  const followersCount = readNum(o, ["followersCount", "FollowersCount"], fb);
  const followingCount = readNum(o, ["followingCount", "FollowingCount"], fb);
  return {
    userUuid: readStr(o, ["userUuid", "UserUuid", "user_uuid"], fb),
    username: readStr(o, ["username", "Username"], fb),
    displayName: readStr(o, ["displayName", "DisplayName", "display_name"], fb),
    ...(status ? { status } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(avatarUuid ? { avatarUuid } : {}),
    ...(followersCount !== undefined ? { followersCount } : {}),
    ...(followingCount !== undefined ? { followingCount } : {}),
  };
}
