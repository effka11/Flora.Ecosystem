import type {
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTokens,
} from "@flora/client-core/auth";

export const STORAGE_ACCESS = "flora_access_token";
export const STORAGE_REFRESH = "flora_refresh_token";
export const STORAGE_EXPIRES = "flora_expires_at";
export const STORAGE_SESSION = "flora_session_v1";
export const SESSION_CLEARED_EVENT = "flora:session-cleared";
export const WEB_AUTH_LOCK_NAME = "flora-auth-refresh";

const PENDING_PROFILE_SETUP_KEY = "flora_pending_profile_setup";
const REFRESH_COOKIE_MARKER = "http-only";
const SESSION_RECORD_VERSION = 1;
const DEFAULT_LOCK_WAIT_MS = 16_000;
const LEGACY_EVENT_DEBOUNCE_MS = 40;

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type LegacyTriplet = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
};

type CanonicalActiveRecord = {
  version: typeof SESSION_RECORD_VERSION;
  kind: "active";
  revision: number;
  session: SessionRecord;
  legacyMirror: LegacyTriplet;
};

type CanonicalEmptyRecord = {
  version: typeof SESSION_RECORD_VERSION;
  kind: "empty";
  revision: number;
  legacyMirror: LegacyTriplet;
};

type CanonicalRecord = CanonicalActiveRecord | CanonicalEmptyRecord;

type StorageEventTargetLike = {
  addEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEvent) => void): void;
  dispatchEvent(event: Event): boolean;
};

export type WebLockManagerLike = {
  request<T>(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
};

type WebSessionStoreOptions = {
  getLocalStorage: () => StorageLike | null;
  getSessionStorage?: () => StorageLike | null;
  getEventTarget?: () => StorageEventTargetLike | null;
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type WebSessionStore = SessionStore &
  Required<
    Pick<
      SessionStore,
      "readSession" | "compareAndSetSession" | "compareAndClearSession"
    >
  > & {
    getAccessTokenSync(): string | null;
    getRefreshTokenSync(): string | null;
    getExpiresAtSync(): string | null;
    saveSessionSync(tokens: SessionTokens): void;
    clearSessionSync(): void;
    hasPendingProfileSetupSync(): boolean;
    setPendingProfileSetupSync(value: boolean): void;
    reconcileLegacyBridge(): Promise<void>;
    subscribeSessionCleared(handler: () => void): () => void;
  };

function emptyLegacyTriplet(): LegacyTriplet {
  return { accessToken: null, refreshToken: null, expiresAt: null };
}

function copySession(session: SessionRecord): SessionRecord {
  return {
    accessToken: session.accessToken,
    refresh:
      session.refresh?.kind === "cookie"
        ? { kind: "cookie" }
        : session.refresh?.kind === "token"
          ? { kind: "token", token: session.refresh.token }
          : null,
    expiresAt: session.expiresAt,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseLegacyTriplet(value: unknown): LegacyTriplet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !isNullableString(row.accessToken) ||
    !isNullableString(row.refreshToken) ||
    !isNullableString(row.expiresAt)
  ) {
    return null;
  }
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
  };
}

function parseSession(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isNullableString(row.accessToken) || !isNullableString(row.expiresAt)) {
    return null;
  }

  let refresh: SessionRecord["refresh"];
  if (row.refresh === null) {
    refresh = null;
  } else if (
    row.refresh &&
    typeof row.refresh === "object" &&
    !Array.isArray(row.refresh)
  ) {
    const candidate = row.refresh as Record<string, unknown>;
    if (candidate.kind === "cookie") {
      refresh = { kind: "cookie" };
    } else if (
      candidate.kind === "token" &&
      typeof candidate.token === "string" &&
      candidate.token.length > 0
    ) {
      refresh = { kind: "token", token: candidate.token };
    } else {
      return null;
    }
  } else {
    return null;
  }

  return {
    accessToken: row.accessToken,
    refresh,
    expiresAt: row.expiresAt,
  };
}

