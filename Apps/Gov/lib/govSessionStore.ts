import type {
  RefreshCapability,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTokens,
} from "@flora/client-core/auth";

/**
 * Session storage adapter for Apps/Gov.
 *
 * Gov is a separate origin from Flora Social and owns a separate canonical key.
 * Social's `flora_session_v1` is never read and never written from here.
 *
 * The refresh token stays out of browser-readable storage: `lib/floraApiProxy.ts`
 * moves it into an HttpOnly cookie and leaves the literal marker `"http-only"` in
 * the JSON body. The marker maps to the `{ kind: "cookie" }` refresh capability,
 * which `@flora/client-core` sends as a credentialed refresh request.
 */
export const GOV_SESSION_STORAGE_KEY = "flora_gov_session_v1";

/** Marker written by the Gov API proxy in place of the refresh token. */
export const GOV_REFRESH_COOKIE_MARKER = "http-only";

/** Web Lock that serialises refresh rotation across Gov tabs of this origin. */
export const GOV_AUTH_LOCK_NAME = "flora-gov-auth-refresh";

const GOV_PENDING_PROFILE_SETUP_KEY = "flora_gov_pending_profile_setup";
const SESSION_RECORD_VERSION = 1;
const DEFAULT_LOCK_WAIT_MS = 16_000;

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StorageEventTargetLike = {
  addEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
};

type GovActiveRecord = {
  version: typeof SESSION_RECORD_VERSION;
  kind: "active";
  revision: number;
  session: SessionRecord;
};

type GovEmptyRecord = {
  version: typeof SESSION_RECORD_VERSION;
  kind: "empty";
  revision: number;
};

type GovStoredRecord = GovActiveRecord | GovEmptyRecord;

export type GovSessionStoreOptions = {
  getLocalStorage: () => StorageLike | null;
  getSessionStorage?: () => StorageLike | null;
  getEventTarget?: () => StorageEventTargetLike | null;
};

export type GovSessionStore = SessionStore &
  Required<
    Pick<SessionStore, "readSession" | "compareAndSetSession" | "compareAndClearSession">
  > & {
    getAccessTokenSync(): string | null;
    getRefreshTokenSync(): string | null;
    getExpiresAtSync(): string | null;
    saveSessionSync(tokens: SessionTokens): void;
    clearSessionSync(): void;
    /** Notifies on same-tab mutations and on `storage` events from other Gov tabs. */
    subscribeSessionChanged(handler: () => void): () => void;
  };

function emptyRecord(revision: number): GovEmptyRecord {
  return { version: SESSION_RECORD_VERSION, kind: "empty", revision };
}

function copySession(session: SessionRecord): SessionRecord {
  return {
    accessToken: session.accessToken,
    refresh: session.refresh?.kind === "cookie" ? { kind: "cookie" } : null,
    expiresAt: session.expiresAt,
  };
}

/**
 * Only the cookie capability may reach Gov storage. A bearer refresh token here
 * means the proxy did not transform the response, so persisting it would put the
 * refresh credential into browser-readable storage.
 */
function assertCookieRefresh(refresh: RefreshCapability | null): RefreshCapability | null {
  if (refresh === null || refresh.kind === "cookie") return refresh;
  throw new Error(
    "The Gov session refuses a browser-readable refresh token; the API proxy must replace it with the http-only marker.",
  );
}

function refreshFromStoredToken(refreshToken: string): RefreshCapability {
  if (refreshToken === GOV_REFRESH_COOKIE_MARKER) return { kind: "cookie" };
  throw new Error(
    "The Gov session refuses a browser-readable refresh token; the API proxy must replace it with the http-only marker.",
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseSession(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isNullableString(row.accessToken) || !isNullableString(row.expiresAt)) return null;

  let refresh: RefreshCapability | null;
  if (row.refresh === null) {
    refresh = null;
  } else if (row.refresh && typeof row.refresh === "object" && !Array.isArray(row.refresh)) {
    const candidate = row.refresh as Record<string, unknown>;
    if (candidate.kind !== "cookie") return null;
    refresh = { kind: "cookie" };
  } else {
    return null;
  }

  return { accessToken: row.accessToken, refresh, expiresAt: row.expiresAt };
}

function parseStoredRecord(raw: string): GovStoredRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;
  if (row.version !== SESSION_RECORD_VERSION) return null;
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) return null;
  const revision = row.revision as number;

  if (row.kind === "empty") return emptyRecord(revision);
  if (row.kind !== "active") return null;
  const session = parseSession(row.session);
  if (!session?.refresh) return null;
  return { version: SESSION_RECORD_VERSION, kind: "active", revision, session };
}

