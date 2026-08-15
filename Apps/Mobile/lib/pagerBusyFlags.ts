/**
 * Busy-guard пейджера: OR(touch, pager, strip) + поколение pager.
 * Не счётчик hold — cancel/mismatch сверяют pagerGen.
 */

export type PagerBusyState = {
  touch: boolean;
  pager: boolean;
  strip: boolean;
  pagerGen: number;
  epoch: number;
  /** Strip cancel while pager owns — drop strip when that pager gen clears. */
  stripCancelPending: boolean;
};

export type PagerBusyAction =
  | { type: "touch"; active: boolean }
  | { type: "pager"; active: true }
  | { type: "pager"; active: false; gen: number }
  | { type: "strip"; active: boolean; cancel?: boolean };

export function createPagerBusyState(): PagerBusyState {
  return {
    touch: false,
    pager: false,
    strip: false,
    pagerGen: 0,
    epoch: 0,
    stripCancelPending: false,
  };
}

export function isPagerBusy(state: PagerBusyState): boolean {
  return state.touch || state.pager || state.strip;
}

export function reducePagerBusy(state: PagerBusyState, action: PagerBusyAction): PagerBusyState {
  switch (action.type) {
    case "touch":
      return {
        ...state,
        touch: action.active,
        epoch: action.active ? state.epoch + 1 : state.epoch,
      };
    case "pager":
      if (action.active) {
        return {
          ...state,
          pager: true,
          pagerGen: state.pagerGen + 1,
          epoch: state.epoch + 1,
        };
      }
      if (action.gen !== state.pagerGen) return state;
      return {
        ...state,
        pager: false,
        strip: state.stripCancelPending ? false : state.strip,
        stripCancelPending: false,
      };
    case "strip":
      if (action.active) {
        return { ...state, strip: true, stripCancelPending: false };
      }
      if (action.cancel && state.pager) {
        return { ...state, stripCancelPending: true };
      }
      return { ...state, strip: false, stripCancelPending: false };
    default:
      return state;
  }
}
