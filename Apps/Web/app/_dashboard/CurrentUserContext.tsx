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
import { apiGetMe, ensureFreshAccessToken, getAccessToken, type MeResponse } from "@/lib/auth";
import type {
  FscpBootstrapResult,
  FscpBootstrapStatus,
  FscpLocalMaterial,
  FscpTransportFailureClass,
} from "@flora/client-core/fscp";
import { takeProvenAccountPassword } from "@flora/client-core/fscp";
import { getTelemetry } from "@flora/client-core/telemetry";
import { webResolveFscpMaterial } from "@/lib/fscp/bootstrap";
import { webSyncFscpOnLogin } from "@/lib/fscp/syncOnLogin";

/** Reasons that justify auto-opening the unlock modal without an explicit user click. */
type SilentUnlockReason = "needs_restore" | "wrong_password" | "backup_not_found";

/** How many passwordless retries the dashboard schedules after a `transient_error` (failure="transient"). */
const FSCP_WEB_RETRY_DELAYS_MS = [2000, 5000];

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
  /** Класс сбоя транспорта, когда fscpStatus === "transient_error" (иначе null). Для баннера. */
  fscpFailure: FscpTransportFailureClass | null;
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
  const [fscpFailure, setFscpFailure] = useState<FscpTransportFailureClass | null>(null);
  const [fscpUnlockOpen, setFscpUnlockOpen] = useState(false);
  /** Пользователь закрыл модалку — не открывать её автоматически снова до явного запроса. */
  const fscpUnlockDismissedRef = useRef(false);
  /** Чтобы при смене JWT/me не оставался материал предыдущего пользователя до конца loadOrCreate (иначе E2E расшифровка с чужим ключом и вечный кэш ошибки). */
  const fscpMaterialOwnerRef = useRef<string | null>(null);
  /** Bounded auto-retry timer for transient_error (failure="transient"); cleared on owner change/unmount. */
  const fscpRetryTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!getAccessToken()) {
      fscpMaterialOwnerRef.current = null;
      setMe(null);
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpBootstrapLoading(false);
      return;
    }
    setLoading(true);
    try {
      await ensureFreshAccessToken();
      setMe(await apiGetMe());
    } catch {
      // Keep prior me when tokens are still present (transient network / refresh blip).
      if (!getAccessToken()) {
        fscpMaterialOwnerRef.current = null;
        setMe(null);
        setFscpMaterial(null);
        setFscpBootstrapError(null);
        setFscpStatus(null);
        setFscpBootstrapLoading(false);
      } else {
        try {
          await ensureFreshAccessToken();
          setMe(await apiGetMe());
        } catch {
          if (!getAccessToken()) {
            fscpMaterialOwnerRef.current = null;
            setMe(null);
            setFscpMaterial(null);
            setFscpBootstrapError(null);
            setFscpStatus(null);
            setFscpBootstrapLoading(false);
          }
          // else: leave previous me as-is
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearFscpRetryTimer = useCallback(() => {
    if (fscpRetryTimerRef.current !== null) {
      window.clearTimeout(fscpRetryTimerRef.current);
      fscpRetryTimerRef.current = null;
    }
  }, []);

  /**
   * Applies an FscpBootstrapResult to state. Defect 5 (plan `fscp_restore_reliability`): the
   * kernel deliberately returns `transient_error` WITH `material` when local keys already exist
   * and only a metadata call (pubkey lookup) failed transiently — never blank a working chat
   * because of that. `transient_error` gets no raw hint string; the dedicated banner (consumer
   * side, keyed on fscpStatus + fscpFailure) owns that copy instead of `fscpStatusHint`.
   */
  const applyFscpBootstrapResult = useCallback(
    (result: FscpBootstrapResult, cancelledRef: { current: boolean }) => {
      if (cancelledRef.current || !getAccessToken()) return;
      setFscpMaterial(result.material);
      setFscpStatus(result.status);
      setFscpFailure(result.status === "transient_error" ? (result.failure ?? null) : null);
      if (result.status === "ready" || result.material || result.status === "transient_error") {
        setFscpBootstrapError(null);
      } else {
        setFscpBootstrapError(fscpStatusHint(result.status));
      }
    },
    [],
  );

  useEffect(() => {
    const ownerUserUuid = me?.userUuid;
    if (!ownerUserUuid || !getAccessToken()) {
      fscpMaterialOwnerRef.current = null;
      clearFscpRetryTimer();
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpFailure(null);
      setFscpBootstrapLoading(false);
      return;
    }
    const ownerNorm = ownerUserUuid.trim().toLowerCase();
    if (!ownerNorm) {
      fscpMaterialOwnerRef.current = null;
      clearFscpRetryTimer();
      setFscpMaterial(null);
      setFscpBootstrapError(null);
      setFscpStatus(null);
      setFscpFailure(null);
      setFscpBootstrapLoading(false);
      return;
    }
    if (fscpMaterialOwnerRef.current !== ownerNorm) {
      fscpMaterialOwnerRef.current = ownerNorm;
      setFscpMaterial(null);
      // Новый пользователь — снова можно авто-открыть при необходимости.
      fscpUnlockDismissedRef.current = false;
    }

    const cancelledRef = { current: false };
    clearFscpRetryTimer();
    setFscpBootstrapLoading(true);
    setFscpBootstrapError(null);

    const openUnlockModalForReason = (reason: SilentUnlockReason) => {
      if (cancelledRef.current || fscpUnlockDismissedRef.current) return;
      getTelemetry().capture({ type: "unlock_prompt_shown", reason });
      setFscpUnlockOpen(true);
    };

    const scheduleTransientRetry = (attempt: number) => {
      if (cancelledRef.current) return;
      const delay = FSCP_WEB_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) return; // человеческий предел ретраев исчерпан — оставить статичный баннер
      fscpRetryTimerRef.current = window.setTimeout(() => {
        fscpRetryTimerRef.current = null;
        if (!cancelledRef.current) void runResolve(attempt);
      }, delay);
    };

    // needs_restore: сначала одна молчаливая попытка доигранным паролем из логин-handoff
    // (single-use, TTL 90s — см. loginHandoff.ts), и только если её нет/она не помогла —
    // модалка. authoritativeOverwrite: true обосновано в шапке loginHandoff.ts.
    async function handleNeedsRestore() {
      const password = takeProvenAccountPassword(ownerNorm);
      if (cancelledRef.current) return;
      if (!password) {
        openUnlockModalForReason("needs_restore");
        return;
      }

      let syncResult: Awaited<ReturnType<typeof webSyncFscpOnLogin>>;
      try {
        syncResult = await webSyncFscpOnLogin(ownerNorm, password, { authoritativeOverwrite: true });
      } catch (e) {
        if (!cancelledRef.current) {
          getTelemetry().capture({ type: "login_handoff_used", ok: false });
          setFscpBootstrapError(e instanceof Error ? e.message : "Не удалось инициализировать FSCP");
          openUnlockModalForReason("needs_restore");
        }
        return;
      }
      if (cancelledRef.current) return;

      getTelemetry().capture({
        type: "login_sync_outcome",
        ok: syncResult.bootstrap.status === "ready",
        ...(syncResult.failure ? { failure: syncResult.failure } : {}),
        attempts: syncResult.attempts ?? 0,
      });

      const ok = syncResult.bootstrap.status === "ready";
      getTelemetry().capture({ type: "login_handoff_used", ok });
      applyFscpBootstrapResult(syncResult.bootstrap, cancelledRef);

      if (ok) return;
      if (syncResult.bootstrap.status === "wrong_password" || syncResult.bootstrap.status === "backup_not_found") {
        openUnlockModalForReason(syncResult.bootstrap.status);
        return;
      }
      // transient_error с failure="transient" → тихий баннер + ретрай, без модалки (пароль уже
      // потрачен — handoff single-use). failure="permanent" (kdf_failed/malformed) → ни ретрая,
      // ни модалки: спрашивать пароль ещё раз бессмысленно.
      if (syncResult.bootstrap.status === "transient_error" && syncResult.bootstrap.failure === "transient") {
        scheduleTransientRetry(1);
      }
    }

    async function runResolve(retryAttempt: number) {
      if (retryAttempt === 0) setFscpBootstrapLoading(true);
      try {
        const result = await webResolveFscpMaterial(ownerNorm);
        if (cancelledRef.current || !getAccessToken()) return;
        applyFscpBootstrapResult(result, cancelledRef);

        if (result.status === "needs_restore") {
          await handleNeedsRestore();
        } else if (
          result.status === "transient_error" &&
          result.failure === "transient" &&
          retryAttempt < FSCP_WEB_RETRY_DELAYS_MS.length
        ) {
          scheduleTransientRetry(retryAttempt + 1);
        }
      } catch (e) {
        if (cancelledRef.current) return;
        // Неожиданный throw (не по контракту transient_error — сам резолв ловит транзиенты и
        // возвращает статус). НЕ обнуляем fscpMaterial/fscpStatus здесь: предыдущее рабочее
        // состояние ключей безопаснее слепого сброса чата на постороннюю ошибку (дефект 5).
        setFscpBootstrapError(e instanceof Error ? e.message : "Не удалось инициализировать FSCP");
      } finally {
        if (!cancelledRef.current) setFscpBootstrapLoading(false);
      }
    }

    void runResolve(0);

    return () => {
      cancelledRef.current = true;
      clearFscpRetryTimer();
    };
  }, [me?.userUuid, applyFscpBootstrapResult, clearFscpRetryTimer]);

  const openFscpUnlock = useCallback(() => {
    fscpUnlockDismissedRef.current = false;
    getTelemetry().capture({ type: "unlock_prompt_shown", reason: "manual" });
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
        setFscpFailure(status === "transient_error" ? (res.bootstrap.failure ?? null) : null);
        setFscpBootstrapError(
          status === "ready" || res.bootstrap.material || status === "transient_error"
            ? null
            : fscpStatusHint(status),
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
      } else if (status === "transient_error" && res.bootstrap.failure === "transient") {
        // Manual unlock-modal path only — the silent handoff restore (CurrentUserContext's main
        // resolve effect) is already covered by login_sync_outcome/login_handoff_used and must
        // NOT also emit restore_failure, or transient counts would be double-booked.
        telemetry.capture({ type: "restore_failure", reason: "transient" });
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
      fscpFailure,
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
      fscpFailure,
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
