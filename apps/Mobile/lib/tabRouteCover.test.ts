import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetTabRouteCoverHandler,
  isHamburgerTabPathActive,
  registerTabRouteCoverHandler,
  registerTabRouteRevealHandler,
  requestTabRouteCover,
  requestTabRouteReveal,
  shouldCoverTabSwitch,
  tabNameFromHamburgerTarget,
} from "./tabRouteCover";

describe("tabNameFromHamburgerTarget", () => {
  it("parses grouped tab hrefs", () => {
    expect(tabNameFromHamburgerTarget("/(tabs)/people")).toBe("people");
    expect(tabNameFromHamburgerTarget("/(tabs)/communities")).toBe("communities");
    expect(tabNameFromHamburgerTarget("/(tabs)/contribute")).toBe("contribute");
  });

  it("parses settings account push pathname + params", () => {
    expect(tabNameFromHamburgerTarget("/(tabs)/settings")).toBe("settings");
    expect(
      tabNameFromHamburgerTarget({
        pathname: "/(tabs)/settings",
        params: { section: "account" },
      }),
    ).toBe("settings");
  });

  it("is null for non-hamburger tabs", () => {
    expect(tabNameFromHamburgerTarget("/(tabs)/feed")).toBeNull();
    expect(tabNameFromHamburgerTarget("/(tabs)/music")).toBeNull();
    expect(tabNameFromHamburgerTarget("/")).toBeNull();
  });
});

describe("shouldCoverTabSwitch", () => {
  it("covers when the target tab name differs", () => {
    expect(shouldCoverTabSwitch("feed", "people")).toBe(true);
    expect(shouldCoverTabSwitch("people", "settings")).toBe(true);
    expect(shouldCoverTabSwitch(undefined, "people")).toBe(true);
  });

  it("does not cover the already active tab", () => {
    expect(shouldCoverTabSwitch("people", "people")).toBe(false);
    expect(shouldCoverTabSwitch("settings", "settings")).toBe(false);
  });
});

describe("isHamburgerTabPathActive", () => {
  it("is true on the tab root and nested routes", () => {
    expect(isHamburgerTabPathActive("/people", "people")).toBe(true);
    expect(isHamburgerTabPathActive("/settings/account", "settings")).toBe(true);
  });

  it("is false on another tab", () => {
    expect(isHamburgerTabPathActive("/feed", "people")).toBe(false);
    expect(isHamburgerTabPathActive("/people", "settings")).toBe(false);
  });
});

describe("requestTabRouteCover", () => {
  afterEach(() => {
    __resetTabRouteCoverHandler();
  });

  it("forwards to the registered handler", () => {
    const handler = vi.fn();
    registerTabRouteCoverHandler(handler);
    requestTabRouteCover("people");
    expect(handler).toHaveBeenCalledWith("people");
  });

  it("is a no-op without a handler", () => {
    expect(() => requestTabRouteCover("people")).not.toThrow();
  });
});

describe("requestTabRouteReveal", () => {
  afterEach(() => {
    __resetTabRouteCoverHandler();
  });

  it("forwards to the registered handler", () => {
    const handler = vi.fn();
    registerTabRouteRevealHandler(handler);
    requestTabRouteReveal();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("is a no-op without a handler", () => {
    expect(() => requestTabRouteReveal()).not.toThrow();
  });
});
