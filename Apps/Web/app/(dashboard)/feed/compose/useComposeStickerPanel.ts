"use client";

import { useCallback, useEffect, useState } from "react";
import { floraDurationMs } from "@/lib/floraMotion";

export type ComposeStickerPanelTab = "emoji" | "stickers";
export type ComposeStickerTabTransition = null | "toEmoji" | "toStickers";

const STICKER_PANEL_CLOSE_MS = floraDurationMs(2) + 50;
const STICKER_TAB_TRANSITION_MS = floraDurationMs(2);

export function useComposeStickerPanel(requestCloseAttachMenu: () => void) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [tab, setTab] = useState<ComposeStickerPanelTab>("emoji");
  const [tabTransition, setTabTransition] = useState<ComposeStickerTabTransition>(null);
  const [tabAnimEpoch, setTabAnimEpoch] = useState(0);

  const requestClose = useCallback(() => {
    if (!rendered || closing) return;
    setTabTransition(null);
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(false);
      setRendered(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    setOpen(false);
  }, [rendered, closing]);

  const selectTab = useCallback(
    (next: ComposeStickerPanelTab) => {
      if (next === tab || closing) return;
      const reduced =
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduced) {
        setTabTransition(next === "emoji" ? "toEmoji" : "toStickers");
        setTabAnimEpoch((epoch) => epoch + 1);
        window.setTimeout(() => setTabTransition(null), STICKER_TAB_TRANSITION_MS);
      }
      setTab(next);
    },
    [tab, closing],
  );

  const toggle = useCallback(() => {
    if (closing) return;
    if (rendered) {
      requestClose();
      return;
    }
    requestCloseAttachMenu();
    setRendered(true);
    setOpen(true);
    setClosing(false);
  }, [closing, rendered, requestClose, requestCloseAttachMenu]);

  useEffect(() => {
    if (!closing) return;
    const timeoutId = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, STICKER_PANEL_CLOSE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [closing]);

  return {
    open,
    rendered,
    closing,
    tab,
    tabTransition,
    tabAnimEpoch,
    requestClose,
    selectTab,
    toggle,
  };
}