function parseCanonical(raw: string): CanonicalRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Web session record is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Web session record is invalid.");
  }

  const row = value as Record<string, unknown>;
  if (
    row.version !== SESSION_RECORD_VERSION ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0
  ) {
    throw new Error("The Web session record has an invalid version or revision.");
  }
  const legacyMirror = parseLegacyTriplet(row.legacyMirror);
  if (!legacyMirror) throw new Error("The Web session legacy mirror is invalid.");

  if (row.kind === "empty") {
    return {
      version: SESSION_RECORD_VERSION,
      kind: "empty",
      revision: row.revision as number,
      legacyMirror,
    };
  }
  if (row.kind !== "active") throw new Error("The Web session discriminator is invalid.");
  const session = parseSession(row.session);
  if (!session?.refresh) throw new Error("The active Web session has no refresh capability.");
  return {
    version: SESSION_RECORD_VERSION,
    kind: "active",
    revision: row.revision as number,
    session,
    legacyMirror,
  };
}

function sessionFromTokens(tokens: SessionTokens): SessionRecord {
  return {
    accessToken: tokens.accessToken || null,
    refresh:
      tokens.refreshToken === REFRESH_COOKIE_MARKER
        ? { kind: "cookie" }
        : { kind: "token", token: tokens.refreshToken },
    expiresAt: tokens.expiresAt || null,
  };
}

function legacyFromSession(session: SessionRecord): LegacyTriplet {
  return {
    accessToken: session.accessToken,
    refreshToken:
      session.refresh?.kind === "cookie"
        ? REFRESH_COOKIE_MARKER
        : session.refresh?.kind === "token"
          ? session.refresh.token
          : null,
    expiresAt: session.expiresAt,
  };
}

function recordsEqual(left: LegacyTriplet, right: LegacyTriplet): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt
  );
}

function completeLegacySession(legacy: LegacyTriplet): SessionRecord | null {
  if (!legacy.accessToken || !legacy.refreshToken || !legacy.expiresAt) return null;
  return sessionFromTokens({
    accessToken: legacy.accessToken,
    refreshToken: legacy.refreshToken,
    expiresAt: legacy.expiresAt,
  });
}

function isLegacyEmpty(legacy: LegacyTriplet): boolean {
  return (
    legacy.accessToken === null &&
    legacy.refreshToken === null &&
    legacy.expiresAt === null
  );
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("The Web session revision cannot be advanced.");
  }
  return revision + 1;
}

function looseRevision(raw: string | null): number {
  if (!raw) return 0;
  try {
    const value = JSON.parse(raw) as { revision?: unknown };
    return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
      ? (value.revision as number)
      : 0;
  } catch {
    return 0;
  }
}

function resolveBrowserLockManager(): WebLockManagerLike | null {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return null;
  return navigator.locks as unknown as WebLockManagerLike;
}

export function createWebAuthExclusive(options?: {
  getLockManager?: () => WebLockManagerLike | null;
  waitMs?: number;
}): <T>(operation: () => Promise<T>) => Promise<T> {
  const getLockManager = options?.getLockManager ?? resolveBrowserLockManager;
  const waitMs = options?.waitMs ?? DEFAULT_LOCK_WAIT_MS;

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const locks = getLockManager();
    if (!locks) return operation();

    let callbackStarted = false;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), waitMs);
    try {
      return await locks.request(
        WEB_AUTH_LOCK_NAME,
        { signal: abort.signal },
        async () => {
          callbackStarted = true;
          clearTimeout(timer);
          return operation();
        },
      );
    } catch (error) {
      clearTimeout(timer);
      if (callbackStarted) throw error;
      return operation();
    }
  };
}

export const runWebAuthExclusive = createWebAuthExclusive();

