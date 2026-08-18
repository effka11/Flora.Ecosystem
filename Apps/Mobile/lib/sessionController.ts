import type { SessionRefreshOutcome } from "@flora/client-core/api";
import type { SessionSnapshot, SessionStore } from "@flora/client-core/auth";
import { parseMePayload, type MeResponse } from "@flora/client-core/contracts";

const DEFAULT_ACCESS_SKEW_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type SessionControllerStatus =
  | "bootstrapping"
  | "authenticated"
  | "degraded"
  | "storageUnavailable"
  | "anonymous";

type SessionStateBase = {
  me: MeResponse | null;
  pendingProfileSetup: boolean;
};

export type SessionControllerState =
  | (SessionStateBase & { status: "bootstrapping" })
  | (SessionStateBase & { status: "authenticated"; me: MeResponse })
  | (SessionStateBase & {
      status: "degraded";
      reason: "refresh" | "network" | "http" | "protocol";
    })
  | (SessionStateBase & { status: "storageUnavailable"; error: unknown })
  | (SessionStateBase & { status: "anonymous"; me: null; pendingProfileSetup: false });

export type SessionClock = {
  now(): number;
};

type AtomicControllerStore = SessionStore &
  Required<Pick<SessionStore, "readSession">>;

export type SessionControllerDependencies = {
  sessionStore: AtomicControllerStore;
  refreshSession(): Promise<SessionRefreshOutcome>;
  supersedeRefresh(): void;
  fetchImpl: typeof fetch;
  apiBaseUrl: string;
  clientHeader: string;
  clock: SessionClock;
  accessSkewMs?: number;
  requestTimeoutMs?: number;
};

export class ApiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiProtocolError";
  }
}

export function parseStrictMePayload(raw: unknown): MeResponse {
  let me: MeResponse;
  try {
    me = parseMePayload(raw);
  } catch {
    throw new ApiProtocolError("The /me response must be a JSON object.");
  }
  if (!me.userUuid.trim()) {
    throw new ApiProtocolError("The /me response has no user UUID.");
  }
  return me;
}

function accessNeedsRefresh(
  snapshot: SessionSnapshot,
  accessToken: string | null,
  now: number,
  skewMs: number,
): boolean {
  if (!accessToken) return true;
  const expiresAt = snapshot.session?.expiresAt;
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(expiresAtMs) || now >= expiresAtMs - skewMs;
}

function mayHaveEffectiveAccess(outcome: SessionRefreshOutcome): boolean {
  return (
    outcome === "ready" ||
    outcome === "storage_pending" ||
    outcome === "superseded"
  );
}

export type SessionController = ReturnType<typeof createSessionController>;

