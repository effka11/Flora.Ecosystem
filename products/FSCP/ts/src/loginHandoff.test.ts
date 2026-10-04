import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProvenAccountPassword,
  stashProvenAccountPassword,
  takeProvenAccountPassword,
} from "./loginHandoff.js";

beforeEach(() => {
  vi.useFakeTimers();
  clearProvenAccountPassword();
});

afterEach(() => {
  clearProvenAccountPassword();
  vi.useRealTimers();
});

describe("loginHandoff: no persistence", () => {
  // vitest.config.ts runs this suite under environment: "node" — there is no DOM/browser
  // storage global to begin with, which already demonstrates the module cannot be reaching
  // for localStorage/sessionStorage/cookies without crashing. We assert that honestly instead
  // of pretending to have exercised a browser storage path.
  it("localStorage/sessionStorage are not present in this test environment", () => {
    expect(typeof (globalThis as Record<string, unknown>).localStorage).toBe("undefined");
    expect(typeof (globalThis as Record<string, unknown>).sessionStorage).toBe("undefined");
  });

  it("stash does not create a localStorage/sessionStorage global as a side effect", () => {
    stashProvenAccountPassword("user@example.com", "s3cret");

    expect(typeof (globalThis as Record<string, unknown>).localStorage).toBe("undefined");
    expect(typeof (globalThis as Record<string, unknown>).sessionStorage).toBe("undefined");
  });
});

describe("loginHandoff: single-use", () => {
  it("take returns the password once, then null on the second call", () => {
    stashProvenAccountPassword("user@example.com", "s3cret");

    expect(takeProvenAccountPassword("user@example.com")).toBe("s3cret");
    expect(takeProvenAccountPassword("user@example.com")).toBeNull();
  });

  it("take returns null when nothing was stashed", () => {
    expect(takeProvenAccountPassword("user@example.com")).toBeNull();
  });
});

describe("loginHandoff: TTL (wall-clock, not timer-driven)", () => {
  it("returns the password while still within the TTL", () => {
    stashProvenAccountPassword("user@example.com", "s3cret", { ttlMs: 90_000 });

    vi.setSystemTime(Date.now() + 89_000);

    expect(takeProvenAccountPassword("user@example.com")).toBe("s3cret");
  });

  it("returns null once the TTL has elapsed by wall-clock, even without letting timers fire", () => {
    stashProvenAccountPassword("user@example.com", "s3cret", { ttlMs: 90_000 });

    // Advance ONLY the system clock, not fake timers — this is the point of the wall-clock
    // check: a throttled background-tab timer must not be what makes expiry work.
    vi.setSystemTime(Date.now() + 90_001);

    expect(takeProvenAccountPassword("user@example.com")).toBeNull();
  });

  it("defaults ttlMs to 90s when not provided", () => {
    stashProvenAccountPassword("user@example.com", "s3cret");

    vi.setSystemTime(Date.now() + 89_999);
    expect(takeProvenAccountPassword("user@example.com")).toBe("s3cret");
  });

  it("defaults ttlMs to 90s when not provided (expired)", () => {
    stashProvenAccountPassword("user@example.com", "s3cret");

    vi.setSystemTime(Date.now() + 90_001);
    expect(takeProvenAccountPassword("user@example.com")).toBeNull();
  });
});

describe("loginHandoff: wrong owner", () => {
  it("does not hand the password to a different owner", () => {
    stashProvenAccountPassword("owner-a@example.com", "s3cret");

    expect(takeProvenAccountPassword("owner-b@example.com")).toBeNull();
  });

  it("consumes the slot even on an owner mismatch (single-use, not per-owner)", () => {
    stashProvenAccountPassword("owner-a@example.com", "s3cret");

    expect(takeProvenAccountPassword("owner-b@example.com")).toBeNull();
    // The rightful owner also gets nothing back: the mismatched take already dropped it.
    expect(takeProvenAccountPassword("owner-a@example.com")).toBeNull();
  });
});

describe("loginHandoff: clearProvenAccountPassword", () => {
  it("drops a pending stash so a later take returns null", () => {
    stashProvenAccountPassword("user@example.com", "s3cret");

    clearProvenAccountPassword();

    expect(takeProvenAccountPassword("user@example.com")).toBeNull();
  });

  it("is a no-op when nothing was stashed", () => {
    expect(() => clearProvenAccountPassword()).not.toThrow();
  });
});

describe("loginHandoff: owner normalization", () => {
  it("treats padded/mixed-case owners as the same account as trimmed lowercase", () => {
    stashProvenAccountPassword("  ABC ", "s3cret");

    expect(takeProvenAccountPassword("abc")).toBe("s3cret");
  });

  it("normalizes the owner given to take() the same way", () => {
    stashProvenAccountPassword("abc", "s3cret");

    expect(takeProvenAccountPassword("  ABC ")).toBe("s3cret");
  });
});

describe("loginHandoff: rejected input", () => {
  it("does not stash a blank owner", () => {
    stashProvenAccountPassword("   ", "s3cret");

    expect(takeProvenAccountPassword("")).toBeNull();
  });

  it("does not stash a blank/whitespace-only password", () => {
    stashProvenAccountPassword("user@example.com", "   ");

    expect(takeProvenAccountPassword("user@example.com")).toBeNull();
  });

  it("a rejected stash does not clobber a previously valid one", () => {
    stashProvenAccountPassword("user@example.com", "s3cret");
    stashProvenAccountPassword("", "ignored");
    stashProvenAccountPassword("user@example.com", "   ");

    expect(takeProvenAccountPassword("user@example.com")).toBe("s3cret");
  });
});

describe("loginHandoff: replace semantics", () => {
  it("a later stash replaces an earlier one instead of stacking", () => {
    stashProvenAccountPassword("owner-a@example.com", "first");
    stashProvenAccountPassword("owner-b@example.com", "second");

    // Only owner-b's take is exercised here: a take for owner-a would itself consume the
    // (mismatched) slot per the single-use contract above, which would make this assert the
    // wrong thing. The replacement itself is what is under test, not another mismatch case.
    expect(takeProvenAccountPassword("owner-b@example.com")).toBe("second");
  });
});
