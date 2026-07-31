import { clearFscpLegacyFlatKeys } from "@/lib/fscp/keys";
import {
  authPublicFetchUrl,
  clearBrowserSessionCookie,
  ensureFreshAccessToken as ensureCoordinatedAccessToken,
  publicApiUrl,
  refreshSessionIfPossible as refreshCoordinatedSessionIfPossible,
  resolvePublicApiRoot,
  runWebAuthExclusive,
  supersedeWebSessionRefresh,
  syncStoredSessionTokens as syncCoordinatedSessionTokens,
  webApiFetch,
} from "@/lib/apiClient";
import {
  SESSION_CLEARED_EVENT,
  STORAGE_ACCESS,
  STORAGE_EXPIRES,
  STORAGE_REFRESH,
  STORAGE_SESSION,
  webSessionStore,
} from "@/lib/sessionStore";
import { sharedPresenceStore } from "@flora/client-core/presence";

export {
  authPublicFetchUrl,
  resolvePublicApiRoot,
  SESSION_CLEARED_EVENT,
  STORAGE_ACCESS,
  STORAGE_EXPIRES,
  STORAGE_REFRESH,
  STORAGE_SESSION,
};

export type LoginResponse = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType?: string;
  /** С сервера: пустое имя в user_profiles — надёжнее, чем только GET /me. */
  requiresProfileCompletion?: boolean;
};

/** Сервер принял пароль, но требует код TOTP (2FA). Токены ещё не выданы. */
export type TwoFactorChallenge = {
  requiresTwoFactor: true;
  /** Заполняется при повторной попытке с неверным кодом. */
  error?: string;
};

export type LoginResult = LoginResponse | TwoFactorChallenge;

export function isTwoFactorChallenge(result: LoginResult): result is TwoFactorChallenge {
  return (result as TwoFactorChallenge).requiresTwoFactor === true;
}

export type RegisterInitResponse = {
  verificationToken: string;
  expiresAt: string;
  /** Только ASPNETCORE_ENVIRONMENT=Development — код не отправляется по SMTP. */
  devVerificationCode?: string;
};

export type UpdateProfilePayload = {
  displayName: string;
  username: string;
  /** Необязательно; до 150 символов на сервере. */
  status?: string;
  /** `yyyy-MM-dd` или пустая строка, чтобы сбросить. */
  birthDate?: string | null;
};

/** Ответ GET /api/auth/me (поля, которые использует веб; остальное может приходить с API). */
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

type ApiError = { error?: string };

export class ApiRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function readBool(obj: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return false;
}

/** ASP.NET по умолчанию отдаёт camelCase, но при иной конфигурации возможны PascalCase — нормализуем. */
function parseLoginPayload(raw: unknown): LoginResponse {
  const o = raw as Record<string, unknown>;
  const accessToken = readStr(o, ["accessToken", "AccessToken"]);
  const refreshToken = readStr(o, ["refreshToken", "RefreshToken"]);
  let expiresAt = readStr(o, ["expiresAt", "ExpiresAt"]);
  if (!expiresAt) {
    const exp = o.expiresAtUtc ?? o.ExpiresAtUtc;
    if (typeof exp === "string") expiresAt = exp;
  }
  if (!accessToken || !refreshToken || !expiresAt) {
    throw new ApiRequestError(500, "Некорректный ответ сервера при входе (нет токенов).");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt,
    tokenType: readStr(o, ["tokenType", "TokenType"]) || undefined,
    requiresProfileCompletion: readBool(o, ["requiresProfileCompletion", "RequiresProfileCompletion"]),
  };
}

function readNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function parseMePayload(raw: unknown): MeResponse {
  const o = raw as Record<string, unknown>;
  const email = readStr(o, ["email", "Email"]);
  const phone = readStr(o, ["phone", "Phone"]);
  const status = readStr(o, ["status", "Status"]);
  const birthDate = readStr(o, ["birthDate", "BirthDate", "birth_date"]);
  const avatarUuid = readStr(o, ["avatarUuid", "AvatarUuid", "avatar_uuid"]);
  const followersCount = readNum(o, ["followersCount", "FollowersCount"]);
  const followingCount = readNum(o, ["followingCount", "FollowingCount"]);
  return {
    userUuid: readStr(o, ["userUuid", "UserUuid", "user_uuid"]),
    username: readStr(o, ["username", "Username"]),
    displayName: readStr(o, ["displayName", "DisplayName", "display_name"]),
    status,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(avatarUuid ? { avatarUuid } : {}),
    ...(followersCount !== undefined ? { followersCount } : {}),
    ...(followingCount !== undefined ? { followingCount } : {}),
  };
}

/** Пока флаг выставлен, защищённые страницы отправляют на /login до заполнения имени. */
export function setPendingProfileSetup(): void {
  webSessionStore.setPendingProfileSetupSync(true);
}

export function clearPendingProfileSetup(): void {
  webSessionStore.setPendingProfileSetupSync(false);
}

export function hasPendingProfileSetup(): boolean {
  return webSessionStore.hasPendingProfileSetupSync();
}

webSessionStore.subscribeSessionCleared(() => {
  clearPendingProfileSetup();
  clearFscpLegacyFlatKeys();
  // Dynamic import on purpose: a static import from @flora/client-core/fscp would pull the whole
  // FSCP barrel (sodium, noble) into this module, which is imported almost everywhere in the app.
  void import("@flora/client-core/fscp")
    .then(({ clearProvenAccountPassword }) => clearProvenAccountPassword())
    .catch(() => {
      // Best-effort: the handoff stash also self-expires (TTL 90s, single-use).
    });
});

function authEndpoint(path: string): string {
  return publicApiUrl(path);
}

// Hard guard: the offline "login without auth" bypass is only ever active in non-production builds,
// even if a production build is accidentally created with NEXT_PUBLIC_DEV_AUTO_AUTH=1. NODE_ENV is
// "production" under `next build`/`next start`, so this branch is compiled out and tree-shaken there.
const DEV_AUTO_AUTH =
  process.env.NEXT_PUBLIC_DEV_AUTO_AUTH === "1" && process.env.NODE_ENV !== "production";

export function saveSession(raw: unknown): void {
  const res = parseLoginPayload(raw);
  supersedeWebSessionRefresh();
  webSessionStore.saveSessionSync(res);
}

export function getExpiresAt(): string | null {
  return webSessionStore.getExpiresAtSync();
}

export function getRefreshToken(): string | null {
  return webSessionStore.getRefreshTokenSync();
}

export function clearSession() {
  supersedeWebSessionRefresh();
  webSessionStore.clearSessionSync();
  clearBrowserSessionCookie();
  sharedPresenceStore.clear();
  /**
   * Профили FSCP по пользователю (`flora.fscp.profile.v1.*`) **не** удаляем: после повторного входа
   * тот же браузер восстанавливает ключи и может расшифровать историю (см. Documents/fscp/FSCP.md — device-held material).
   * Полный сброс ключей на этом устройстве — явный вызов {@link clearFscpMaterialForUser} / {@link clearFscpLocalStorage}.
   */
}

export function getAccessToken(): string | null {
  const stored = webSessionStore.getAccessTokenSync();
  if (stored) return stored;
  if (DEV_AUTO_AUTH) return "dev-token";
  return null;
}

/** Сессия «Войти без авторизации» (`dev-token`) при сборке с `NEXT_PUBLIC_DEV_AUTO_AUTH` — без Flora.API. */
export function isDevLocalOfflineSession(): boolean {
  if (typeof window === "undefined") return false;
  if (!DEV_AUTO_AUTH) return false;
  return getAccessToken() === "dev-token";
}

/** Resource 401 is never logout proof; coordinator-owned tombstones clear the UI. */
export function clearSessionOnUnauthorizedIfNeeded(): void {
  // Kept for the four legacy wrappers during the bridge release.
}

