import { describe, expect, it } from "vitest";
import { accountRequiresKeyRestore } from "./bootstrap.js";

describe("accountRequiresKeyRestore", () => {
  it("requires restore when server already has a pubkey", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: true,
        e2eState: "not_initialized",
        hasKeyBackup: false,
      }),
    ).toBe(true);
  });

  it("requires restore when messaging E2E is initialized", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: false,
        e2eState: "active",
        hasKeyBackup: false,
      }),
    ).toBe(true);
  });

  it("requires restore when key backup exists on server", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: false,
        e2eState: "not_initialized",
        hasKeyBackup: true,
      }),
    ).toBe(true);
  });

  it("allows new identity only for a fresh account", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: false,
        e2eState: "not_initialized",
        hasKeyBackup: false,
      }),
    ).toBe(false);
  });
});
