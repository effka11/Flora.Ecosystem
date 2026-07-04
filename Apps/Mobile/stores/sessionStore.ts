import { ApiRequestError, isNetworkError, refreshSessionIfPossible } from "@flora/client-core/api";
import { apiGetMe, apiLogout } from "@flora/client-core/auth";
import type { MeResponse } from "@flora/client-core/contracts";
import { create } from "zustand";
import { mobileFscpKeyStorage } from "@/lib/fscp/storage";
import { mobileSessionStore } from "@/lib/session";
import { useFscpStore } from "@/stores/fscpStore";

type SessionState = {
  me: MeResponse | null;
  isAuthenticated: boolean;
  pendingProfileSetup: boolean;
  bootstrap: () => Promise<void>;
  resumeSession: () => Promise<void>;
  setMe: (me: MeResponse | null) => void;
  logout: (clearKeys?: boolean) => Promise<void>;
};

async function bootstrapFscpIfNeeded(userUuid: string): Promise<void> {
  const fscp = useFscpStore.getState();
  const norm = userUuid.trim().toLowerCase();
  const alreadyReady =
    fscp.passwordSyncedForOwner === norm ||
    (fscp.ownerUserUuid === norm && fscp.status === "ready");
  if (!alreadyReady) {
    await useFscpStore.getState().bootstrap(userUuid);
  }
}

function shouldStayAuthenticatedOffline(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (err instanceof ApiRequestError && err.status === 401) {
    return true;
  }
  return false;
}

async function loadMeIntoStore(pendingProfileSetup: boolean): Promise<void> {
  const me = await apiGetMe();
  useSessionStore.setState({ me, isAuthenticated: true, pendingProfileSetup });
}

export const useSessionStore = create<SessionState>((set) => ({
  me: null,
  isAuthenticated: false,
  pendingProfileSetup: false,
  async bootstrap() {
    const token = await mobileSessionStore.getAccessToken();
    const pending = await mobileSessionStore.hasPendingProfileSetup();
    if (!token) {
      set({ me: null, isAuthenticated: false, pendingProfileSetup: pending });
      return;
    }

    try {
      await loadMeIntoStore(pending);
      return;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        if (await refreshSessionIfPossible()) {
          try {
            await loadMeIntoStore(pending);
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }

      if (shouldStayAuthenticatedOffline(err) && (await mobileSessionStore.getRefreshToken())) {
        set({ me: null, isAuthenticated: true, pendingProfileSetup: pending });
        return;
      }

      await mobileSessionStore.clearSession(false);
      set({ me: null, isAuthenticated: false, pendingProfileSetup: false });
    }
  },
  async resumeSession() {
    const state = useSessionStore.getState();
    if (!state.isAuthenticated) return;

    if (state.me?.userUuid) {
      await bootstrapFscpIfNeeded(state.me.userUuid).catch(() => undefined);
      return;
    }

    try {
      const me = await apiGetMe();
      set({ me, isAuthenticated: true, pendingProfileSetup: state.pendingProfileSetup });
      await bootstrapFscpIfNeeded(me.userUuid);
    } catch {
      /* stay degraded until next reconnect */
    }
  },
  setMe(me) {
    set({ me, isAuthenticated: !!me, pendingProfileSetup: false });
  },
  async logout(clearKeys = false) {
    try {
      await apiLogout();
    } catch {
      /* ignore */
    }
    const me = useSessionStore.getState().me;
    if (clearKeys && me?.userUuid) {
      await mobileFscpKeyStorage.clearProfile(me.userUuid.toLowerCase());
    }
    await mobileSessionStore.clearSession(clearKeys);
    useFscpStore.getState().clearRuntimeState();
    set({ me: null, isAuthenticated: false, pendingProfileSetup: false });
  },
}));