/**
 * Выдаёт новую пару токенов по refresh (POST /api/auth/refresh).
 * После смены Jwt:Secret на сервере старый access невалиден, но сессия в БД жива — без этого пользователю приходилось бы входить заново.
 * Transient errors (network / 429 / 5xx) do not clear the session.
 */
export async function refreshSessionIfPossible(): Promise<boolean> {
  if (isDevLocalOfflineSession()) return false;
  return refreshCoordinatedSessionIfPossible();
}

/** Proactive refresh when access token is near expiry (client-core skew semantics). */
export async function ensureFreshAccessToken(options?: { skewMs?: number }): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await ensureCoordinatedAccessToken(options);
}

export async function syncStoredSessionTokens(options?: { skewMs?: number }): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await syncCoordinatedSessionTokens(options);
}

async function postAuthJson<T>(url: string, payload: Record<string, unknown>, defaultError: string): Promise<T> {
  const r = await webApiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

async function getAuthorizedJson<T>(url: string, defaultError: string): Promise<T> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const authHeader = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await webApiFetch(url, { method: "GET", headers: authHeader(accessToken) });
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, { method: "GET", headers: authHeader(accessToken) });
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

async function postAuthorizedForm<T>(url: string, formData: FormData, defaultError: string): Promise<T> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
    body: formData,
  });

  let r = await webApiFetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

async function deleteAuthorizedJson(url: string, defaultError: string): Promise<void> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });

  let r = await webApiFetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, buildInit(accessToken));
    }
  }
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as ApiError;
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
}

async function patchAuthorizedJson<T>(url: string, payload: Record<string, unknown>, defaultError: string): Promise<T> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let r = await webApiFetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

export async function apiLogin(
  email: string,
  password: string,
  twoFactorCode?: string
): Promise<LoginResult> {
  return runWebAuthExclusive(async () => {
    const raw = await postAuthJson<unknown>(
      authEndpoint("/api/auth/login"),
      { email, phone: email, password, twoFactorCode: twoFactorCode || undefined },
      "Ошибка входа"
    );
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      if (o.requiresTwoFactor === true || o.RequiresTwoFactor === true) {
        const err = readStr(o, ["error", "Error", "errorMessage", "ErrorMessage"]);
        return { requiresTwoFactor: true, ...(err ? { error: err } : {}) };
      }
    }
    const result = parseLoginPayload(raw);
    saveSession(result);
    return result;
  });
}

export async function apiRegister(email: string, password: string): Promise<RegisterInitResponse> {
  return postAuthJson<RegisterInitResponse>(
    authEndpoint("/api/auth/register"),
    { email, password },
    "Ошибка регистрации"
  );
}

export async function apiVerifyRegistration(verificationToken: string, code: string): Promise<LoginResponse> {
  return runWebAuthExclusive(async () => {
    const raw = await postAuthJson<unknown>(
      authEndpoint("/api/auth/verify-registration"),
      { verificationToken, code },
      "Ошибка верификации"
    );
    const result = parseLoginPayload(raw);
    saveSession(result);
    return result;
  });
}

export async function apiCancelRegistration(verificationToken: string): Promise<void> {
  await postAuthJson<Record<string, never>>(
    authEndpoint("/api/auth/cancel-registration"),
    { verificationToken },
    "Ошибка отмены регистрации"
  );
}

export function avatarImageUrl(avatarUuid: string): string {
  const id = avatarUuid.trim();
  return authEndpoint(`/api/auth/avatar/${encodeURIComponent(id)}?fmt=fri`);
}

export async function apiUpdateProfile(payload: UpdateProfilePayload): Promise<void> {
  const body: Record<string, unknown> = {
    displayName: payload.displayName,
    username: payload.username,
  };
  if (payload.status !== undefined) body.status = payload.status;
  if (payload.birthDate !== undefined) body.birthDate = payload.birthDate;
  await patchAuthorizedJson<Record<string, never>>(authEndpoint("/api/auth/profile"), body, "Ошибка сохранения профиля");
}