/** Best-effort revision of an unreadable record so compare-and-set keeps moving forward. */
function looseRevision(raw: string): number {
  try {
    const value = JSON.parse(raw) as { revision?: unknown };
    return Number.isSafeInteger(value?.revision) && (value.revision as number) >= 0
      ? (value.revision as number)
      : 0;
  } catch {
    return 0;
  }
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("The Gov session revision cannot be advanced.");
  }
  return revision + 1;
}

function sessionFromTokens(tokens: SessionTokens): SessionRecord {
  return {
    accessToken: tokens.accessToken || null,
    refresh: refreshFromStoredToken(tokens.refreshToken),
    expiresAt: tokens.expiresAt || null,
  };
}

export function createGovSessionStore(options: GovSessionStoreOptions): GovSessionStore {
  const getSessionStorage = options.getSessionStorage ?? (() => null);
  const getEventTarget = options.getEventTarget ?? (() => null);

  const changedHandlers = new Set<() => void>();
  let listenerTarget: StorageEventTargetLike | null = null;

  const notifyChanged = (): void => {
    for (const handler of changedHandlers) handler();
  };

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== GOV_SESSION_STORAGE_KEY && event.key !== null) return;
    notifyChanged();
  };

  const ensureListener = (): void => {
    const target = getEventTarget();
    if (!target || target === listenerTarget) return;
    listenerTarget?.removeEventListener("storage", onStorage);
    target.addEventListener("storage", onStorage);
    listenerTarget = target;
  };

  const readRecord = (): GovStoredRecord | null => {
    ensureListener();
    const storage = options.getLocalStorage();
    if (!storage) return null;
    const raw = storage.getItem(GOV_SESSION_STORAGE_KEY);
    if (raw === null) return emptyRecord(0);
    // A record we cannot read is not proof of a session: fail closed to signed out.
    return parseStoredRecord(raw) ?? emptyRecord(looseRevision(raw));
  };

  const writeRecord = (storage: StorageLike, record: GovStoredRecord): void => {
    storage.setItem(GOV_SESSION_STORAGE_KEY, JSON.stringify(record));
  };

  const readEffective = (): SessionRecord | null => {
    const record = readRecord();
    if (!record || record.kind === "empty") return null;
    return copySession(record.session);
  };

  const saveSessionSync = (tokens: SessionTokens): void => {
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
      throw new Error("Cannot persist an incomplete Gov session.");
    }
    const session = sessionFromTokens(tokens);
    const storage = options.getLocalStorage();
    if (!storage) {
      throw new Error("Apps/Gov needs localStorage to keep the civic session.");
    }
    const current = readRecord() ?? emptyRecord(0);
    writeRecord(storage, {
      version: SESSION_RECORD_VERSION,
      kind: "active",
      revision: nextRevision(current.revision),
      session,
    });
    notifyChanged();
  };

  const clearSessionSync = (): void => {
    const storage = options.getLocalStorage();
    // Logout is best effort: without storage there is nothing left to tombstone.
    if (!storage) return;
    const current = readRecord() ?? emptyRecord(0);
    writeRecord(storage, emptyRecord(nextRevision(current.revision)));
    getSessionStorage()?.removeItem(GOV_PENDING_PROFILE_SETUP_KEY);
    notifyChanged();
  };

  const store: GovSessionStore = {
    getAccessTokenSync() {
      return readEffective()?.accessToken ?? null;
    },
    getRefreshTokenSync() {
      const refresh = readEffective()?.refresh;
      return refresh?.kind === "cookie" ? GOV_REFRESH_COOKIE_MARKER : null;
    },
    getExpiresAtSync() {
      return readEffective()?.expiresAt ?? null;
    },
    saveSessionSync,
    clearSessionSync,
    async getAccessToken() {
      return store.getAccessTokenSync();
    },
    async getRefreshToken() {
      return store.getRefreshTokenSync();
    },
    async getExpiresAt() {
      return store.getExpiresAtSync();
    },
    async saveSession(tokens) {
      saveSessionSync(tokens);
    },
    /** `clearKeys` covers device key material on mobile; Gov keeps none. */
    async clearSession() {
      clearSessionSync();
    },
    /**
     * Registration and profile setup live in Flora Social, so Gov never raises the
     * flag itself; it only reports what this tab was told.
     */
    async hasPendingProfileSetup() {
      return getSessionStorage()?.getItem(GOV_PENDING_PROFILE_SETUP_KEY) === "1";
    },
    async setPendingProfileSetup(value) {
      const storage = getSessionStorage();
      if (!storage) return;
      if (value) storage.setItem(GOV_PENDING_PROFILE_SETUP_KEY, "1");
      else storage.removeItem(GOV_PENDING_PROFILE_SETUP_KEY);
    },
    async readSession(): Promise<SessionSnapshot> {
      const record = readRecord();
      if (!record) return { revision: 0, session: null };
      return {
        revision: record.revision,
        session: record.kind === "active" ? copySession(record.session) : null,
      };
    },
    async compareAndSetSession(expectedRevision, next) {
      const storage = options.getLocalStorage();
      if (!storage) return false;
      const current = readRecord();
      if (!current || current.revision !== expectedRevision) return false;
      const refresh = assertCookieRefresh(next.refresh);
      if (!refresh) throw new Error("Cannot persist a Gov session without refresh.");
      writeRecord(storage, {
        version: SESSION_RECORD_VERSION,
        kind: "active",
        revision: nextRevision(current.revision),
        session: { accessToken: next.accessToken, refresh, expiresAt: next.expiresAt },
      });
      notifyChanged();
      return true;
    },
    async compareAndClearSession(expectedRevision) {
      const storage = options.getLocalStorage();
      if (!storage) return false;
      const current = readRecord();
      if (!current || current.revision !== expectedRevision) return false;
      writeRecord(storage, emptyRecord(nextRevision(current.revision)));
      getSessionStorage()?.removeItem(GOV_PENDING_PROFILE_SETUP_KEY);
      notifyChanged();
      return true;
    },
    subscribeSessionChanged(handler) {
      ensureListener();
      changedHandlers.add(handler);
      return () => {
        changedHandlers.delete(handler);
      };
    },
  };

  return store;
}

