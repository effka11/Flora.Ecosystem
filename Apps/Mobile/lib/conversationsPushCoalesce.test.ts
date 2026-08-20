import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATIONS_PUSH_COALESCE_FOCUSED_MS,
  CONVERSATIONS_PUSH_COALESCE_MS,
  __resetConversationsPushCoalesce,
  scheduleConversationsPushRefresh,
  setConversationsListFocused,
} from "./conversationsPushCoalesce";
import { __resetScrollActivity, setScrollActivity } from "./scrollActivity";

describe("conversationsPushCoalesce", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetConversationsPushCoalesce();
    __resetScrollActivity();
    queryClient = new QueryClient();
    vi.spyOn(queryClient, "refetchQueries").mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    __resetConversationsPushCoalesce();
    __resetScrollActivity();
    vi.useRealTimers();
  });

  it("does not refetch before the default 400ms delay", () => {
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS - 1);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
  });

  it("refetches conversations and groups after 400ms by default", () => {
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(2);
    expect(queryClient.refetchQueries).toHaveBeenNthCalledWith(1, { queryKey: ["conversations"] });
    expect(queryClient.refetchQueries).toHaveBeenNthCalledWith(2, { queryKey: ["groups"] });
  });

  it("resets the timer when scheduled again before fire", () => {
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS - 50);
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS - 50);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(2);
  });

  it("uses 100ms when the conversations list is focused", () => {
    setConversationsListFocused(true);
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_FOCUSED_MS - 1);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(2);
  });

  it("default focused is false even after a previous focused schedule", () => {
    setConversationsListFocused(true);
    __resetConversationsPushCoalesce();
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_FOCUSED_MS);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(
      CONVERSATIONS_PUSH_COALESCE_MS - CONVERSATIONS_PUSH_COALESCE_FOCUSED_MS,
    );
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(2);
  });

  it("__reset clears a pending timer so it never fires", () => {
    scheduleConversationsPushRefresh(queryClient);
    __resetConversationsPushCoalesce();
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
  });

  it("does not refetch on the timer while scroll is busy; fires after settle", () => {
    const owner = Symbol("coalesce-scroll");
    setScrollActivity(owner, "drag", true);
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    setScrollActivity(owner, "drag", false);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(2);
  });

  it("a new schedule while waiting for idle restarts the debounce", () => {
    const owner = Symbol("coalesce-scroll");
    setScrollActivity(owner, "drag", true);
    scheduleConversationsPushRefresh(queryClient);
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS);
    scheduleConversationsPushRefresh(queryClient);
    setScrollActivity(owner, "drag", false);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CONVERSATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(2);
  });
});