export async function apiUploadAvatar(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  return postAuthorizedForm<{ avatarUuid: string }>(
    authEndpoint("/api/auth/profile/avatar"),
    form,
    "Ошибка загрузки аватара",
  ).then((r) => r.avatarUuid);
}

export async function apiDeleteAvatar(): Promise<void> {
  await deleteAuthorizedJson(authEndpoint("/api/auth/profile/avatar"), "Ошибка удаления аватара");
}

export async function apiGetMe(): Promise<MeResponse> {
  if (isDevLocalOfflineSession()) {
    const { DEV_LOCAL_ME } = await import("@/lib/devLocalDemoData");
    return DEV_LOCAL_ME;
  }
  const raw = await getAuthorizedJson<unknown>(authEndpoint("/api/auth/me"), "Не удалось загрузить профиль");
  return parseMePayload(raw);
}

export async function apiGetPrivacySettings(): Promise<import("@/app/(dashboard)/settings/settingsDraft").UserSettingsPrivacyDraft> {
  const {
    defaultPrivacyDraft,
    privacyDraftFromApi,
  } = await import("@/app/(dashboard)/settings/settingsDraft");
  if (isDevLocalOfflineSession()) {
    return defaultPrivacyDraft();
  }
  try {
    const raw = await getAuthorizedJson<unknown>(
      authEndpoint("/api/auth/me/privacy"),
      "Не удалось загрузить настройки приватности",
    );
    return privacyDraftFromApi(raw);
  } catch {
    return defaultPrivacyDraft();
  }
}

export async function apiUpdatePrivacySettings(
  draft: import("@/app/(dashboard)/settings/settingsDraft").UserSettingsPrivacyDraft,
): Promise<import("@/app/(dashboard)/settings/settingsDraft").UserSettingsPrivacyDraft> {
  const { privacyDraftFromApi, privacyDraftToApiPayload } = await import(
    "@/app/(dashboard)/settings/settingsDraft"
  );
  const raw = await patchAuthorizedJson<unknown>(
    authEndpoint("/api/auth/me/privacy"),
    privacyDraftToApiPayload(draft) as Record<string, unknown>,
    "Не удалось сохранить настройки приватности",
  );
  return privacyDraftFromApi(raw);
}

export type BlocklistEntryDto = {
  userUuid: string;
  username: string;
  displayName: string;
  blockedAtUtc: string;
};

function parseBlocklistEntry(raw: unknown): BlocklistEntryDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const userUuid = readStr(o, ["userUuid", "UserUuid"]);
  if (!userUuid) return null;
  return {
    userUuid,
    username: readStr(o, ["username", "Username"]),
    displayName: readStr(o, ["displayName", "DisplayName"]),
    blockedAtUtc: readStr(o, ["blockedAtUtc", "BlockedAtUtc"]),
  };
}

async function postAuthorizedJsonWithBody<T>(
  url: string,
  payload: Record<string, unknown>,
  defaultError: string,
): Promise<T> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let r = await webApiFetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

async function deleteAuthorizedJsonWithBody(
  url: string,
  payload: Record<string, unknown>,
  defaultError: string,
): Promise<void> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let r = await webApiFetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, buildInit(accessToken));
    }
  }
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as ApiError;
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
}

async function postAuthorizedJson<T>(url: string, defaultError: string): Promise<T> {
  await ensureFreshAccessToken();
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
  });

  let r = await webApiFetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await webApiFetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSessionOnUnauthorizedIfNeeded();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

export async function apiGetBlocklist(): Promise<BlocklistEntryDto[]> {
  if (isDevLocalOfflineSession()) return [];
  const raw = await getAuthorizedJson<unknown>(
    authEndpoint("/api/auth/me/blocks"),
    "Не удалось загрузить чёрный список",
  );
  if (!Array.isArray(raw)) return [];
  const out: BlocklistEntryDto[] = [];
  for (const item of raw) {
    const row = parseBlocklistEntry(item);
    if (row) out.push(row);
  }
  return out;
}

