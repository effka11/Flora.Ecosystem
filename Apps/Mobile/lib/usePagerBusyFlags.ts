import { useCallback, useRef } from "react";
import {
  createPagerBusyState,
  isPagerBusy,
  reducePagerBusy,
  type PagerBusyState,
} from "@/lib/pagerBusyFlags";

/**
 * Репортёры busy-флагов. `applyBusy` — обычно `setBusy` из useDeferredPagerMount.
 */
export function usePagerBusyFlags(applyBusy?: (busy: boolean) => void): {
  reportTouch: (active: boolean) => void;
  reportPager: (active: boolean, gen?: number) => number;
  reportStrip: (active: boolean, cancel?: boolean) => void;
  getEpoch: () => number;
  isBusy: () => boolean;
} {
  const stateRef = useRef<PagerBusyState>(createPagerBusyState());
  const applyRef = useRef(applyBusy);
  applyRef.current = applyBusy;

  const publish = useCallback((next: PagerBusyState) => {
    stateRef.current = next;
    applyRef.current?.(isPagerBusy(next));
  }, []);

  const reportTouch = useCallback(
    (active: boolean) => {
      publish(reducePagerBusy(stateRef.current, { type: "touch", active }));
    },
    [publish],
  );

  const reportPager = useCallback(
    (active: boolean, gen?: number) => {
      const next = active
        ? reducePagerBusy(stateRef.current, { type: "pager", active: true })
        : reducePagerBusy(stateRef.current, { type: "pager", active: false, gen: gen ?? -1 });
      publish(next);
      return next.pagerGen;
    },
    [publish],
  );

  const reportStrip = useCallback(
    (active: boolean, cancel = false) => {
      publish(reducePagerBusy(stateRef.current, { type: "strip", active, cancel }));
    },
    [publish],
  );

  const getEpoch = useCallback(() => stateRef.current.epoch, []);
  const isBusy = useCallback(() => isPagerBusy(stateRef.current), []);

  return { reportTouch, reportPager, reportStrip, getEpoch, isBusy };
}

/** Полоса чипов: touch+strip на begin; strip end на decay/finalize success. */
export function bindChipStripBusy(
  reportTouch: (active: boolean) => void,
  reportStrip: (active: boolean, cancel?: boolean) => void,
  onBeginExtra?: () => void,
): {
  onChipPanBegin: () => void;
  onChipPanFinalize: (success: boolean) => void;
  onChipPanDecayEnd: () => void;
} {
  return {
    onChipPanBegin: () => {
      onBeginExtra?.();
      reportTouch(true);
      reportStrip(true);
    },
    onChipPanFinalize: (success) => {
      reportTouch(false);
      if (!success) reportStrip(false, true);
    },
    onChipPanDecayEnd: () => {
      reportStrip(false);
    },
  };
}
