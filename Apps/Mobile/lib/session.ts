import * as SecureStore from "expo-secure-store";
import type {
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTokens,
} from "@flora/client-core/auth";
import { stripFloraOriginSlash } from "./floraPublicOrigins";

export {
  FLORA_GOV_CDN_ORIGIN,
  FLORA_SOCIAL_CDN_ORIGIN,
  resolveGovOrigin,
} from "./floraPublicOrigins";

export const MOBILE_SESSION_KEY = "flora_mobile_session_v1";
export const MOBILE_SESSION_PENDING_KEY = "flora_mobile_session_pending_v1";
export const LEGACY_ACCESS_KEY = "flora_access_token";
export const LEGACY_REFRESH_KEY = "flora_refresh_token";
export const LEGACY_EXPIRES_KEY = "flora_expires_at";
export const LEGACY_PENDING_PROFILE_KEY = "flora_pending_profile_setup";
export const MOBILE_SESSION_MAX_UTF8_BYTES = 2_048;

const MOBILE_SESSION_VERSION = 1;

export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export type MobileActiveSessionRecord = {
  version: typeof MOBILE_SESSION_VERSION;
  kind: "active";
  revision: number;
  accessToken: string | null;
  refreshToken: string;
  expiresAt: string | null;
  pendingProfileSetup: boolean;
};

export type MobileEmptySessionRecord = {
  version: typeof MOBILE_SESSION_VERSION;
  kind: "empty";
  revision: number;
};

export type MobileSessionRecord =
  | MobileActiveSessionRecord
  | MobileEmptySessionRecord;

export type MobileSessionStore = SessionStore &
  Required<
    Pick<
      SessionStore,
      "readSession" | "compareAndSetSession" | "compareAndClearSession"
    >
  > & {
    readCanonicalRecord(): Promise<MobileSessionRecord>;
  };

export class SessionStorageUnavailableError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue: unknown) {
    super(message);
    this.name = "SessionStorageUnavailableError";
    this.causeValue = causeValue;
  }
}

export class SessionStorageCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStorageCorruptError";
  }
}

export class SessionStorageBudgetError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(
      `SecureStore session record is ${byteLength} bytes; maximum is ${MOBILE_SESSION_MAX_UTF8_BYTES}.`,
    );
    this.name = "SessionStorageBudgetError";
    this.byteLength = byteLength;
  }
}

export class SessionStorageVerificationError extends Error {
  constructor() {
    super("SecureStore did not return the exact session record that was written.");
    this.name = "SessionStorageVerificationError";
  }
}

export function resolveApiBaseUrl(): string {
  // Metro / dev-client: Rust gateway (prod strangler parity). JS still from Metro :8081.
  // USB: adb reverse tcp:5290 tcp:5290 (see Scripts/mobile-adb-reverse.ps1).
  if (__DEV__) {
    return "http://localhost:5290";
  }

  const explicit = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (explicit) return stripFloraOriginSlash(explicit);

  throw new Error("EXPO_PUBLIC_API_URL must be set for release builds.");
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SessionStorageCorruptError("SecureStore session revision is invalid.");
  }
}

function advanceRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new SessionStorageCorruptError("SecureStore session revision cannot be advanced.");
  }
  return revision + 1;
}

function parseCanonicalRecord(raw: string): MobileSessionRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionStorageCorruptError("SecureStore session is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionStorageCorruptError("SecureStore session is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (row.version !== MOBILE_SESSION_VERSION) {
    throw new SessionStorageCorruptError("SecureStore session version is unsupported.");
  }
  assertRevision(row.revision);
  if (row.kind === "empty") {
    return {
      version: MOBILE_SESSION_VERSION,
      kind: "empty",
      revision: row.revision,
    };
  }
  if (
    row.kind !== "active" ||
    (row.accessToken !== null && typeof row.accessToken !== "string") ||
    typeof row.refreshToken !== "string" ||
    row.refreshToken.length === 0 ||
    (row.expiresAt !== null && typeof row.expiresAt !== "string") ||
    typeof row.pendingProfileSetup !== "boolean"
  ) {
    throw new SessionStorageCorruptError("SecureStore active session is invalid.");
  }
  return {
    version: MOBILE_SESSION_VERSION,
    kind: "active",
    revision: row.revision,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    pendingProfileSetup: row.pendingProfileSetup,
  };
}

function sessionFromCanonical(record: MobileSessionRecord): SessionRecord | null {
  if (record.kind === "empty") return null;
  return {
    accessToken: record.accessToken,
    refresh: { kind: "token", token: record.refreshToken },
    expiresAt: record.expiresAt,
  };
}