export async function apiBlockUser(username: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  const enc = encodeURIComponent(username.replace(/^@+/, "").trim());
  if (!enc) throw new ApiRequestError(400, "Укажите юзернейм.");
  await postAuthorizedJson<unknown>(
    authEndpoint(`/api/auth/me/blocks/${enc}`),
    "Не удалось заблокировать пользователя",
  );
}

export async function apiUnblockUser(username: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  const enc = encodeURIComponent(username.replace(/^@+/, "").trim());
  if (!enc) throw new ApiRequestError(400, "Укажите юзернейм.");
  await deleteAuthorizedJson(
    authEndpoint(`/api/auth/me/blocks/${enc}`),
    "Не удалось разблокировать пользователя",
  );
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

function parseSessionDto(raw: unknown): SessionDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = readStr(o, ["sessionId", "SessionId"]);
  if (!sessionId) return null;
  const createdAt = readStr(o, ["createdAt", "CreatedAt"]);
  const lastActivity = readStr(o, ["lastActivity", "LastActivity"]);
  const ipAddress = readStr(o, ["ipAddress", "IpAddress"]);
  const city = readStr(o, ["city", "City"]);
  const countryCode = readStr(o, ["countryCode", "CountryCode"]);
  return {
    sessionId,
    createdAt,
    lastActivity,
    ipAddress,
    ...(city ? { city } : {}),
    ...(countryCode ? { countryCode } : {}),
    isCurrent: readBool(o, ["isCurrent", "IsCurrent"]),
  };
}

export async function apiChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await patchAuthorizedJson<Record<string, never>>(
    authEndpoint("/api/auth/me/password"),
    { currentPassword, newPassword },
    "Не удалось сменить пароль",
  );
}

export async function apiGetSessions(): Promise<SessionDto[]> {
  if (isDevLocalOfflineSession()) {
    const now = new Date().toISOString();
    return [
      {
        sessionId: "dev-session",
        createdAt: now,
        lastActivity: now,
        ipAddress: "127.0.0.1",
        isCurrent: true,
      },
    ];
  }
  const raw = await getAuthorizedJson<unknown>(
    authEndpoint("/api/auth/me/sessions"),
    "Не удалось загрузить сессии",
  );
  if (!Array.isArray(raw)) return [];
  const out: SessionDto[] = [];
  for (const item of raw) {
    const row = parseSessionDto(item);
    if (row) out.push(row);
  }
  return out;
}

export async function apiRevokeOtherSessions(): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await deleteAuthorizedJson(
    authEndpoint("/api/auth/me/sessions/others"),
    "Не удалось завершить другие сессии",
  );
}

export async function apiDeleteAccount(password: string): Promise<void> {
  if (isDevLocalOfflineSession()) {
    clearSession();
    return;
  }
  await ensureFreshAccessToken();
  await runWebAuthExclusive(async () => {
    const token = getAccessToken();
    if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
    const response = await webApiFetch(authEndpoint("/api/auth/delete-account"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as ApiError;
      throw new ApiRequestError(
        response.status,
        typeof data.error === "string" ? data.error : "Не удалось удалить аккаунт",
      );
    }
    clearSession();
  });
}

export type SecurityStatusDto = {
  twoFactorEnabled: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
};

function parseSecurityStatus(raw: unknown): SecurityStatusDto {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    twoFactorEnabled: readBool(o, ["twoFactorEnabled", "TwoFactorEnabled"]),
    emailVerified: readBool(o, ["emailVerified", "EmailVerified"]),
    phoneVerified: readBool(o, ["phoneVerified", "PhoneVerified"]),
  };
}

