import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATIONS_PUSH_COALESCE_FOCUSED_MS,
  NOTIFICATIONS_PUSH_COALESCE_MS,
  __resetNotificationsPushCoalesce,
  scheduleNotificationsPushRefresh,
  setNotificationsListFocused,
} from "./notificationsPushCoalesce";
import { __resetScrollActivity, setScrollActivity } from "./scrollActivity";

describe("notificationsPushCoalesce", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetNotificationsPushCoalesce();
    __resetScrollActivity();
    queryClient = new QueryClient();
    vi.spyOn(queryClient, "refetchQueries").mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    __resetNotificationsPushCoalesce();
    __resetScrollActivity();
    vi.useRealTimers();
  });

  it("does not refetch before the default 400ms delay", () => {
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS - 1);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
  });

  it("refetches only the notifications prefix after 400ms by default", () => {
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
    expect(queryClient.refetchQueries).toHaveBeenCalledWith({ queryKey: ["notifications"] });
  });

  it("coalesces a burst of signals into one refetch", () => {
    scheduleNotificationsPushRefresh(queryClient);
    scheduleNotificationsPushRefresh(queryClient);
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
  });

  it("resets the timer when scheduled again before fire", () => {
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS - 50);
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS - 50);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
  });

  it("uses 100ms when the notifications list is focused", () => {
    setNotificationsListFocused(true);
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_FOCUSED_MS - 1);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
  });

  it("default focused is false even after a previous focused schedule", () => {
    setNotificationsListFocused(true);
    __resetNotificationsPushCoalesce();
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_FOCUSED_MS);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(
      NOTIFICATIONS_PUSH_COALESCE_MS - NOTIFICATIONS_PUSH_COALESCE_FOCUSED_MS,
    );
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
  });

  it("__reset clears a pending timer so it never fires", () => {
    scheduleNotificationsPushRefresh(queryClient);
    __resetNotificationsPushCoalesce();
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
  });

  it("does not refetch on the timer while scroll is busy; fires after settle", () => {
    const owner = Symbol("notifications-coalesce-scroll");
    setScrollActivity(owner, "drag", true);
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    setScrollActivity(owner, "drag", false);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
  });

  it("a new schedule while waiting for idle restarts the debounce", () => {
    const owner = Symbol("notifications-coalesce-scroll");
    setScrollActivity(owner, "drag", true);
    scheduleNotificationsPushRefresh(queryClient);
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS);
    scheduleNotificationsPushRefresh(queryClient);
    setScrollActivity(owner, "drag", false);
    expect(queryClient.refetchQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NOTIFICATIONS_PUSH_COALESCE_MS);
    expect(queryClient.refetchQueries).toHaveBeenCalledTimes(1);
  });
});
