import { describe, expect, it } from "vitest";
import { conversationLastMessageState, messageDeliveryState } from "./messageDeliveryState";

describe("conversationLastMessageState", () => {
  it("не показывает статус для входящего последнего сообщения", () => {
    expect(
      conversationLastMessageState({ isFromMe: false, isRead: true, isSending: false }),
    ).toBeNull();
  });

  it("sending важнее известного прочтения", () => {
    expect(
      conversationLastMessageState({ isFromMe: true, isRead: true, isSending: true }),
    ).toBe("sending");
  });

  it("одиночная галочка, когда серверный is_read = false", () => {
    expect(
      conversationLastMessageState({ isFromMe: true, isRead: false, isSending: false }),
    ).toBe("sent");
  });

  it("двойная галочка, когда серверный is_read = true", () => {
    expect(
      conversationLastMessageState({ isFromMe: true, isRead: true, isSending: false }),
    ).toBe("read");
  });
});

describe("messageDeliveryState", () => {
  it("не показывает статус для входящих", () => {
    expect(messageDeliveryState({ isFromMe: false, isRead: true })).toBeNull();
  });

  it("sending приоритетнее прочтения", () => {
    expect(messageDeliveryState({ isFromMe: true, isRead: true, sendStatus: "sending" })).toBe(
      "sending",
    );
  });

  it("read по флагу isRead", () => {
    expect(messageDeliveryState({ isFromMe: true, isRead: true })).toBe("read");
    expect(messageDeliveryState({ isFromMe: true, isRead: false })).toBe("sent");
  });
});