function activeRecord(
  revision: number,
  session: SessionRecord,
  pendingProfileSetup: boolean,
): MobileActiveSessionRecord {
  if (session.refresh?.kind !== "token" || session.refresh.token.length === 0) {
    throw new Error("Mobile sessions require a token refresh capability.");
  }
  return {
    version: MOBILE_SESSION_VERSION,
    kind: "active",
    revision,
    accessToken: session.accessToken,
    refreshToken: session.refresh.token,
    expiresAt: session.expiresAt,
    pendingProfileSetup,
  };
}

function recordFromTokens(
  revision: number,
  tokens: SessionTokens,
  pendingProfileSetup: boolean,
): MobileActiveSessionRecord {
  if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
    throw new Error("Cannot persist an incomplete mobile session.");
  }
  return {
    version: MOBILE_SESSION_VERSION,
    kind: "active",
    revision,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    pendingProfileSetup,
  };
}

function snapshotFromCanonical(record: MobileSessionRecord): SessionSnapshot {
  return {
    revision: record.revision,
    session: sessionFromCanonical(record),
  };
}

export function createMobileSessionStore(
  secureStore: SecureStoreLike,
): MobileSessionStore {
  let serialized: Promise<void> = Promise.resolve();
  let effectiveOverlay: SessionRecord | null | undefined;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serialized.then(operation, operation);
    serialized = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const getItem = async (key: string): Promise<string | null> => {
    try {
      return await secureStore.getItemAsync(key);
    } catch (error) {
      throw new SessionStorageUnavailableError(
        `SecureStore could not read ${key}.`,
        error,
      );
    }
  };

  const encodeRecord = (record: MobileSessionRecord): string => {
    const encoded = JSON.stringify(record);
    const bytes = utf8ByteLength(encoded);
    if (bytes > MOBILE_SESSION_MAX_UTF8_BYTES) {
      throw new SessionStorageBudgetError(bytes);
    }
    return encoded;
  };

  const writeVerified = async (
    record: MobileSessionRecord,
    afterNativeWrite?: () => void,
  ): Promise<void> => {
    const encoded = encodeRecord(record);
    try {
      await secureStore.setItemAsync(MOBILE_SESSION_KEY, encoded);
    } catch (error) {
      throw new SessionStorageUnavailableError(
        "SecureStore could not write the session record.",
        error,
      );
    }
    afterNativeWrite?.();
    const readBack = await getItem(MOBILE_SESSION_KEY);
    if (readBack !== encoded) {
      try {
        await secureStore.setItemAsync(MOBILE_SESSION_PENDING_KEY, encoded);
      } catch {
        // Overlay remains authoritative in-process; pending is best-effort.
      }
      throw new SessionStorageVerificationError();
    }
    try {
      await secureStore.deleteItemAsync(MOBILE_SESSION_PENDING_KEY);
    } catch {
      // Canonical already verified; pending cleanup is retryable.
    }
  };

  const removeLegacyAfterCommit = async (): Promise<void> => {
    for (const key of [
      LEGACY_ACCESS_KEY,
      LEGACY_REFRESH_KEY,
      LEGACY_EXPIRES_KEY,
      LEGACY_PENDING_PROFILE_KEY,
    ]) {
      try {
        await secureStore.deleteItemAsync(key);
      } catch {
        // Canonical already won and was read back exactly; cleanup is retryable.
      }
    }
  };

  const migrateLegacy = async (): Promise<MobileSessionRecord> => {
    const [accessToken, refreshToken, expiresAt, pendingProfile] =
      await Promise.all([
        getItem(LEGACY_ACCESS_KEY),
        getItem(LEGACY_REFRESH_KEY),
        getItem(LEGACY_EXPIRES_KEY),
        getItem(LEGACY_PENDING_PROFILE_KEY),
      ]);

    const record: MobileSessionRecord = refreshToken
      ? {
          version: MOBILE_SESSION_VERSION,
          kind: "active",
          revision: 1,
          accessToken: accessToken || null,
          refreshToken,
          expiresAt: expiresAt || null,
          pendingProfileSetup: pendingProfile === "1",
        }
      : {
          version: MOBILE_SESSION_VERSION,
          kind: "empty",
          revision: 1,
        };

    await writeVerified(record);
    await removeLegacyAfterCommit();
    return record;
  };

  const adoptPending = async (
    pending: MobileActiveSessionRecord,
  ): Promise<MobileSessionRecord> => {
    try {
      await writeVerified(pending);
    } catch {
      effectiveOverlay = sessionFromCanonical(pending);
    }
    return pending;
  };

  const readPersisted = async (): Promise<MobileSessionRecord> => {
    const raw = await getItem(MOBILE_SESSION_KEY);
    const pendingRaw = await getItem(MOBILE_SESSION_PENDING_KEY).catch(
      () => null,
    );

    const parsePending = (): MobileSessionRecord | null => {
      if (!pendingRaw) return null;
      try {
        return parseCanonicalRecord(pendingRaw);
      } catch {
        return null;
      }
    };

    const pending = parsePending();

    if (raw === null) {
      if (pending?.kind === "active") {
        return adoptPending(pending);
      }
      return migrateLegacy();
    }

    let canonical: MobileSessionRecord;
    try {
      canonical = parseCanonicalRecord(raw);
    } catch (error) {
      if (!pending || pending.kind !== "active") throw error;
      effectiveOverlay = sessionFromCanonical(pending);
      return pending;
    }

    if (!pending || pending.kind !== "active" || pending.revision < canonical.revision) {
      if (pendingRaw) {
        try {
          await secureStore.deleteItemAsync(MOBILE_SESSION_PENDING_KEY);
        } catch {
          /* ignore */
        }
      }
      return canonical;
    }
    return adoptPending(pending);
  };

  const writeActive = async (
    record: MobileActiveSessionRecord,
  ): Promise<void> => {
    const session = sessionFromCanonical(record);
    // Keep a rotated/login pair effective in memory while the exact same local
    // mutation remains pending; never fall back to clearing credentials.
    effectiveOverlay = session;
    await writeVerified(record, () => {
      effectiveOverlay = session;
    });
    effectiveOverlay = session;
    await removeLegacyAfterCommit();
  };

  const writeEmpty = async (
    record: MobileEmptySessionRecord,
  ): Promise<void> => {
    // Do not expose logout until the tombstone is confirmed by exact read-back.
    await writeVerified(record);
    effectiveOverlay = null;
    await removeLegacyAfterCommit();
  };

  const store: MobileSessionStore = {
    async readCanonicalRecord() {
      return serialize(readPersisted);
    },
    async readSession() {
      return serialize(async () => snapshotFromCanonical(await readPersisted()));
    },
    async compareAndSetSession(expectedRevision, next) {
      return serialize(async () => {
        const current = await readPersisted();
        if (current.revision !== expectedRevision) {
          effectiveOverlay = sessionFromCanonical(current);
          return false;
        }
        const record = activeRecord(
          advanceRevision(current.revision),
          next,
          current.kind === "active" && current.pendingProfileSetup,
        );
        await writeActive(record);
        return true;
      });
    },
    async compareAndClearSession(expectedRevision) {
      return serialize(async () => {
        const current = await readPersisted();
        if (current.revision !== expectedRevision) {
          effectiveOverlay = sessionFromCanonical(current);
          return false;
        }
        await writeEmpty({
          version: MOBILE_SESSION_VERSION,
          kind: "empty",
          revision: advanceRevision(current.revision),
        });
        return true;
      });
    },
    async getAccessToken() {
      return serialize(async () => {
        if (effectiveOverlay !== undefined) {
          return effectiveOverlay?.accessToken ?? null;
        }
        return sessionFromCanonical(await readPersisted())?.accessToken ?? null;
      });
    },
    async getRefreshToken() {
      return serialize(async () => {
        if (effectiveOverlay !== undefined) {
          const refresh = effectiveOverlay?.refresh;
          return refresh?.kind === "token" ? refresh.token : null;
        }
        const refresh = sessionFromCanonical(await readPersisted())?.refresh;
        return refresh?.kind === "token" ? refresh.token : null;
      });
    },
    async getExpiresAt() {
      return serialize(async () => {
        if (effectiveOverlay !== undefined) {
          return effectiveOverlay?.expiresAt ?? null;
        }
        return sessionFromCanonical(await readPersisted())?.expiresAt ?? null;
      });
    },
    async saveSession(tokens) {
      await serialize(async () => {
        const current = await readPersisted();
        await writeActive(
          recordFromTokens(
            advanceRevision(current.revision),
            tokens,
            false,
          ),
        );
      });
    },
    async clearSession(_clearKeys = false) {
      await serialize(async () => {
        const current = await readPersisted();
        if (current.kind === "empty") {
          effectiveOverlay = null;
          await removeLegacyAfterCommit();
          return;
        }
        await writeEmpty({
          version: MOBILE_SESSION_VERSION,
          kind: "empty",
          revision: advanceRevision(current.revision),
        });
      });
    },
    async hasPendingProfileSetup() {
      return serialize(async () => {
        const current = await readPersisted();
        return current.kind === "active" && current.pendingProfileSetup;
      });
    },
    async setPendingProfileSetup(value) {
      await serialize(async () => {
        const current = await readPersisted();
        if (current.kind === "empty") {
          if (value) {
            throw new Error(
              "Pending profile setup cannot exist without an active session.",
            );
          }
          return;
        }
        await writeActive({
          ...current,
          revision: advanceRevision(current.revision),
          pendingProfileSetup: value,
        });
      });
    },
  };

  return store;
}

export const mobileSessionStore = createMobileSessionStore(
  SecureStore as SecureStoreLike,
);
