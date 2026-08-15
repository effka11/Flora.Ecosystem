import { describe, expect, it } from "vitest";
import {
  createPagerBusyState,
  isPagerBusy,
  reducePagerBusy,
} from "./pagerBusyFlags";

describe("reducePagerBusy", () => {
  it("reportTouch(true) bumps epoch so go() sees pan before onEnd", () => {
    const next = reducePagerBusy(createPagerBusyState(), { type: "touch", active: true });
    expect(next.touch).toBe(true);
    expect(next.epoch).toBe(1);
    expect(next.pagerGen).toBe(0);
    expect(isPagerBusy(next)).toBe(true);
  });

  it("cancel + new reportPager(true) keeps busy", () => {
    let state = createPagerBusyState();
    state = reducePagerBusy(state, { type: "pager", active: true });
    const firstGen = state.pagerGen;
    state = reducePagerBusy(state, { type: "pager", active: true });
    const secondGen = state.pagerGen;
    expect(secondGen).toBe(firstGen + 1);
    state = reducePagerBusy(state, { type: "pager", active: false, gen: firstGen });
    expect(state.pager).toBe(true);
    expect(state.pagerGen).toBe(secondGen);
    expect(isPagerBusy(state)).toBe(true);
  });

  it("mismatch with stale gen leaves pager true", () => {
    let state = reducePagerBusy(createPagerBusyState(), { type: "pager", active: true });
    state = reducePagerBusy(state, { type: "pager", active: true });
    const current = state.pagerGen;
    state = reducePagerBusy(state, { type: "pager", active: false, gen: current - 1 });
    expect(state.pager).toBe(true);
    expect(isPagerBusy(state)).toBe(true);
  });

  it("mismatch without a new gesture (same gen) clears pager", () => {
    let state = reducePagerBusy(createPagerBusyState(), { type: "pager", active: true });
    const gen = state.pagerGen;
    state = reducePagerBusy(state, { type: "pager", active: false, gen });
    expect(state.pager).toBe(false);
    expect(isPagerBusy(state)).toBe(false);
  });

  it("onFinalize after success clears touch; pager follows settle", () => {
    let state = reducePagerBusy(createPagerBusyState(), { type: "touch", active: true });
    state = reducePagerBusy(state, { type: "pager", active: true });
    const gen = state.pagerGen;
    state = reducePagerBusy(state, { type: "touch", active: false });
    expect(state.touch).toBe(false);
    expect(state.pager).toBe(true);
    expect(isPagerBusy(state)).toBe(true);
    state = reducePagerBusy(state, { type: "pager", active: false, gen });
    expect(state.pager).toBe(false);
    expect(isPagerBusy(state)).toBe(false);
  });

  it("strip cancel does not clear strip while pager owns the screen", () => {
    let state = reducePagerBusy(createPagerBusyState(), { type: "strip", active: true });
    state = reducePagerBusy(state, { type: "pager", active: true });
    const gen = state.pagerGen;
    state = reducePagerBusy(state, { type: "strip", active: false, cancel: true });
    expect(state.strip).toBe(true);
    expect(state.stripCancelPending).toBe(true);
    expect(isPagerBusy(state)).toBe(true);
    state = reducePagerBusy(state, { type: "pager", active: false, gen });
    expect(state.pager).toBe(false);
    expect(state.strip).toBe(false);
    expect(isPagerBusy(state)).toBe(false);
  });

  it("strip decay still holds busy after pager settle until strip end", () => {
    let state = reducePagerBusy(createPagerBusyState(), { type: "strip", active: true });
    state = reducePagerBusy(state, { type: "pager", active: true });
    const gen = state.pagerGen;
    state = reducePagerBusy(state, { type: "pager", active: false, gen });
    expect(state.pager).toBe(false);
    expect(state.strip).toBe(true);
    expect(isPagerBusy(state)).toBe(true);
    state = reducePagerBusy(state, { type: "strip", active: false });
    expect(state.strip).toBe(false);
    expect(isPagerBusy(state)).toBe(false);
  });
});