export async function apiGetSecurityStatus(): Promise<SecurityStatusDto> {
  if (isDevLocalOfflineSession()) {
    return { twoFactorEnabled: false, emailVerified: true, phoneVerified: false };
  }
  const raw = await getAuthorizedJson<unknown>(
    authEndpoint("/api/auth/me/security"),
    "Не удалось загрузить настройки безопасности",
  );
  return parseSecurityStatus(raw);
}

export type EmailChangeBeginResult = {
  changeToken: string;
  expiresAt: string;
  devVerificationCode?: string;
};

export async function apiBeginEmailChange(password: string, newEmail: string): Promise<EmailChangeBeginResult> {
  if (isDevLocalOfflineSession()) {
    return { changeToken: "dev-change", expiresAt: new Date().toISOString(), devVerificationCode: "000000" };
  }
  const raw = await postAuthorizedJsonWithBody<Record<string, unknown>>(
    authEndpoint("/api/auth/me/email/change"),
    { password, newEmail },
    "Не удалось начать смену email",
  );
  return {
    changeToken: readStr(raw, ["changeToken", "ChangeToken"]),
    expiresAt: readStr(raw, ["expiresAt", "ExpiresAt", "expiresAtUtc", "ExpiresAtUtc"]),
    devVerificationCode: readStr(raw, ["devVerificationCode", "DevVerificationCode"]) || undefined,
  };
}

export async function apiConfirmEmailChange(changeToken: string, code: string): Promise<string> {
  if (isDevLocalOfflineSession()) return "dev@example.com";
  const raw = await postAuthorizedJsonWithBody<Record<string, unknown>>(
    authEndpoint("/api/auth/me/email/confirm"),
    { changeToken, code },
    "Не удалось подтвердить смену email",
  );
  return readStr(raw, ["email", "Email"]);
}

export async function apiChangePhone(password: string, phone: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await patchAuthorizedJson<Record<string, never>>(
    authEndpoint("/api/auth/me/phone"),
    { password, phone },
    "Не удалось сменить номер телефона",
  );
}

export type TwoFactorSetupResult = {
  secret: string;
  otpAuthUri: string;
};

export async function apiBeginTwoFactorSetup(password: string): Promise<TwoFactorSetupResult> {
  if (isDevLocalOfflineSession()) {
    return { secret: "DEVSECRETDEVSECRET", otpAuthUri: "otpauth://totp/FLORA:dev?secret=DEVSECRETDEVSECRET&issuer=FLORA" };
  }
  const raw = await postAuthorizedJsonWithBody<Record<string, unknown>>(
    authEndpoint("/api/auth/me/2fa/setup"),
    { password },
    "Не удалось начать настройку 2FA",
  );
  return {
    secret: readStr(raw, ["secret", "Secret"]),
    otpAuthUri: readStr(raw, ["otpAuthUri", "OtpAuthUri"]),
  };
}

export async function apiEnableTwoFactor(code: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await postAuthorizedJsonWithBody<Record<string, never>>(
    authEndpoint("/api/auth/me/2fa/enable"),
    { code },
    "Не удалось включить 2FA",
  );
}

export async function apiDisableTwoFactor(password: string, code: string): Promise<void> {
  if (isDevLocalOfflineSession()) return;
  await deleteAuthorizedJsonWithBody(
    authEndpoint("/api/auth/me/2fa"),
    { password, code },
    "Не удалось отключить 2FA",
  );
}

export async function apiLogout(): Promise<void> {
  if (isDevLocalOfflineSession()) {
    clearSession();
    return;
  }

  try {
    await ensureFreshAccessToken();
  } catch {
    // Revocation remains best-effort; the local tombstone is mandatory.
  }
  try {
    await runWebAuthExclusive(async () => {
      const token = getAccessToken();
      if (!token) return;
      await webApiFetch(authEndpoint("/api/auth/logout"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    });
  } catch {
    // Network/proxy failure never prevents explicit local logout.
  } finally {
    clearSession();
  }
}
