"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  FscpBootstrapResult,
  FscpBootstrapStatus,
  FscpLocalMaterial,
} from "@flora/client-core/fscp";
import { takeProvenAccountPassword } from "@flora/client-core/fscp";
import { govResolveFscpMaterial } from "@/lib/fscp/bootstrap";
import { govSyncFscpOnLogin } from "@/lib/fscp/syncOnLogin";
import { readUserUuidFromAccessToken } from "@/lib/govAccessToken";
import { govSessionStore } from "@/lib/govSessionStore";

type GovFscpValue = {
  fscpMaterial: FscpLocalMaterial | null;
  fscpBootstrapLoading: boolean;
  fscpStatus: FscpBootstrapStatus | null;
  restoreFscpWithPassword: (password: string) => Promise<FscpBootstrapStatus>;
  fscpUnlockOpen: boolean;
  openFscpUnlock: () => void;
  closeFscpUnlock: () => void;
};

const GovFscpContext = createContext<GovFscpValue | null>(null);

export function fscpStatusNeedsPassword(status: FscpBootstrapStatus | null): boolean {
  return status === "needs_restore" || status === "backup_not_found" || status === "wrong_password";
}

const subscribeSession = (onStoreChange: () => void) =>
  govSessionStore.subscribeSessionChanged(onStoreChange);
const getTokenSnapshot = () => govSessionStore.getAccessTokenSync();
const getServerTokenSnapshot = () => null;

export function GovFscpProvider({ children }: { children: ReactNode }) {
  const accessToken = useSyncExternalStore(subscribeSession, getTokenSnapshot, getServerTokenSnapshot);
  const ownerUserUuid = readUserUuidFromAccessToken(accessToken);
  const signedIn = Boolean(ownerUserUuid?.trim() && accessToken);
  const [fscpMaterial, setFscpMaterial] = useState<FscpLocalMaterial | null>(null);
  const [fscpBootstrapLoading, setFscpBootstrapLoading] = useState(false);
  const [fscpStatus, setFscpStatus] = useState<FscpBootstrapStatus | null>(null);
  const [fscpUnlockOpen, setFscpUnlockOpen] = useState(false);
  const fscpUnlockDismissedRef = useRef(false);
  const fscpMaterialOwnerRef = useRef<string | null>(null);

  const applyResult = useCallback((result: FscpBootstrapResult) => {
    if (!govSessionStore.getAccessTokenSync()) return;
    setFscpMaterial(result.material);
    setFscpStatus(result.status);
  }, []);

  useEffect(() => {
    const ownerNorm = ownerUserUuid?.trim().toLowerCase() ?? "";
    if (!ownerNorm || !accessToken) {
      fscpMaterialOwnerRef.current = null;
      queueMicrotask(() => {
        setFscpMaterial(null);
        setFscpStatus(null);
        setFscpBootstrapLoading(false);
      });
      return;
    }
    let cancelled = false;
    if (fscpMaterialOwnerRef.current !== ownerNorm) {
      fscpMaterialOwnerRef.current = ownerNorm;
      fscpUnlockDismissedRef.current = false;
    }

    const openUnlock = () => {
      if (cancelled || fscpUnlockDismissedRef.current) return;
      setFscpUnlockOpen(true);
    };

    async function handleNeedsRestore() {
      const password = takeProvenAccountPassword(ownerNorm);
      if (cancelled) return;
      if (!password) {
        openUnlock();
        return;
      }
      try {
        const syncResult = await govSyncFscpOnLogin(ownerNorm, password, {
          authoritativeOverwrite: true,
        });
        if (cancelled) return;
        applyResult(syncResult.bootstrap);
        if (syncResult.bootstrap.status === "ready") return;
        if (fscpStatusNeedsPassword(syncResult.bootstrap.status)) openUnlock();
      } catch {
        if (!cancelled) openUnlock();
      }
    }

    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setFscpBootstrapLoading(true);
      try {
        const result = await govResolveFscpMaterial(ownerNorm);
        if (cancelled || !govSessionStore.getAccessTokenSync()) return;
        applyResult(result);
        if (result.status === "needs_restore") {
          await handleNeedsRestore();
        } else if (fscpStatusNeedsPassword(result.status)) {
          openUnlock();
        }
      } catch {
        if (!cancelled) setFscpStatus("transient_error");
      } finally {
        if (!cancelled) setFscpBootstrapLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, ownerUserUuid, applyResult]);

  const openFscpUnlock = useCallback(() => {
    fscpUnlockDismissedRef.current = false;
    setFscpUnlockOpen(true);
  }, []);

  const closeFscpUnlock = useCallback(() => {
    fscpUnlockDismissedRef.current = true;
    setFscpUnlockOpen(false);
  }, []);

  const restoreFscpWithPassword = useCallback(
    async (password: string): Promise<FscpBootstrapStatus> => {
      const owner = ownerUserUuid?.trim();
      if (!owner) throw new Error("Нет активного пользователя.");
      const res = await govSyncFscpOnLogin(owner, password, {
        authoritativeOverwrite: false,
      });
      if (govSessionStore.getAccessTokenSync()) {
        setFscpMaterial(res.bootstrap.material);
        setFscpStatus(res.bootstrap.status);
      }
      if (res.bootstrap.status === "ready") {
        fscpUnlockDismissedRef.current = false;
        setFscpUnlockOpen(false);
      }
      return res.bootstrap.status;
    },
    [ownerUserUuid],
  );

  const value = useMemo(
    () => ({
      fscpMaterial: signedIn ? fscpMaterial : null,
      fscpBootstrapLoading: signedIn ? fscpBootstrapLoading : false,
      fscpStatus: signedIn ? fscpStatus : null,
      restoreFscpWithPassword,
      fscpUnlockOpen: signedIn && fscpUnlockOpen,
      openFscpUnlock,
      closeFscpUnlock,
    }),
    [
      signedIn,
      fscpMaterial,
      fscpBootstrapLoading,
      fscpStatus,
      restoreFscpWithPassword,
      fscpUnlockOpen,
      openFscpUnlock,
      closeFscpUnlock,
    ],
  );

  return <GovFscpContext.Provider value={value}>{children}</GovFscpContext.Provider>;
}

export function useGovFscp(): GovFscpValue {
  const ctx = useContext(GovFscpContext);
  if (!ctx) {
    throw new Error("useGovFscp должен вызываться внутри GovFscpProvider.");
  }
  return ctx;
}