export type GovLockManagerLike = {
  request<T>(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
};

function resolveBrowserLockManager(): GovLockManagerLike | null {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return null;
  return navigator.locks as unknown as GovLockManagerLike;
}

/**
 * Refresh tokens rotate, so two Gov tabs refreshing at once would revoke each
 * other. Serialise refresh through a Web Lock of this origin.
 */
export function createGovAuthExclusive(options?: {
  getLockManager?: () => GovLockManagerLike | null;
  waitMs?: number;
}): <T>(operation: () => Promise<T>) => Promise<T> {
  const getLockManager = options?.getLockManager ?? resolveBrowserLockManager;
  const waitMs = options?.waitMs ?? DEFAULT_LOCK_WAIT_MS;

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const locks = getLockManager();
    if (!locks) return operation();

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), waitMs);
    try {
      return await locks.request(GOV_AUTH_LOCK_NAME, { signal: abort.signal }, async () => {
        clearTimeout(timer);
        return operation();
      });
    } catch (error) {
      clearTimeout(timer);
      // Never refresh unlocked: parallel tabs would dual-rotate and revoke the session.
      throw error instanceof Error
        ? error
        : new Error("Failed to acquire the Flora Gov auth Web Lock.");
    }
  };
}

export const runGovAuthExclusive = createGovAuthExclusive();

function browserLocalStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export const govSessionStore = createGovSessionStore({
  getLocalStorage: browserLocalStorage,
  getSessionStorage: browserSessionStorage,
  getEventTarget: () =>
    typeof window === "undefined" ? null : (window as unknown as StorageEventTargetLike),
});
