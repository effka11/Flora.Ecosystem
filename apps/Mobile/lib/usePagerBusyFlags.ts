import { useCallback, useEffect, useRef } from "react";
import {
  createPagerBusyState,
  isPagerBusy,
  reducePagerBusy,
  type PagerBusyState,
} from "@/lib/pagerBusyFlags";
import {
  clearScrollActivityOwner,
  setPagerBusyActivity,
} from "@/lib/scrollActivity";

/**
 * Репортёры busy-флагов. `applyBusy` — обычно `setBusy` из useDeferredPagerMount.
 * Touch/pager/strip also publish into `scrollActivity` so idle tab preload
 * (and other settled waiters) see non-feed pager gestures.
 */
export function usePagerBusyFlags(applyBusy?: (busy: boolean) => void): {
  reportTouch: (active: boolean) => void;
  reportPager: (active: boolean, gen?: number) => number;
  reportStrip: (active: boolean, cancel?: boolean) => void;
  getEpoch: () => number;
  isBusy: () => boolean;
} {
  const owner = useRef(Symbol("pager-busy")).current;
  const stateRef = useRef<PagerBusyState>(createPagerBusyState());
  const applyRef = useRef(applyBusy);
  applyRef.current = applyBusy;

  useEffect(() => () => clearScrollActivityOwner(owner), [owner]);

  const publish = useCallback(
    (next: PagerBusyState) => {
      stateRef.current = next;
      setPagerBusyActivity(owner, {
        touch: next.touch,
        pager: next.pager,
        strip: next.strip,
      });
      applyRef.current?.(isPagerBusy(next));
    },
    [owner],
  );

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
