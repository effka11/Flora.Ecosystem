"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FLORA_COMPOSE_STICKER_PANEL_ATTR,
  measureComposeStickerPanelPosition,
} from "@/app/_shared/floraRectMenuOverlay";
import {
  MessageStickerPanel,
  type StickerPanelTab,
  type StickerTabTransition,
} from "@/app/(dashboard)/messages/MessageStickerPanel";
import composeStyles from "./compose.module.css";
import { useComposePopoverPanelPosition } from "./useComposePopoverPanelPosition";
import { floraDurationMs } from "@/lib/floraMotion";
import type { RefObject } from "react";

/** Чуть больше --flora-duration-2, чтобы гарантированно дождаться конца анимации входа. */
const OPEN_ANIM_DONE_MS = floraDurationMs(2) + 30;

type ComposeStickerPanelProps = {
  panelId: string;
  triggerRef: RefObject<HTMLElement | null>;
  alignSurfaceRef: RefObject<HTMLElement | null>;
  fieldAnchorRef: RefObject<HTMLElement | null>;
  visibleRows: number;
  rendered: boolean;
  open: boolean;
  closing: boolean;
  tab: StickerPanelTab;
  tabTransition: StickerTabTransition;
  tabAnimEpoch: number;
  onPickEmoji: (emoji: string) => void;
  onSelectTab: (tab: StickerPanelTab) => void;
};

export function ComposeStickerPanel({
  panelId,
  triggerRef,
  alignSurfaceRef,
  fieldAnchorRef,
  visibleRows,
  rendered,
  open,
  closing,
  tab,
  tabTransition,
  tabAnimEpoch,
  onPickEmoji,
  onSelectTab,
}: ComposeStickerPanelProps) {
  const [portalReady, setPortalReady] = useState(false);
  /** true — анимация открытия уже сыграла; блокирует её повтор при FLIP-цикле. */
  const [openAnimDone, setOpenAnimDone] = useState(false);
  const openAnimTimerRef = useRef<number | null>(null);

  const panelMounted = rendered && (open || closing);

  const resolvePanelEl = useCallback(() => document.getElementById(panelId), [panelId]);

  const { panelPos, lifted, liftAnimating } = useComposePopoverPanelPosition({
    panelMounted,
    hostRef: alignSurfaceRef,
    triggerRef,
    fieldAnchorRef,
    visibleRows,
    resolvePanelEl,
    measure: measureComposeStickerPanelPosition,
  });

  useEffect(() => {
    setPortalReady(true);
  }, []);

  // Сброс флага при закрытии, чтобы при следующем открытии анимация сыграла снова.
  useEffect(() => {
    if (!panelMounted) {
      setOpenAnimDone(false);
      if (openAnimTimerRef.current !== null) {
        window.clearTimeout(openAnimTimerRef.current);
        openAnimTimerRef.current = null;
      }
      return;
    }
    // Запускаем таймер сразу при монтировании панели.
    openAnimTimerRef.current = window.setTimeout(() => {
      openAnimTimerRef.current = null;
      setOpenAnimDone(true);
    }, OPEN_ANIM_DONE_MS);
    return () => {
      if (openAnimTimerRef.current !== null) {
        window.clearTimeout(openAnimTimerRef.current);
        openAnimTimerRef.current = null;
      }
    };
  }, [panelMounted]);

  if (!rendered) return null;

  const panelClassName = [
    composeStyles.composeStickerPanelDetached,
    openAnimDone      ? composeStyles.composeStickerPanelOpenDone  : "",
    closing           ? composeStyles.composeStickerPanelClosing   : "",
    liftAnimating     ? composeStyles.composePopoverLiftAnimating  : "",
  ]
    .filter(Boolean)
    .join(" ");

  const panel = panelMounted ? (
    <MessageStickerPanel
      panelId={panelId}
      active={open && !closing}
      closing={closing}
      layoutMotion={rendered && !closing}
      tab={tab}
      tabTransition={tabTransition}
      tabAnimEpoch={tabAnimEpoch}
      onPickEmoji={onPickEmoji}
      onSelectTab={onSelectTab}
      panelClassName={panelClassName}
      panelStyle={panelPos ?? undefined}
      panelAttr={FLORA_COMPOSE_STICKER_PANEL_ATTR}
      panelLifted={lifted}
    />
  ) : null;

  return portalReady && panel ? createPortal(panel, document.body) : null;
}
