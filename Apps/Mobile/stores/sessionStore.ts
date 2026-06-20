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
  setMe: (me: MeResponse | null) => void;
  logout: (clearKeys?: boolean) => Promise<void>;
};

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
      const me = await apiGetMe();
      set({ me, isAuthenticated: true, pendingProfileSetup: pending });
    } catch {
      await mobileSessionStore.clearSession(false);
      set({ me: null, isAuthenticated: false, pendingProfileSetup: false });
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
