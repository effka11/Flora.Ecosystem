"use client";

import {
  apiClaimFrankingReport,
  apiGetFrankingAudit,
  apiGetFrankingQueue,
  apiGetFrankingReport,
  apiReleaseFrankingReport,
  apiResolveFrankingReport,
  apiReviewFrankingReportWithIdentity,
  toFrankingFailure,
} from "@flora/client-core/api";
import type { FrankingReportMetaDto } from "@flora/client-core/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useGovFscp } from "@/app/_shell/GovFscpProvider";
import { initGovApiClient } from "@/lib/govApiClient";
import { govSessionStore } from "@/lib/govSessionStore";
import {
  formatFrankingHandle,
  formatFrankingTimestamp,
  frankingPeerAvatarLetters,
  readUserUuidFromAccessToken,
} from "./moderationFormat";
import {
  DISCLOSURE_UNLOCK_COPY,
  DISCLOSURE_WAITING_COPY,
  loadAnketaDisclosure,
  presentAnketaDisclosureView,
  resolveAnketaDisclosureIntent,
  type AnketaDisclosureView,
} from "./moderationDisclosure";
import {
  labelFrankingArea,
  labelFrankingCategory,
  labelFrankingReviewedBlock,
  labelFrankingStatus,
  labelFrankingVerification,
  labelHasDisclosure,
} from "./moderationLabels";
import { SanctionMatrix } from "./SanctionMatrix";
import {
  emptySanctionDraft,
  hasSelectedSanctions,
  sanctionDraftToAccountBlock,
  type SanctionDraft,
} from "./moderationSanctions";
import styles from "./moderation.module.css";
import {
  appendQueuePage,
  canClaimReport,
  canCloseAsClaimer,
  canReleaseAsClaimer,
  dispatchClaimReport,
  dispatchReleaseReport,
  dispatchResolveReport,
  filterQueueItems,
  loadInitialQueue,
  mergeReportIntoQueue,
  refreshReportMeta,
  MODERATION_QUEUE_FILTERS,
  type ModerationFrankingDeps,
  type ModerationQueueFilter,
  type QueueAccumulator,
  type QueueLoadOutcome,
} from "./moderationQueue";

type AsyncOutcome<T> = { key: string; value: T };

type QueueViewState =
  | { phase: "loading" }
  | { phase: "refusal"; message: string }
  | { phase: "ready"; queue: QueueAccumulator };

function createLiveFrankingDeps(): ModerationFrankingDeps {
  return {
    getQueue: apiGetFrankingQueue,
    getReport: apiGetFrankingReport,
    claimReport: apiClaimFrankingReport,
    releaseReport: apiReleaseFrankingReport,
    resolveReport: apiResolveFrankingReport,
    getAudit: apiGetFrankingAudit,
    reviewReport: (input) => apiReviewFrankingReportWithIdentity(input),
  };
}

function queueMetaLine(report: FrankingReportMetaDto): string {
  return `${labelFrankingStatus(report.status)}  ·  ${formatFrankingTimestamp(report.createdAt)}`;
}

