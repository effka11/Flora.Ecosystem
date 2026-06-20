"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAnimatedModal } from "@/app/(dashboard)/communities/useAnimatedModal";
import {
  isDashboardNavHref,
  stripDashboardHref,
} from "@/app/_dashboard/dashboardRouteTransition";
import {
  performDashboardNavigation,
  setDashboardLeaveGuard,
  tryDashboardNavigation,
  type DashboardLeaveProceed,
} from "@/app/_dashboard/dashboardLeaveGuard";
import { useCommunitySettings } from "./CommunitySettingsContext";
import { CommunitySettingsLeaveModal } from "./CommunitySettingsLeaveModal";

function isInternalDashboardHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && isDashboardNavHref(href);
}

function isCommunitySettingsPath(path: string): boolean {
  return /^\/communities\/[^/]+\/settings$/.test(stripDashboardHref(path));
}

export function CommunitySettingsLeaveGuard() {
  const { hasUnsavedChanges, saveAll, discardChanges } = useCommunitySettings();
  const { open, closing, openModal, closeModal } = useAnimatedModal();

  const hasUnsavedRef = useRef(hasUnsavedChanges);
  hasUnsavedRef.current = hasUnsavedChanges;

  const pendingProceedRef = useRef<DashboardLeaveProceed | null>(null);
  const pendingHrefRef = useRef<string | null>(null);
  const leaveBusyRef = useRef(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const resetLeaveDialog = useCallback(() => {
    pendingProceedRef.current = null;
    pendingHrefRef.current = null;
    leaveBusyRef.current = false;
    setLeaveBusy(false);
    setLeaveError(null);
  }, []);

  const closeLeaveDialog = useCallback(() => {
    if (leaveBusyRef.current) return;
    resetLeaveDialog();
    closeModal();
  }, [closeModal, resetLeaveDialog]);

  const completeLeave = useCallback(() => {
    const proceed = pendingProceedRef.current;
    const href = pendingHrefRef.current;
    resetLeaveDialog();
    closeModal();
    if (proceed) {
      proceed();
      return;
    }
    if (href) performDashboardNavigation(href);
  }, [closeModal, resetLeaveDialog]);

  const openLeaveDialog = useCallback(
    (targetHref: string, proceed: DashboardLeaveProceed) => {
      pendingHrefRef.current = targetHref;
      pendingProceedRef.current = proceed;
      setLeaveError(null);
      openModal();
    },
    [openModal],
  );

  useEffect(() => {
    setDashboardLeaveGuard({
      shouldBlock: () => hasUnsavedRef.current && isCommunitySettingsPath(window.location.pathname),
      onLeaveAttempt: (targetHref, proceed) => {
        openLeaveDialog(targetHref, proceed);
      },
    });
    return () => setDashboardLeaveGuard(null);
  }, [openLeaveDialog]);

  useEffect(() => {
    const onPointerDownCapture = (event: PointerEvent) => {
      if (!hasUnsavedRef.current) return;
      if (!isCommunitySettingsPath(window.location.pathname)) return;
      if (event.button !== 0) return;

      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href || !isInternalDashboardHref(href)) return;
      if (anchor.target === "_blank") return;

      const targetPath = stripDashboardHref(href);
      const currentPath = stripDashboardHref(window.location.pathname);
      if (targetPath === currentPath) return;

      event.preventDefault();
      event.stopPropagation();

      tryDashboardNavigation(href, () => performDashboardNavigation(href));
    };

    document.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => document.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, []);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  const onSaveAndLeave = useCallback(async () => {
    if (leaveBusyRef.current) return;
    leaveBusyRef.current = true;
    setLeaveBusy(true);
    setLeaveError(null);
    const result = await saveAll();
    leaveBusyRef.current = false;
    setLeaveBusy(false);
    if (result.ok) {
      completeLeave();
      return;
    }
    if (result.error) setLeaveError(result.error);
  }, [completeLeave, saveAll]);

  const onDiscardAndLeave = useCallback(() => {
    if (leaveBusyRef.current) return;
    discardChanges();
    completeLeave();
  }, [completeLeave, discardChanges]);

  return (
    <CommunitySettingsLeaveModal
      open={open}
      closing={closing}
      busy={leaveBusy}
      error={leaveError}
      onClose={closeLeaveDialog}
      onSave={() => void onSaveAndLeave()}
      onDiscard={onDiscardAndLeave}
    />
  );
}
