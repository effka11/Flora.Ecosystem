import { describe, expect, it } from "vitest";
import { isMessagesInThreadPath, isMessagesThreadSurface } from "./messagesTabBar";

describe("isMessagesThreadSurface", () => {
  it("is true for the conversation route in segments", () => {
    expect(
      isMessagesThreadSurface({
        segments: ["(tabs)", "messages", "conversation-uuid"],
        pathname: "/messages/conversation-uuid",
      }),
    ).toBe(true);
  });

  it("survives a missing segment list: the path alone names the thread", () => {
    // Таб-бар не должен зависеть от того, успели ли segments доехать до
    // вложенного маршрута: поле ввода живёт под баром, если он отрисован.
    expect(
      isMessagesThreadSurface({ segments: ["(tabs)", "messages"], pathname: "/messages/uuid" }),
    ).toBe(true);
  });

  it("is false on the messages list and outside the tab", () => {
    expect(
      isMessagesThreadSurface({ segments: ["(tabs)", "messages"], pathname: "/messages" }),
    ).toBe(false);
    expect(
      isMessagesThreadSurface({ segments: ["(tabs)", "feed"], pathname: "/feed" }),
    ).toBe(false);
    expect(
      isMessagesThreadSurface({ segments: ["(tabs)", "feed", "messages"], pathname: "/feed" }),
    ).toBe(false);
  });
});

describe("isMessagesInThreadPath", () => {
  it("matches a thread path with and without a trailing slash", () => {
    expect(isMessagesInThreadPath("/messages/uuid")).toBe(true);
    expect(isMessagesInThreadPath("/messages/uuid/")).toBe(true);
  });

  it("does not match the list root or a prefix of another tab", () => {
    expect(isMessagesInThreadPath("/messages")).toBe(false);
    expect(isMessagesInThreadPath("/messages-archive/uuid")).toBe(false);
    expect(isMessagesInThreadPath("/")).toBe(false);
  });
});
