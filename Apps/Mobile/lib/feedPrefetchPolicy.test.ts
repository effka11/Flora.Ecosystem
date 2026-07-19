import { describe, expect, it } from "vitest";
import {
  canAttachToTail,
  shouldAttachStaged,
  shouldStartPrefetch,
  type PrefetchGateInput,
} from "./feedPrefetchPolicy";

const allow: PrefetchGateInput = {
  isActivePane: true,
  isSearching: false,
  hasNextPage: true,
  isFetching: false,
  isStaging: false,
  hasStagedForTail: false,
  networkAllowsPrefetch: true,
};

describe("shouldStartPrefetch", () => {
  it("allows when all gates are open", () => {
    expect(shouldStartPrefetch(allow)).toBe(true);
  });

  it.each([
    ["inactive pane", { isActivePane: false }],
    ["searching", { isSearching: true }],
    ["no next page", { hasNextPage: false }],
    ["already fetching", { isFetching: true }],
    ["already staging", { isStaging: true }],
    ["staged for tail", { hasStagedForTail: true }],
    ["network disallows", { networkAllowsPrefetch: false }],
  ])("blocks when %s", (_label, override) => {
    expect(shouldStartPrefetch({ ...allow, ...(override as Partial<PrefetchGateInput>) })).toBe(false);
  });
});

describe("shouldAttachStaged", () => {
  it("never attaches without a staged page", () => {
    expect(shouldAttachStaged({ hasStagedPage: false, settled: true, force: true })).toBe(false);
  });

  it("attaches when settled", () => {
    expect(shouldAttachStaged({ hasStagedPage: true, settled: true, force: false })).toBe(true);
  });

  it("does not attach while moving unless forced (safety-net edge)", () => {
    expect(shouldAttachStaged({ hasStagedPage: true, settled: false, force: false })).toBe(false);
    expect(shouldAttachStaged({ hasStagedPage: true, settled: false, force: true })).toBe(true);
  });
});

describe("canAttachToTail", () => {
  it("requires the tail cursor to still match the staged request cursor", () => {
    expect(canAttachToTail("c1", "c1")).toBe(true);
    expect(canAttachToTail("c2", "c1")).toBe(false);
    expect(canAttachToTail(undefined, "c1")).toBe(false);
    expect(canAttachToTail("c1", undefined)).toBe(false);
  });
});
