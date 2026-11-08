import { describe, expect, it, vi } from "vitest";
import {
  abandonChatPickActivity,
  beginChatPickActivity,
  endChatPickActivity,
  isChatPickActivityActive,
  resetChatPickActivityForTests,
  runAfterChatPickActivity,
} from "@/lib/chatPickActivity";

describe("chat pick activity gate", () => {
  it("runs work immediately when no picker is in front", () => {
    resetChatPickActivityForTests();
    const run = vi.fn();
    runAfterChatPickActivity(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds a destructive exit until the picker returns", () => {
    resetChatPickActivityForTests();
    beginChatPickActivity();
    const run = vi.fn();
    runAfterChatPickActivity(run);
    expect(isChatPickActivityActive()).toBe(true);
    expect(run).not.toHaveBeenCalled();
    endChatPickActivity();
    expect(isChatPickActivityActive()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps only the last decision: one thread exit, the freshest", () => {
    resetChatPickActivityForTests();
    beginChatPickActivity();
    const first = vi.fn();
    const second = vi.fn();
    runAfterChatPickActivity(first);
    runAfterChatPickActivity(second);
    endChatPickActivity();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not replay a consumed exit on the next picker", () => {
    resetChatPickActivityForTests();
    beginChatPickActivity();
    const run = vi.fn();
    runAfterChatPickActivity(run);
    endChatPickActivity();
    expect(run).toHaveBeenCalledTimes(1);
    beginChatPickActivity();
    endChatPickActivity();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops the deferred exit when the picker never returned", () => {
    resetChatPickActivityForTests();
    beginChatPickActivity();
    const run = vi.fn();
    runAfterChatPickActivity(run);
    abandonChatPickActivity();
    expect(isChatPickActivityActive()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    // Следующий пикер стартует с чистого листа.
    beginChatPickActivity();
    endChatPickActivity();
    expect(run).not.toHaveBeenCalled();
  });
});
