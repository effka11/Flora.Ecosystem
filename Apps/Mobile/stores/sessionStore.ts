import {
  notifyIfSessionRevoked,
  refreshSession,
  supersedeSessionRefresh,
} from "@flora/client-core/api";
import { apiLogout } from "@flora/client-core/auth";
import type { MeResponse } from "@flora/client-core/contracts";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { create } from "zustand";
import { clearSecurePushMaterial } from "flora-secure-push";
import { mobileFscpKeyStorage } from "@/lib/fscp/storage";
import { getQueryClientRef } from "@/lib/queryClientRef";
import { mobileSessionStore, resolveApiBaseUrl } from "@/lib/session";
import {
  createSessionController,
  type SessionControllerStatus,
} from "@/lib/sessionController";
import { useFscpStore } from "@/stores/fscpStore";
import { resetBirthTracking } from "@/lib/messageBirthRegistry";
import { clearAllPendingOutgoing } from "@/lib/messageThreadOutgoing";
import { clearMessageTextMeasures } from "@/lib/messageTextMeasureCache";
import { wipeChatDiskCache } from "@/stores/chatDiskCache";
import { messagePreviewCache } from "@/stores/messagePreviewCache";
import { messageThreadCache } from "@/stores/messageThreadCache";
import { wipeTextMeasureDisk } from "@/stores/textMeasureDiskCache";

type SessionState = {
  status: SessionControllerStatus;
  me: MeResponse | null;
  isAuthenticated: boolean;
  pendingProfileSetup: boolean;
  bootstrap: () => Promise<void>;
  beginLogin: () => void;
  activateLogin: () => Promise<void>;
  reconcileSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  setMe: (me: MeResponse | null) => void;
  logout: (clearKeys?: boolean) => Promise<void>;
};

const mobileSessionController = createSessionController({
  sessionStore: mobileSessionStore,
  async refreshSession() {
    const outcome = await refreshSession();
    if (outcome === "invalid") await notifyIfSessionRevoked();
    return outcome;
  },
  supersedeRefresh: supersedeSessionRefresh,
  fetchImpl: ((input, init) => fetch(input, init)) as typeof fetch,
  apiBaseUrl: resolveApiBaseUrl(),
  clientHeader: "android/0.12.0-alpha",
  clock: { now: () => Date.now() },
});

export const useSessionStore = create<SessionState>(() => ({
  status: "bootstrapping",
  me: null,
  isAuthenticated: false,
  pendingProfileSetup: false,
  async bootstrap() {
    await mobileSessionController.bootstrap();
  },
  beginLogin() {
    mobileSessionController.beginLogin();
  },
  async activateLogin() {
    await mobileSessionController.onLogin();
  },
  async reconcileSession() {
    await mobileSessionController.reconcile();
  },
  async resumeSession() {
    await mobileSessionController.reconcile();
  },
  setMe(me) {
    if (me) {
      mobileSessionController.acceptAuthenticated(me);
      return;
    }
    mobileSessionController.onUnauthorized();
  },
  async logout(clearKeys = false) {
    const previous = mobileSessionController.getState();
    const me = previous.me;
    mobileSessionController.onLogout();
    clearSecurePushMaterial();
    try {
      await apiLogout();
    } catch {
      /* ignore */
    }
    try {
      await mobileSessionStore.clearSession(clearKeys);
    } catch (error) {
      mobileSessionController.reportStorageUnavailable(error, {
        me,
        pendingProfileSetup: previous.pendingProfileSetup,
      });
      throw error;
    }
    if (clearKeys && me?.userUuid) {
      await mobileFscpKeyStorage
        .clearProfile(me.userUuid.toLowerCase())
        .catch(() => undefined);
    }
    useFscpStore.getState().clearRuntimeState();
  },
}));

mobileSessionController.subscribe((next) => {
  const isAuthenticated =
    next.status === "authenticated" ||
    next.status === "degraded" ||
    (next.status === "storageUnavailable" && next.me !== null);
  useSessionStore.setState({
    status: next.status,
    me: next.me,
    isAuthenticated,
    pendingProfileSetup: next.pendingProfileSetup,
  });
  if (next.status === "anonymous") {
    clearSecurePushMaterial();
    useFscpStore.getState().clearRuntimeState();
    getQueryClientRef()?.clear();
    messagePreviewCache.clear();
    messageThreadCache.clear();
    wipeChatDiskCache();
    // Замеры пузырей — это тексты сообщений: ни в памяти, ни на диске они не
    // должны переживать выход из аккаунта.
    clearMessageTextMeasures();
    wipeTextMeasureDisk();
    clearAllPendingOutgoing();
    resetBirthTracking();
    sharedPresenceStore.clear();
  }
});

export function handleSessionUnauthorized(): void {
  mobileSessionController.onUnauthorized();
}

export function getMobileSessionController() {
  return mobileSessionController;
}
