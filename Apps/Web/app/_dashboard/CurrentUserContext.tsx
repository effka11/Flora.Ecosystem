"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiGetMe, getAccessToken, type MeResponse } from "@/lib/auth";
import type { FscpBootstrapStatus, FscpLocalMaterial } from "@flora/client-core/fscp";
import { getTelemetry } from "@flora/client-core/telemetry";
import { webResolveFscpMaterial } from "@/lib/fscp/bootstrap";
import { webSyncFscpOnLogin } from "@/lib/fscp/syncOnLogin";

type CurrentUserValue = {
  me: MeResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Локальный материал FSCP + deviceUuid с сервера; поднимается после успешного me (любой экран в DashboardShell). */
  fscpMaterial: FscpLocalMaterial | null;
  fscpBootstrapLoading: boolean;
  fscpBootstrapError: string | null;
  /** Последний статус резолва FSCP. Источник истины для триггера парольной модалки (не error-строка). */
  fscpStatus: FscpBootstrapStatus | null;
  /**
   * Restore-only ввод пароля: восстановить ключи из серверного backup один раз.
   * НЕ перезаписывает backup (authoritativeOverwrite=false) — живая сессия не доказывает,
   * что пароль текущий (анти-клоббер, ревью п.2). Возвращает итоговый статус.
   */
  restoreFscpWithPassword: (password: string) => Promise<FscpBootstrapStatus>;
  fscpUnlockOpen: boolean;
  openFscpUnlock: () => void;
  closeFscpUnlock: () => void;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

/** Только устойчивые состояния ключей требуют пароля — НЕ сетевые/500 ошибки (ревью п.5). */
export function fscpStatusNeedsPassword(status: FscpBootstrapStatus | null): boolean {
  return status === "needs_restore" || status === "backup_not_found" || status === "wrong_password";
}

function fscpStatusHint(status: FscpBootstrapStatus): string {
  switch (status) {
    case "needs_restore":
      return "Войдите с паролем для восстановления ключей E2E";
    case "backup_not_found":
      return "Резервная копия ключей не найдена на сервере";
    case "wrong_password":
      return "Неверный пароль — ключи не восстановлены";
    default:
      return `FSCP: ${status}`;
  }
}

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fscpMaterial, setFscpMaterial] = useState<FscpLocalMaterial | null>(null);
  const [fscpBootstrapLoading, setFscpBootstrapLoading] = useState(false);
  const [fscpBootstrapError, setFscpBootstrapError] = useState<string | null>(null);
  const [fscpStatus, setFscpStatus] = useState<FscpBootstrapStatus | null>(null);
  const [fscpUnlockOpen, setFscpUnlockOpen] = useState(false);
  /** Пользователь закрыл модалку — не открывать её автоматически снова до явного запроса. */
  const fscpUnlockDismissedRef = useRef(false);
  /** Чтобы при смене JWT/me не оставался материал предыдущего пользователя до конца loadOrCreate (иначе E2E расшифровка с чужим ключом и вечный кэш ошибки). */
  const fscpMaterialOwnerRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!getAccessToken()) {
      fscpMaterialOwnerRef.current = null;
      setMe(null);
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpBootstrapLoading(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setMe(await apiGetMe());
    } catch {
      fscpMaterialOwnerRef.current = null;
      setMe(null);
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpBootstrapLoading(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!me || !getAccessToken()) {
      fscpMaterialOwnerRef.current = null;
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpBootstrapLoading(false);
      return;
    }
    const ownerNorm = me.userUuid.trim().toLowerCase();
    if (ownerNorm.length === 0) {
      fscpMaterialOwnerRef.current = null;
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpBootstrapLoading(false);
      return;
    }
    if (fscpMaterialOwnerRef.current !== ownerNorm) {
      fscpMaterialOwnerRef.current = ownerNorm;
      setFscpMaterial(null);
      // Новый пользователь — снова можно авто-открыть при необходимости.
      fscpUnlockDismissedRef.current = false;
    }

    let cancelled = false;
    setFscpBootstrapLoading(true);
    setFscpBootstrapError(null);
    void (async () => {
      try {
        const result = await webResolveFscpMaterial(me.userUuid);
        if (!cancelled && getAccessToken()) {
          setFscpMaterial(result.material);
          setFscpStatus(result.status);
          setFscpBootstrapError(
            result.status === "ready" || result.material ? null : fscpStatusHint(result.status),
          );
        }
      } catch (e) {
        if (!cancelled) {
          // Сетевая/серверная ошибка резолва — НЕ статус ключей: не триггерим парольную модалку.
          setFscpMaterial(null);
          setFscpStatus(null);
          setFscpBootstrapError(e instanceof Error ? e.message : "Не удалось инициализировать FSCP");
        }
      } finally {
        if (!cancelled) {
          setFscpBootstrapLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Авто-показ только для устойчивого "нет ключей на этом устройстве" (needs_restore),
  // и только если пользователь не закрыл модалку вручную. Транзиентные ошибки не триггерят.
  useEffect(() => {
    if (fscpStatus === "needs_restore" && !fscpUnlockDismissedRef.current) {
      setFscpUnlockOpen(true);
    }
  }, [fscpStatus]);

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
      if (!me?.userUuid) throw new Error("Нет активного пользователя.");
      const res = await webSyncFscpOnLogin(me.userUuid, password, {
        authoritativeOverwrite: false,
      });
      const status = res.bootstrap.status;
      if (getAccessToken()) {
        setFscpMaterial(res.bootstrap.material);
        setFscpStatus(status);
        setFscpBootstrapError(
          status === "ready" || res.bootstrap.material ? null : fscpStatusHint(status),
        );
      }
      const telemetry = getTelemetry();
      if (status === "ready") {
        telemetry.capture({ type: "restore_success" });
        fscpUnlockDismissedRef.current = false;
        setFscpUnlockOpen(false);
      } else if (status === "wrong_password") {
        telemetry.capture({ type: "restore_failure", reason: "wrong_password" });
      } else if (status === "backup_not_found") {
        telemetry.capture({ type: "restore_failure", reason: "backup_not_found" });
      }
      return status;
    },
    [me],
  );

  const value = useMemo(
    () => ({
      me,
      loading,
      refresh,
      fscpMaterial,
      fscpBootstrapLoading,
      fscpBootstrapError,
      fscpStatus,
      restoreFscpWithPassword,
      fscpUnlockOpen,
      openFscpUnlock,
      closeFscpUnlock,
    }),
    [
      me,
      loading,
      refresh,
      fscpMaterial,
      fscpBootstrapLoading,
      fscpBootstrapError,
      fscpStatus,
      restoreFscpWithPassword,
      fscpUnlockOpen,
      openFscpUnlock,
      closeFscpUnlock,
    ]
  );

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): CurrentUserValue {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error("useCurrentUser должен вызываться внутри CurrentUserProvider (оберните в DashboardShell).");
  }
  return ctx;
}
