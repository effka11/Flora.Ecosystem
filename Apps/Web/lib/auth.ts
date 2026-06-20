import { clearFscpLegacyFlatKeys } from "@/lib/fscp/keys";

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

const PENDING_PROFILE_SETUP_KEY = "flora_pending_profile_setup";

/** Пока флаг выставлен, защищённые страницы отправляют на /login до заполнения имени. */
export function setPendingProfileSetup(): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(PENDING_PROFILE_SETUP_KEY, "1");
}

export function clearPendingProfileSetup(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(PENDING_PROFILE_SETUP_KEY);
}

export function hasPendingProfileSetup(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(PENDING_PROFILE_SETUP_KEY) === "1";
}

/**
 * Публичный базовый URL для `/api/auth/*` и соц. эндпоинтов из браузера.
 * 1) `NEXT_PUBLIC_API_BASE_URL` при сборке (если задан явно).
 * 2) Иначе same-origin `/api/*` на текущем хосте (Next proxy → Flora.API). Так CSP `connect-src 'self'`
 *    не ломает auth за CDN, и не нужен cross-origin на `origin.<apex>`.
 */
export function resolvePublicApiRoot(): string {
  const env = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (env) return env;
  return "";
}

/** Полный URL для клиентского fetch (например keepalive при закрытии вкладки). */
export function authPublicFetchUrl(path: string): string {
  const root = resolvePublicApiRoot();
  const p = path.startsWith("/") ? path : `/${path}`;
  return root ? `${root.replace(/\/+$/, "")}${p}` : p;
}

/** When set (e.g. http://localhost:5158), browsers call Flora.API cross-origin — API must configure FloraWeb:CorsOrigins. */
function authApiRoot(): string {
  return resolvePublicApiRoot();
}

function authEndpoint(path: string): string {
  const root = authApiRoot();
  return root ? `${root}${path}` : path;
}

const STORAGE_ACCESS = "flora_access_token";
const STORAGE_REFRESH = "flora_refresh_token";
const STORAGE_EXPIRES = "flora_expires_at";
// Hard guard: the offline "login without auth" bypass is only ever active in non-production builds,
// even if a production build is accidentally created with NEXT_PUBLIC_DEV_AUTO_AUTH=1. NODE_ENV is
// "production" under `next build`/`next start`, so this branch is compiled out and tree-shaken there.
const DEV_AUTO_AUTH =
  process.env.NEXT_PUBLIC_DEV_AUTO_AUTH === "1" && process.env.NODE_ENV !== "production";

export function saveSession(raw: unknown): void {
  const res = parseLoginPayload(raw);
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_ACCESS, res.accessToken);
  localStorage.setItem(STORAGE_REFRESH, res.refreshToken);
  localStorage.setItem(STORAGE_EXPIRES, res.expiresAt);
}

export function clearSession() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_ACCESS);
  localStorage.removeItem(STORAGE_REFRESH);
  localStorage.removeItem(STORAGE_EXPIRES);
  clearPendingProfileSetup();
  clearFscpLegacyFlatKeys();
  /**
   * Профили FSCP по пользователю (`flora.fscp.profile.v1.*`) **не** удаляем: после повторного входа
   * тот же браузер восстанавливает ключи и может расшифровать историю (см. docs/fscp/FSCP.md — device-held material).
   * Полный сброс ключей на этом устройстве — явный вызов {@link clearFscpMaterialForUser} / {@link clearFscpLocalStorage}.
   */
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(STORAGE_ACCESS);
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

let refreshSessionInFlight: Promise<boolean> | null = null;

/**
 * Выдаёт новую пару токенов по refresh (POST /api/auth/refresh).
 * После смены Jwt:Secret на сервере старый access невалиден, но сессия в БД жива — без этого пользователю приходилось бы входить заново.
 */
export async function refreshSessionIfPossible(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (refreshSessionInFlight) return refreshSessionInFlight;

  const refreshToken = localStorage.getItem(STORAGE_REFRESH);
  if (!refreshToken) return false;

  const attempt = (async (): Promise<boolean> => {
    try {
      const r = await fetch(authEndpoint("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      const raw = await r.json().catch(() => ({}));
      if (!r.ok) {
        clearSession();
        return false;
      }
      try {
        saveSession(raw);
      } catch {
        clearSession();
        return false;
      }
      return true;
    } catch {
      clearSession();
      return false;
    }
  })();

  refreshSessionInFlight = attempt.finally(() => {
    refreshSessionInFlight = null;
  });
  return refreshSessionInFlight;
}

async function postAuthJson<T>(url: string, payload: Record<string, unknown>, defaultError: string): Promise<T> {
  const r = await fetch(url, {
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
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const authHeader = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, { method: "GET", headers: authHeader(accessToken) });
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, { method: "GET", headers: authHeader(accessToken) });
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSession();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

async function postAuthorizedForm<T>(url: string, formData: FormData, defaultError: string): Promise<T> {
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
    body: formData,
  });

  let r = await fetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSession();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
  return data;
}

async function deleteAuthorizedJson(url: string, defaultError: string): Promise<void> {
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });

  let r = await fetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, buildInit(accessToken));
    }
  }
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as ApiError;
    if (r.status === 401) clearSession();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
}

async function patchAuthorizedJson<T>(url: string, payload: Record<string, unknown>, defaultError: string): Promise<T> {
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

  let r = await fetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSession();
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
  return parseLoginPayload(raw);
}

export async function apiRegister(email: string, password: string): Promise<RegisterInitResponse> {
  return postAuthJson<RegisterInitResponse>(
    authEndpoint("/api/auth/register"),
    { email, password },
    "Ошибка регистрации"
  );
}

export async function apiVerifyRegistration(verificationToken: string, code: string): Promise<LoginResponse> {
  const raw = await postAuthJson<unknown>(
    authEndpoint("/api/auth/verify-registration"),
    { verificationToken, code },
    "Ошибка верификации"
  );
  return parseLoginPayload(raw);
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
  return authEndpoint(`/api/auth/avatar/${encodeURIComponent(id)}`);
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

  let r = await fetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSession();
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

  let r = await fetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, buildInit(accessToken));
    }
  }
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as ApiError;
    if (r.status === 401) clearSession();
    const msg = typeof data.error === "string" ? data.error : defaultError;
    throw new ApiRequestError(r.status, msg);
  }
}

async function postAuthorizedJson<T>(url: string, defaultError: string): Promise<T> {
  let accessToken = getAccessToken();
  if (!accessToken) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

  const buildInit = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
  });

  let r = await fetch(url, buildInit(accessToken));
  if (r.status === 401) {
    const renewed = await refreshSessionIfPossible();
    if (renewed) {
      accessToken = getAccessToken();
      if (accessToken) r = await fetch(url, buildInit(accessToken));
    }
  }
  const data = (await r.json().catch(() => ({}))) as T & ApiError;
  if (!r.ok) {
    if (r.status === 401) clearSession();
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
  if (isDevLocalOfflineSession()) return;
  await postAuthorizedJsonWithBody<Record<string, never>>(
    authEndpoint("/api/auth/delete-account"),
    { password },
    "Не удалось удалить аккаунт",
  );
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

  const token = getAccessToken();
  if (token) {
    try {
      await fetch(authEndpoint("/api/auth/logout"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Сеть недоступна — локальную сессию всё равно сбрасываем.
    }
  }

  clearSession();
}