export function createWebSessionStore(options: WebSessionStoreOptions): WebSessionStore {
  const getSessionStorage = options.getSessionStorage ?? (() => null);
  const getEventTarget = options.getEventTarget ?? (() => null);
  const runExclusive = options.runExclusive ?? runWebAuthExclusive;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let effectiveOverlay: SessionRecord | null | undefined;
  let listenerTarget: StorageEventTargetLike | null = null;
  let legacyTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNotifiedEmptyRevision = -1;
  const clearedHandlers = new Set<() => void>();

  const readLegacy = (storage: StorageLike): LegacyTriplet => ({
    accessToken: storage.getItem(STORAGE_ACCESS),
    refreshToken: storage.getItem(STORAGE_REFRESH),
    expiresAt: storage.getItem(STORAGE_EXPIRES),
  });

  const writeCanonical = (storage: StorageLike, record: CanonicalRecord): void => {
    storage.setItem(STORAGE_SESSION, JSON.stringify(record));
  };

  const writeLegacy = (storage: StorageLike, legacy: LegacyTriplet): void => {
    if (legacy.accessToken === null) storage.removeItem(STORAGE_ACCESS);
    else storage.setItem(STORAGE_ACCESS, legacy.accessToken);
    if (legacy.refreshToken === null) storage.removeItem(STORAGE_REFRESH);
    else storage.setItem(STORAGE_REFRESH, legacy.refreshToken);
    if (legacy.expiresAt === null) storage.removeItem(STORAGE_EXPIRES);
    else storage.setItem(STORAGE_EXPIRES, legacy.expiresAt);
  };

  const notifyCleared = (revision: number): void => {
    if (revision <= lastNotifiedEmptyRevision) return;
    lastNotifiedEmptyRevision = revision;
    getSessionStorage()?.removeItem(PENDING_PROFILE_SETUP_KEY);
    for (const handler of clearedHandlers) handler();
    const target = getEventTarget();
    if (target && typeof Event !== "undefined") {
      target.dispatchEvent(new Event(SESSION_CLEARED_EVENT));
    }
  };

  const migrateLegacy = (storage: StorageLike): CanonicalRecord => {
    const legacy = readLegacy(storage);
    const session = completeLegacySession(legacy);
    if (session) {
      const record: CanonicalActiveRecord = {
        version: SESSION_RECORD_VERSION,
        kind: "active",
        revision: 1,
        session,
        legacyMirror: legacy,
      };
      // The old triplet already exists; canonical is the commit marker and is written last.
      writeCanonical(storage, record);
      return record;
    }

    const record: CanonicalEmptyRecord = {
      version: SESSION_RECORD_VERSION,
      kind: "empty",
      revision: 1,
      legacyMirror: emptyLegacyTriplet(),
    };
    // A tombstone must win before incomplete legacy material is removed.
    writeCanonical(storage, record);
    writeLegacy(storage, emptyLegacyTriplet());
    return record;
  };

  const readCanonical = (): CanonicalRecord | null => {
    const storage = options.getLocalStorage();
    if (!storage) return null;
    const raw = storage.getItem(STORAGE_SESSION);
    return raw === null ? migrateLegacy(storage) : parseCanonical(raw);
  };

  const snapshotFromCanonical = (record: CanonicalRecord | null): SessionSnapshot => {
    if (!record) return { revision: 0, session: null };
    return {
      revision: record.revision,
      session: record.kind === "active" ? copySession(record.session) : null,
    };
  };

  const updateOverlayFromCanonical = (record: CanonicalRecord): void => {
    effectiveOverlay = record.kind === "active" ? copySession(record.session) : null;
  };

  const reconcileLegacyBridge = async (): Promise<void> => {
    await runExclusive(async () => {
      const storage = options.getLocalStorage();
      if (!storage) return;
      const canonical = readCanonical();
      if (!canonical) return;
      const legacy = readLegacy(storage);
      const complete = completeLegacySession(legacy);

      if (complete) {
        if (canonical.kind === "active" && recordsEqual(canonical.legacyMirror, legacy)) {
          return;
        }
        const record: CanonicalActiveRecord = {
          version: SESSION_RECORD_VERSION,
          kind: "active",
          revision: nextRevision(canonical.revision),
          session: complete,
          legacyMirror: legacy,
        };
        effectiveOverlay = copySession(complete);
        writeCanonical(storage, record);
        return;
      }

      // Ignore partial old-tab writes. A complete removal is an old-version logout.
      if (!isLegacyEmpty(legacy) || canonical.kind === "empty") return;
      const record: CanonicalEmptyRecord = {
        version: SESSION_RECORD_VERSION,
        kind: "empty",
        revision: nextRevision(canonical.revision),
        legacyMirror: emptyLegacyTriplet(),
      };
      writeCanonical(storage, record);
      effectiveOverlay = null;
      notifyCleared(record.revision);
    });
  };

  const onStorage = (event: StorageEvent): void => {
    const storage = options.getLocalStorage();
    if (event.storageArea && storage && event.storageArea !== storage) return;
    if (event.key === STORAGE_SESSION) {
      if (typeof event.newValue !== "string") return;
      try {
        const record = parseCanonical(event.newValue);
        updateOverlayFromCanonical(record);
        if (record.kind === "empty") notifyCleared(record.revision);
      } catch {
        // Keep the last effective session; a malformed cross-tab write is not logout proof.
      }
      return;
    }
    if (
      event.key !== STORAGE_ACCESS &&
      event.key !== STORAGE_REFRESH &&
      event.key !== STORAGE_EXPIRES &&
      event.key !== null
    ) {
      return;
    }
    if (legacyTimer !== null) clearTimer(legacyTimer);
    legacyTimer = setTimer(() => {
      legacyTimer = null;
      void reconcileLegacyBridge();
    }, LEGACY_EVENT_DEBOUNCE_MS);
  };

  const ensureListener = (): void => {
    const target = getEventTarget();
    if (!target || target === listenerTarget) return;
    listenerTarget?.removeEventListener("storage", onStorage);
    target.addEventListener("storage", onStorage);
    listenerTarget = target;
  };

  const getEffective = (): SessionRecord | null => {
    ensureListener();
    if (effectiveOverlay !== undefined) return effectiveOverlay ? copySession(effectiveOverlay) : null;
    const canonical = readCanonical();
    if (!canonical || canonical.kind === "empty") return null;
    return copySession(canonical.session);
  };

  const saveSessionSync = (tokens: SessionTokens): void => {
    ensureListener();
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
      throw new Error("Cannot persist an incomplete Web session.");
    }
    const storage = options.getLocalStorage();
    if (!storage) return;
    const raw = storage.getItem(STORAGE_SESSION);
    const current = raw === null ? migrateLegacy(storage) : parseCanonical(raw);
    const session = sessionFromTokens(tokens);
    const legacyMirror = legacyFromSession(session);
    const record: CanonicalActiveRecord = {
      version: SESSION_RECORD_VERSION,
      kind: "active",
      revision: nextRevision(current.revision),
      session,
      legacyMirror,
    };

    // Existing wrappers immediately see R2 even if the canonical commit is storage-pending.
    effectiveOverlay = copySession(session);
    writeLegacy(storage, legacyMirror);
    writeCanonical(storage, record);
  };

  const clearSessionSync = (): void => {
    ensureListener();
    const storage = options.getLocalStorage();
    if (!storage) {
      effectiveOverlay = null;
      return;
    }
    const raw = storage.getItem(STORAGE_SESSION);
    if (raw !== null) {
      try {
        const current = parseCanonical(raw);
        if (current.kind === "empty") {
          effectiveOverlay = null;
          writeLegacy(storage, emptyLegacyTriplet());
          notifyCleared(current.revision);
          return;
        }
      } catch {
        // Explicit logout may replace a corrupt canonical value with a tombstone.
      }
    }
    const revision = raw === null ? 0 : looseRevision(raw);
    const record: CanonicalEmptyRecord = {
      version: SESSION_RECORD_VERSION,
      kind: "empty",
      revision: nextRevision(revision),
      legacyMirror: emptyLegacyTriplet(),
    };

    // Tombstone first prevents an interrupted logout from reviving an old refresh marker.
    writeCanonical(storage, record);
    effectiveOverlay = null;
    writeLegacy(storage, emptyLegacyTriplet());
    notifyCleared(record.revision);
  };

  const store: WebSessionStore = {
    getAccessTokenSync() {
      return getEffective()?.accessToken ?? null;
    },
    getRefreshTokenSync() {
      const refresh = getEffective()?.refresh;
      if (!refresh) return null;
      return refresh.kind === "cookie" ? REFRESH_COOKIE_MARKER : refresh.token;
    },
    getExpiresAtSync() {
      return getEffective()?.expiresAt ?? null;
    },
    saveSessionSync,
    clearSessionSync,
    hasPendingProfileSetupSync() {
      return getSessionStorage()?.getItem(PENDING_PROFILE_SETUP_KEY) === "1";
    },
    setPendingProfileSetupSync(value) {
      const storage = getSessionStorage();
      if (!storage) return;
      if (value) storage.setItem(PENDING_PROFILE_SETUP_KEY, "1");
      else storage.removeItem(PENDING_PROFILE_SETUP_KEY);
    },
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
    async clearSession() {
      clearSessionSync();
    },
    async hasPendingProfileSetup() {
      return store.hasPendingProfileSetupSync();
    },
    async setPendingProfileSetup(value) {
      store.setPendingProfileSetupSync(value);
    },
    async readSession() {
      ensureListener();
      return snapshotFromCanonical(readCanonical());
    },
    async compareAndSetSession(expectedRevision, next) {
      ensureListener();
      const storage = options.getLocalStorage();
      if (!storage) return false;
      const current = readCanonical();
      if (!current || current.revision !== expectedRevision) {
        if (current) updateOverlayFromCanonical(current);
        return false;
      }
      if (!next.refresh) throw new Error("Cannot persist a Web session without refresh.");
      const session = copySession(next);
      const legacyMirror = legacyFromSession(session);
      const record: CanonicalActiveRecord = {
        version: SESSION_RECORD_VERSION,
        kind: "active",
        revision: nextRevision(current.revision),
        session,
        legacyMirror,
      };
      effectiveOverlay = copySession(session);
      writeLegacy(storage, legacyMirror);
      writeCanonical(storage, record);
      return true;
    },
    async compareAndClearSession(expectedRevision) {
      ensureListener();
      const storage = options.getLocalStorage();
      if (!storage) return false;
      const current = readCanonical();
      if (!current || current.revision !== expectedRevision) {
        if (current) updateOverlayFromCanonical(current);
        return false;
      }
      const record: CanonicalEmptyRecord = {
        version: SESSION_RECORD_VERSION,
        kind: "empty",
        revision: nextRevision(current.revision),
        legacyMirror: emptyLegacyTriplet(),
      };
      writeCanonical(storage, record);
      effectiveOverlay = null;
      writeLegacy(storage, emptyLegacyTriplet());
      notifyCleared(record.revision);
      return true;
    },
    reconcileLegacyBridge,
    subscribeSessionCleared(handler) {
      clearedHandlers.add(handler);
      return () => clearedHandlers.delete(handler);
    },
  };

  return store;
}

export const webSessionStore = createWebSessionStore({
  getLocalStorage: () => (typeof window === "undefined" ? null : window.localStorage),
  getSessionStorage: () => (typeof window === "undefined" ? null : window.sessionStorage),
  getEventTarget: () =>
    typeof window === "undefined"
      ? null
      : (window as unknown as StorageEventTargetLike),
});