export function createSessionController(
  dependencies: SessionControllerDependencies,
) {
  let epoch = 0;
  let state: SessionControllerState = {
    status: "bootstrapping",
    me: null,
    pendingProfileSetup: false,
  };
  let serialized: Promise<void> = Promise.resolve();
  let queuedEpoch: number | null = null;
  let queuedReconcile: Promise<SessionControllerState> | null = null;
  const listeners = new Set<(next: SessionControllerState) => void>();

  const publish = (
    next: SessionControllerState,
    expectedEpoch = epoch,
  ): SessionControllerState => {
    if (expectedEpoch !== epoch) return state;
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  };

  const storageUnavailable = (
    error: unknown,
    expectedEpoch: number,
  ): SessionControllerState =>
    publish(
      {
        status: "storageUnavailable",
        me: state.me,
        pendingProfileSetup: state.pendingProfileSetup,
        error,
      },
      expectedEpoch,
    );

  const degraded = (
    reason: "refresh" | "network" | "http" | "protocol",
    pendingProfileSetup: boolean,
    expectedEpoch: number,
  ): SessionControllerState =>
    publish(
      {
        status: "degraded",
        me: state.me,
        pendingProfileSetup,
        reason,
      },
      expectedEpoch,
    );

  const anonymous = (expectedEpoch: number): SessionControllerState => {
    if (expectedEpoch === epoch && state.status === "anonymous") return state;
    return publish(
      {
        status: "anonymous",
        me: null,
        pendingProfileSetup: false,
      },
      expectedEpoch,
    );
  };

  const apiUrl = (path: string): string => {
    const base = dependencies.apiBaseUrl.trim().replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return base ? `${base}${suffix}` : suffix;
  };

  const fetchMe = async (accessToken: string): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      return await dependencies.fetchImpl(apiUrl("/api/auth/me"), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-Flora-Client": dependencies.clientHeader,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const effectiveAccess = async (): Promise<string | null> =>
    dependencies.sessionStore.getAccessToken();

  const executeReconcile = async (
    expectedEpoch: number,
  ): Promise<SessionControllerState> => {
    let snapshot: SessionSnapshot;
    let pendingProfileSetup: boolean;
    try {
      snapshot = await dependencies.sessionStore.readSession();
      pendingProfileSetup =
        await dependencies.sessionStore.hasPendingProfileSetup();
    } catch (error) {
      return storageUnavailable(error, expectedEpoch);
    }
    if (expectedEpoch !== epoch) return state;
    if (!snapshot.session?.refresh) return anonymous(expectedEpoch);

    let accessToken: string | null;
    try {
      accessToken = await effectiveAccess();
    } catch (error) {
      return storageUnavailable(error, expectedEpoch);
    }

    let refreshed = false;
    if (
      accessNeedsRefresh(
        snapshot,
        accessToken,
        dependencies.clock.now(),
        dependencies.accessSkewMs ?? DEFAULT_ACCESS_SKEW_MS,
      )
    ) {
      refreshed = true;
      const outcome = await dependencies.refreshSession();
      if (expectedEpoch !== epoch) return state;
      if (outcome === "invalid") return anonymous(expectedEpoch);
      if (!mayHaveEffectiveAccess(outcome)) {
        return degraded(
          outcome === "protocol_error" ? "protocol" : "refresh",
          pendingProfileSetup,
          expectedEpoch,
        );
      }
      try {
        accessToken = await effectiveAccess();
      } catch (error) {
        return storageUnavailable(error, expectedEpoch);
      }
      if (!accessToken) {
        return degraded("refresh", pendingProfileSetup, expectedEpoch);
      }
    }

    if (!accessToken) {
      return degraded("refresh", pendingProfileSetup, expectedEpoch);
    }

    let response: Response;
    try {
      response = await fetchMe(accessToken);
    } catch {
      return degraded("network", pendingProfileSetup, expectedEpoch);
    }
    if (expectedEpoch !== epoch) return state;

    if (response.status === 401 && !refreshed) {
      const outcome = await dependencies.refreshSession();
      if (expectedEpoch !== epoch) return state;
      if (outcome === "invalid") return anonymous(expectedEpoch);
      if (!mayHaveEffectiveAccess(outcome)) {
        return degraded(
          outcome === "protocol_error" ? "protocol" : "refresh",
          pendingProfileSetup,
          expectedEpoch,
        );
      }
      try {
        accessToken = await effectiveAccess();
      } catch (error) {
        return storageUnavailable(error, expectedEpoch);
      }
      if (!accessToken) {
        return degraded("refresh", pendingProfileSetup, expectedEpoch);
      }
      try {
        response = await fetchMe(accessToken);
      } catch {
        return degraded("network", pendingProfileSetup, expectedEpoch);
      }
      if (expectedEpoch !== epoch) return state;
    }

    if (!response.ok) {
      return degraded("http", pendingProfileSetup, expectedEpoch);
    }

    try {
      const raw = await response.json();
      const me = parseStrictMePayload(raw);
      return publish(
        {
          status: "authenticated",
          me,
          pendingProfileSetup,
        },
        expectedEpoch,
      );
    } catch {
      return degraded("protocol", pendingProfileSetup, expectedEpoch);
    }
  };

  const reconcile = (): Promise<SessionControllerState> => {
    const expectedEpoch = epoch;
    if (queuedEpoch === expectedEpoch && queuedReconcile) {
      return queuedReconcile;
    }

    const run = serialized.then(
      () => executeReconcile(expectedEpoch),
      () => executeReconcile(expectedEpoch),
    );
    serialized = run.then(
      () => undefined,
      () => undefined,
    );
    queuedEpoch = expectedEpoch;
    queuedReconcile = run.finally(() => {
      if (queuedEpoch === expectedEpoch) {
        queuedEpoch = null;
        queuedReconcile = null;
      }
    });
    return queuedReconcile;
  };

  const supersede = (): number => {
    epoch += 1;
    dependencies.supersedeRefresh();
    queuedEpoch = null;
    queuedReconcile = null;
    return epoch;
  };

  return {
    getState(): SessionControllerState {
      return state;
    },
    subscribe(listener: (next: SessionControllerState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconcile,
    bootstrap(): Promise<SessionControllerState> {
      publish(
        {
          status: "bootstrapping",
          me: null,
          pendingProfileSetup: false,
        },
        epoch,
      );
      return reconcile();
    },
    beginLogin(): void {
      supersede();
    },
    onLogin(): Promise<SessionControllerState> {
      const nextEpoch = supersede();
      publish(
        {
          status: "bootstrapping",
          me: null,
          pendingProfileSetup: false,
        },
        nextEpoch,
      );
      return reconcile();
    },
    onLogout(): void {
      const nextEpoch = supersede();
      anonymous(nextEpoch);
    },
    onUnauthorized(): void {
      const nextEpoch = supersede();
      anonymous(nextEpoch);
    },
    reportStorageUnavailable(
      error: unknown,
      previous?: Pick<SessionStateBase, "me" | "pendingProfileSetup">,
    ): void {
      publish({
        status: "storageUnavailable",
        me: previous?.me ?? state.me,
        pendingProfileSetup:
          previous?.pendingProfileSetup ?? state.pendingProfileSetup,
        error,
      });
    },
    acceptAuthenticated(me: MeResponse): void {
      publish({
        status: "authenticated",
        me,
        pendingProfileSetup: false,
      });
    },
    setPendingProfileSetup(value: boolean): void {
      if (state.status === "anonymous") return;
      publish({ ...state, pendingProfileSetup: value });
    },
  };
}
