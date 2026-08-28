"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { apiGetSecurityStatus, type SecurityStatusDto } from "@flora/client-core/auth";
import { initGovApiClient, signOutGov } from "@/lib/govApiClient";
import { decideGovGate, serverErrorText } from "@/lib/govAuthGate";
import { govSessionStore } from "@/lib/govSessionStore";
import { redirectToLogin } from "@/lib/loginRedirect";
import { GovEmailWall } from "./GovEmailWall";
import { GovFscpProvider } from "./GovFscpProvider";
import { GovFscpUnlockModal } from "./GovFscpUnlockModal";
import { GovShell } from "./GovShell";
import styles from "./govAuthGate.module.css";
import { useGovSessionKeepAlive } from "./useGovSessionKeepAlive";

type SecurityOutcome =
  | { status: "ready"; security: SecurityStatusDto }
  | { status: "error"; message: string };

type SecurityState = { status: "checking" } | SecurityOutcome;

const subscribeClient = () => () => {};
const getClientSnapshot = () => true;
const getSignedOutSnapshot = () => false;

const subscribeSession = (onStoreChange: () => void) =>
  govSessionStore.subscribeSessionChanged(onStoreChange);
const getTokenSnapshot = () => Boolean(govSessionStore.getAccessTokenSync());

function GovLogoutButton() {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={styles.logout}
      disabled={busy}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void signOutGov();
      }}
    >
      Выйти
    </button>
  );
}

/**
 * Single guard for the civic route group.
 *
 * The session lives in localStorage, which the server cannot read, so the decision
 * only exists after hydration. Until then, and whenever the gate is closed, the
 * civic children are not rendered at all.
 */
export function GovAuthGate({ children }: { children: ReactNode }) {
  const isClient = useSyncExternalStore(subscribeClient, getClientSnapshot, getSignedOutSnapshot);
  const hasToken = useSyncExternalStore(subscribeSession, getTokenSnapshot, getSignedOutSnapshot);
  const [reloadToken, setReloadToken] = useState(0);
  const [outcome, setOutcome] = useState<{ key: string; value: SecurityOutcome } | null>(null);

  // Один запрос статуса = одна пара «сессия + попытка». Пока ответ относится к
  // прошлой паре, состояние выводится как `checking`, поэтому гейт закрыт и без
  // синхронного setState внутри эффекта.
  const requestKey = `${hasToken ? "session" : "none"}:${reloadToken}`;
  const state: SecurityState =
    outcome && outcome.key === requestKey ? outcome.value : { status: "checking" };

  useGovSessionKeepAlive(isClient && hasToken);

  useEffect(() => {
    if (!isClient || hasToken) return;
    redirectToLogin();
  }, [hasToken, isClient]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    let cancelled = false;

    initGovApiClient();
    apiGetSecurityStatus().then(
      (security) => {
        if (!cancelled) setOutcome({ key: requestKey, value: { status: "ready", security } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setOutcome({
            key: requestKey,
            value: { status: "error", message: serverErrorText(error) },
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [hasToken, isClient, requestKey]);

  if (!isClient || !hasToken) return null;

  if (state.status === "checking") {
    return (
      <GovShell statusSlot={<p className={styles.statusLine}>Проверяем доступ</p>}>
        <p className={styles.notice} role="status">
          Проверяем доступ к гражданскому порталу.
        </p>
      </GovShell>
    );
  }

  if (state.status === "error") {
    return (
      <GovShell statusSlot={<p className={styles.statusLine}>Статус недоступен</p>}>
        <p className={styles.notice}>
          Портал не прочитал статус безопасности, поэтому функции остаются закрытыми.
        </p>
        <p className={styles.error} role="alert">
          {state.message}
        </p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => setReloadToken((value) => value + 1)}
        >
          Повторить проверку
        </button>
      </GovShell>
    );
  }

  const decision = decideGovGate({ hasAccessToken: hasToken, security: state.security });

  return (
    <GovShell
      statusSlot={
        decision === "shell" ? (
          <GovLogoutButton />
        ) : (
          <p className={styles.statusLine}>Email не подтверждён</p>
        )
      }
    >
      {decision === "shell" ? (
        <GovFscpProvider>
          {children}
          <GovFscpUnlockModal />
        </GovFscpProvider>
      ) : (
        <GovEmailWall
          onVerified={(security) =>
            setOutcome({ key: requestKey, value: { status: "ready", security } })
          }
        />
      )}
    </GovShell>
  );
}