export function ModerationPanel() {
  const deps = useMemo(() => createLiveFrankingDeps(), []);
  const { fscpMaterial, fscpBootstrapLoading, openFscpUnlock } = useGovFscp();
  const [reloadToken, setReloadToken] = useState(0);
  const [queueOutcome, setQueueOutcome] = useState<AsyncOutcome<QueueLoadOutcome> | null>(null);
  const [appendBusy, setAppendBusy] = useState(false);
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<FrankingReportMetaDto | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [detailReloadToken, setDetailReloadToken] = useState(0);
  const [queueFilter, setQueueFilter] = useState<ModerationQueueFilter>("open");
  const [viewMode, setViewMode] = useState<"list" | "anketa">("list");
  const [sanctionDrafts, setSanctionDrafts] = useState<Record<string, SanctionDraft>>({});
  const [fetchedDisclosure, setFetchedDisclosure] = useState<{
    key: string;
    view: AnketaDisclosureView;
  } | null>(null);
  const accessToken = useSyncExternalStore(
    (onStoreChange) => govSessionStore.subscribeSessionChanged(onStoreChange),
    () => govSessionStore.getAccessTokenSync(),
    () => null,
  );
  const viewerUserUuid = readUserUuidFromAccessToken(accessToken);

  const queueRequestKey = String(reloadToken);
  const queueView: QueueViewState = (() => {
    if (!queueOutcome || queueOutcome.key !== queueRequestKey) {
      return { phase: "loading" };
    }
    const outcome = queueOutcome.value;
    if (outcome.kind === "refusal") {
      return { phase: "refusal", message: outcome.failure.message };
    }
    return { phase: "ready", queue: outcome.queue };
  })();

  const readyItems = queueView.phase === "ready" ? queueView.queue.items : [];
  const visibleItems = filterQueueItems(readyItems, queueFilter, viewerUserUuid);
  const mineReports = filterQueueItems(readyItems, "mine", viewerUserUuid);
  const closedReports = filterQueueItems(readyItems, "closed", viewerUserUuid);

  const selectedInFilter = selectedUuid
    ? visibleItems.find((item) => item.reportUuid === selectedUuid)
    : undefined;
  const pinnedSelected =
    selectedReport &&
    selectedUuid &&
    selectedReport.reportUuid === selectedUuid &&
    filterQueueItems([selectedReport], queueFilter, viewerUserUuid).length > 0
      ? selectedReport
      : null;
  const focusedReport = selectedInFilter ?? pinnedSelected ?? null;
  const isApplicationPage =
    viewMode === "anketa" && queueFilter !== "open" && focusedReport !== null;
  const resolvedReport = isApplicationPage
    ? focusedReport
    : (focusedReport ?? visibleItems[0] ?? null);
  const activeReport =
    selectedReport && resolvedReport && selectedReport.reportUuid === resolvedReport.reportUuid
      ? selectedReport
      : resolvedReport;
  const activeUuid = activeReport?.reportUuid ?? null;
  const sanctionDraft = activeUuid
    ? (sanctionDrafts[activeUuid] ?? emptySanctionDraft())
    : emptySanctionDraft();
  const canEditSanctions =
    activeReport !== null && canCloseAsClaimer(activeReport, viewerUserUuid);
  const canConfirmDecision = canEditSanctions && hasSelectedSanctions(sanctionDraft);

  const updateQueue = useCallback((queue: QueueAccumulator) => {
    setQueueOutcome({ key: queueRequestKey, value: { kind: "ok", queue } });
  }, [queueRequestKey]);

  useEffect(() => {
    initGovApiClient();
    let cancelled = false;

    loadInitialQueue(deps).then(
      (value) => {
        if (!cancelled) setQueueOutcome({ key: queueRequestKey, value });
      },
      (error: unknown) => {
        if (cancelled) return;
        const failure = toFrankingFailure(error);
        if (failure) {
          setQueueOutcome({ key: queueRequestKey, value: { kind: "refusal", failure } });
          return;
        }
        setQueueOutcome({
          key: queueRequestKey,
          value: {
            kind: "refusal",
            failure: {
              reason: "unknown",
              status: 0,
              message: "Не удалось загрузить очередь модерации.",
            },
          },
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [deps, queueRequestKey]);

  useEffect(() => {
    if (!activeUuid) {
      return;
    }

    initGovApiClient();
    let cancelled = false;

    refreshReportMeta(deps, activeUuid)
      .then((report) => {
        if (!cancelled) setSelectedReport(report);
      })
      .catch(() => {
        if (!cancelled) setSelectedReport(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeUuid, detailReloadToken, deps]);

  const keysReady = Boolean(fscpMaterial?.agreementPrivateKey?.length);
  const disclosureIntent =
    isApplicationPage && activeReport
      ? resolveAnketaDisclosureIntent(activeReport.status, keysReady)
      : "idle";
  const disclosureKey = `${isApplicationPage ? "anketa" : "list"}:${activeUuid ?? "none"}:${activeReport?.status ?? ""}:${keysReady ? "keys" : "nokeys"}:${fscpBootstrapLoading ? "boot" : "idle"}`;
  const disclosureView = presentAnketaDisclosureView({
    intent: disclosureIntent,
    bootstrapLoading: fscpBootstrapLoading,
    keysReady,
    fetched: fetchedDisclosure,
    fetchKey: disclosureKey,
  });

  useEffect(() => {
    if (disclosureIntent !== "fetch" || !activeReport) {
      return;
    }
    const agreementPrivateKey = fscpMaterial?.agreementPrivateKey;
    if (!agreementPrivateKey) {
      return;
    }

    const requestKey = disclosureKey;
    let cancelled = false;
    loadAnketaDisclosure({
      deps,
      report: activeReport,
      viewerUserUuid,
      agreementPrivateKey,
    }).then(
      (view) => {
        if (!cancelled) setFetchedDisclosure({ key: requestKey, view });
      },
      () => {
        if (!cancelled) {
          setFetchedDisclosure({
            key: requestKey,
            view: { phase: "error", message: "Не удалось раскрыть сообщение." },
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    disclosureIntent,
    activeReport,
    fscpMaterial,
    viewerUserUuid,
    deps,
    disclosureKey,
  ]);

  const handleLoadMore = () => {
    if (queueView.phase !== "ready" || appendBusy) return;
    setAppendBusy(true);
    appendQueuePage(deps, queueView.queue)
      .then((outcome) => {
        if (outcome.kind === "refusal") {
          setQueueOutcome({ key: queueRequestKey, value: outcome });
          return;
        }
        if (outcome.kind === "ok" || outcome.kind === "noop") {
          updateQueue(outcome.queue);
        }
      })
      .finally(() => setAppendBusy(false));
  };

  const applyReportUpdate = (
    report: FrankingReportMetaDto,
    nextFilter?: ModerationQueueFilter,
    nextView?: "list" | "anketa",
  ) => {
    if (queueView.phase === "ready") {
      updateQueue(mergeReportIntoQueue(queueView.queue, report));
    }
    if (nextFilter) setQueueFilter(nextFilter);
    if (nextView) setViewMode(nextView);
    setSelectedUuid(report.reportUuid);
    setSelectedReport(report);
    setRowErrors((prev) => {
      if (!prev[report.reportUuid]) return prev;
      const next = { ...prev };
      delete next[report.reportUuid];
      return next;
    });
    setDetailReloadToken((value) => value + 1);
  };

  const runAction = (
    reportUuid: string,
    action: "claim" | "release" | "resolve" | "reject",
    draftForResolve?: SanctionDraft,
  ) => {
    setActionBusy(`${reportUuid}:${action}`);
    const dispatch =
      action === "claim"
        ? dispatchClaimReport(deps, reportUuid)
        : action === "release"
          ? dispatchReleaseReport(deps, reportUuid)
          : dispatchResolveReport(
              deps,
              reportUuid,
              action === "reject" ? "rejected" : "resolved",
              action === "reject"
                ? undefined
                : sanctionDraftToAccountBlock(draftForResolve ?? emptySanctionDraft()),
            );

    dispatch
      .then((outcome) => {
        if (outcome.kind === "ok") {
          setSanctionDrafts((prev) => {
            if (!(reportUuid in prev)) return prev;
            const next = { ...prev };
            delete next[reportUuid];
            return next;
          });
          if (action === "claim") {
            applyReportUpdate(outcome.report, "mine", "anketa");
            return;
          }
          if (action === "release") {
            applyReportUpdate(outcome.report, "open", "list");
            return;
          }
          applyReportUpdate(outcome.report, "closed", "anketa");
          return;
        }
        if (outcome.kind === "pageFailure") {
          setQueueOutcome({ key: queueRequestKey, value: { kind: "refusal", failure: outcome.failure } });
          return;
        }
        setRowErrors((prev) => ({ ...prev, [reportUuid]: outcome.failure.message }));
      })
      .finally(() => setActionBusy(null));
  };

  const handleSelect = (report: FrankingReportMetaDto) => {
    setSelectedUuid(report.reportUuid);
    setSelectedReport(report);
    setDetailReloadToken((value) => value + 1);
  };

  const handleSelectSidebarReport = (
    filter: ModerationQueueFilter,
    report: FrankingReportMetaDto,
  ) => {
    setQueueFilter(filter);
    setViewMode("anketa");
    handleSelect(report);
  };

  const handleSelectFilter = (filter: ModerationQueueFilter) => {
    setQueueFilter(filter);
    setViewMode("list");
    const nextVisible = filterQueueItems(readyItems, filter, viewerUserUuid);
    setSelectedUuid((current) =>
      current && nextVisible.some((item) => item.reportUuid === current)
        ? current
        : (nextVisible[0]?.reportUuid ?? null),
    );
    setSelectedReport((current) =>
      current && nextVisible.some((item) => item.reportUuid === current.reportUuid)
        ? current
        : (nextVisible[0] ?? null),
    );
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.visuallyHidden}>Модерация</h1>

      <nav className={styles.sidebar} aria-label="Очереди">
        {MODERATION_QUEUE_FILTERS.map((item) => {
          const children = item.id === "mine" ? mineReports : item.id === "closed" ? closedReports : [];
          const parentActive =
            queueFilter === item.id && (item.id === "open" || !isApplicationPage);
          return (
            <div key={item.id} className={styles.sidebarGroup}>
              <button
                type="button"
                className={parentActive ? `${styles.sidebarLink} ${styles.sidebarLinkActive}` : styles.sidebarLink}
                aria-current={parentActive ? "true" : undefined}
                aria-expanded={children.length > 0 ? true : undefined}
                onClick={() => handleSelectFilter(item.id)}
              >
                {item.label}
              </button>
              {children.length > 0 ? (
                <ul className={styles.sidebarTree}>
                  {children.map((report, index) => {
                    const childActive =
                      isApplicationPage && queueFilter === item.id && selectedUuid === report.reportUuid;
                    return (
                      <li key={report.reportUuid} className={styles.sidebarNode}>
                        <SidebarTwig continues={index < children.length - 1} />
                        <button
                          type="button"
                          className={
                            childActive
                              ? `${styles.sidebarLink} ${styles.sidebarChild} ${styles.sidebarLinkActive}`
                              : `${styles.sidebarLink} ${styles.sidebarChild}`
                          }
                          aria-current={childActive ? "true" : undefined}
                          onClick={() => handleSelectSidebarReport(item.id, report)}
                        >
                          {labelFrankingCategory(report.category)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>

      {queueView.phase === "loading" ? (
        <p className={styles.notice} role="status">
          Загружаем очередь.
        </p>
      ) : null}

      {queueView.phase === "refusal" ? (
        <div className={styles.refusal} role="alert">
          <p className={styles.notice}>{queueView.message}</p>
          <button type="button" className={styles.ghost} onClick={() => setReloadToken((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : null}

      {queueView.phase === "ready" && visibleItems.length === 0 && !activeReport ? (
        <p className={styles.notice}>Жалоб нет.</p>
      ) : null}

      {queueView.phase === "ready" && isApplicationPage && activeReport ? (
        <div className={styles.workspaceSolo}>
          <ReportDetail
            report={activeReport}
            viewerUserUuid={viewerUserUuid}
            showComplaintSummary
            confirmEnabled={canConfirmDecision}
            disclosureView={disclosureView}
            onUnlockKeys={openFscpUnlock}
            actionBusy={actionBusy}
            rowError={rowErrors[activeReport.reportUuid]}
            onClaim={() => runAction(activeReport.reportUuid, "claim")}
            onReject={() => runAction(activeReport.reportUuid, "reject")}
            onConfirm={() => runAction(activeReport.reportUuid, "resolve", sanctionDraft)}
            onRelease={() => runAction(activeReport.reportUuid, "release")}
          />
          <SanctionMatrix
            draft={sanctionDraft}
            disabled={!canEditSanctions || actionBusy !== null}
            onChange={(draft) => {
              setSanctionDrafts((prev) => ({
                ...prev,
                [activeReport.reportUuid]: draft,
              }));
            }}
          />
        </div>
      ) : null}

      {queueView.phase === "ready" && !isApplicationPage && visibleItems.length > 0 ? (
        <div className={styles.workspace}>
          <div className={styles.queue}>
            <ul className={styles.queueList}>
              {visibleItems.map((report) => {
                const active = activeReport?.reportUuid === report.reportUuid;
                const rowError = rowErrors[report.reportUuid];
                return (
                  <li
                    key={report.reportUuid}
                    className={active ? `${styles.queueItem} ${styles.queueItemActive}` : styles.queueItem}
                  >
                    <button
                      type="button"
                      className={styles.queueButton}
                      aria-current={active ? "true" : undefined}
                      onClick={() => handleSelect(report)}
                    >
                      <span className={styles.queueCategory}>{labelFrankingCategory(report.category)}</span>
                      <span className={styles.queueArea}>{labelFrankingArea()}</span>
                      <span className={styles.queueMeta}>{queueMetaLine(report)}</span>
                    </button>
                    {rowError ? (
                      <p className={styles.rowError} role="alert">
                        {rowError}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {queueFilter !== "closed" && queueView.queue.hasMore ? (
              <button
                type="button"
                className={styles.ghost}
                disabled={appendBusy}
                onClick={handleLoadMore}
              >
                {appendBusy ? "Загружаем" : "Показать ещё"}
              </button>
            ) : null}
          </div>

          {activeReport ? (
            <ReportDetail
              report={activeReport}
              viewerUserUuid={viewerUserUuid}
              actionBusy={actionBusy}
              onClaim={() => runAction(activeReport.reportUuid, "claim")}
              onReject={() => runAction(activeReport.reportUuid, "reject")}
              onConfirm={() => runAction(activeReport.reportUuid, "resolve", sanctionDraft)}
              onRelease={() => runAction(activeReport.reportUuid, "release")}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SidebarTwig({ continues }: { continues: boolean }) {
  const height = continues ? 60 : 30;
  return (
    <svg
      className={styles.sidebarTwig}
      width={30}
      height={height}
      viewBox={`0 0 30 ${height}`}
      aria-hidden="true"
    >
      <path d="M 10 0 L 10 7 Q 10 15 18 15 L 24 15" />
      {continues ? <path d="M 10 15 L 10 60" /> : null}
    </svg>
  );
}

type ReportDetailProps = {
  report: FrankingReportMetaDto;
  viewerUserUuid: string | null;
  showComplaintSummary?: boolean;
  confirmEnabled?: boolean;
  disclosureView?: AnketaDisclosureView;
  onUnlockKeys?: () => void;
  actionBusy: string | null;
  rowError?: string;
  onClaim: () => void;
  onReject: () => void;
  onConfirm: () => void;
  onRelease: () => void;
};

function ReportDetail({
  report,
  viewerUserUuid,
  showComplaintSummary = false,
  confirmEnabled = false,
  disclosureView,
  onUnlockKeys,
  actionBusy,
  rowError,
  onClaim,
  onReject,
  onConfirm,
  onRelease,
}: ReportDetailProps) {
  const busyKey = (action: string) => actionBusy === `${report.reportUuid}:${action}`;
  const canClaim = canClaimReport(report.status);
  const canClose = canCloseAsClaimer(report, viewerUserUuid);
  const canRelease = canReleaseAsClaimer(report, viewerUserUuid);

  return (
    <section className={styles.detail} aria-label={labelFrankingCategory(report.category)}>
      <div className={styles.detailHeading}>
        <h2 className={styles.detailTitle}>{labelFrankingCategory(report.category)}</h2>
        <p className={styles.detailArea}>{labelFrankingArea()}</p>
      </div>
      <p className={styles.detailMeta}>{queueMetaLine(report)}</p>

      {showComplaintSummary ? (
        <dl className={styles.summaryList}>
          <div className={styles.summaryRow}>
            <dt>Заявитель</dt>
            <dd>{formatFrankingHandle(report.reporterUsername)}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Обвиняемый</dt>
            <dd>{formatFrankingHandle(report.accusedUsername)}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Раскрытие</dt>
            <dd>{labelHasDisclosure(report.hasDisclosure)}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Верификация</dt>
            <dd>{labelFrankingVerification(report.verificationStatus)}</dd>
          </div>
        </dl>
      ) : null}

      {showComplaintSummary ? (
        <DisclosureSection
          view={disclosureView}
          senderHandle={formatFrankingHandle(report.accusedUsername)}
          senderLetters={frankingPeerAvatarLetters(report.accusedUsername)}
          onUnlockKeys={onUnlockKeys}
        />
      ) : null}

      {rowError ? (
        <p className={styles.rowError} role="alert">
          {rowError}
        </p>
      ) : null}

      {canClaim || canClose || canRelease ? (
        <div className={styles.actions}>
          {canClaim ? (
            <button
              type="button"
              className={styles.primary}
              disabled={busyKey("claim")}
              onClick={onClaim}
            >
              {busyKey("claim") ? "Принимаем" : "Принять"}
            </button>
          ) : null}
          {canClose && showComplaintSummary ? (
            <button
              type="button"
              className={styles.primary}
              disabled={busyKey("resolve") || !confirmEnabled}
              onClick={onConfirm}
            >
              {busyKey("resolve") ? "Подтверждаем" : "Подтвердить решение"}
            </button>
          ) : null}
          {canClose ? (
            <button
              type="button"
              className={styles.danger}
              disabled={busyKey("reject")}
              onClick={onReject}
            >
              {busyKey("reject") ? "Отклоняем" : "Отклонить заявление"}
            </button>
          ) : null}
          {canRelease ? (
            <button
              type="button"
              className={styles.actionGhost}
              disabled={busyKey("release")}
              onClick={onRelease}
            >
              {busyKey("release") ? "Освобождаем" : "Освободить"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DisclosureSection({
  view,
  senderHandle,
  senderLetters,
  onUnlockKeys,
}: {
  view?: AnketaDisclosureView;
  senderHandle: string;
  senderLetters: string;
  onUnlockKeys?: () => void;
}) {
  if (!view || view.phase === "idle") return null;

  if (view.phase === "loading") {
    return (
      <div className={styles.disclosure} aria-busy="true">
        <p className={styles.disclosureStatus}>Загружаем раскрытие.</p>
      </div>
    );
  }

  if (view.phase === "waiting") {
    return (
      <div className={styles.disclosure}>
        <p className={styles.disclosureStatus}>{DISCLOSURE_WAITING_COPY}</p>
      </div>
    );
  }

  if (view.phase === "unlock") {
    return (
      <div className={styles.disclosure}>
        <p className={styles.disclosureStatus}>{DISCLOSURE_UNLOCK_COPY}</p>
        {onUnlockKeys ? (
          <button type="button" className={styles.ghost} onClick={onUnlockKeys}>
            Разблокировать ключи
          </button>
        ) : null}
      </div>
    );
  }

  if (view.phase === "mismatch" || view.phase === "error") {
    return (
      <div className={styles.disclosure}>
        <p className={styles.rowError} role="alert">
          {view.message}
        </p>
      </div>
    );
  }

  const blocks = view.result.blocks;
  return (
    <div className={styles.disclosure}>
      {blocks && blocks.length > 0 ? (
        <div className={styles.chat} aria-label={`Сообщение от ${senderHandle}`}>
          <div className={styles.chatAvatar} aria-hidden>
            {senderLetters}
          </div>
          <div className={styles.chatBubble}>
            {blocks.map((block, index) => (
              <p
                key={`${block.kind}-${index}`}
                className={block.kind === "text" ? styles.chatText : styles.chatMedia}
              >
                {labelFrankingReviewedBlock(block)}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <p className={styles.disclosureStatus}>Текст недоступен.</p>
      )}
    </div>
  );
}
