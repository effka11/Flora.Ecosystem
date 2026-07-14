import { describe, expect, it } from "vitest";
import {
  canSendOutbound,
  createConversationSession,
  markCompromisedLocal,
  noteInboundDecrypted,
  noteOutboundAccepted,
  reHandshake,
} from "./conversationSession.js";

const BASE = {
  conversationUuid: "B338D82E-EE40-53A4-A6C4-BD587CD2F7C1",
  keyEpochId: "00000000-0000-4000-8000-000000000001",
  peerUserUuid: "77777777-7777-4777-8777-777777777777",
};

const MSG_1 = "33333333-3333-4333-8333-333333333333";
const MSG_2 = "44444444-4444-4444-8444-444444444444";

describe("FscpV1ConversationSession (FSCP.md §Session state)", () => {
  it("создаётся в uninitialized, uuid нормализованы к lowercase", () => {
    const s = createConversationSession(BASE);
    expect(s.sessionState).toBe("uninitialized");
    expect(s.fscpProtocolVersion).toBe(1);
    expect(s.conversationUuid).toBe(BASE.conversationUuid.toLowerCase());
    expect(canSendOutbound(s)).toBe(true); // «отправитель может отправить первое сообщение»
  });

  it("получатель после первого успешного decrypt → ready", () => {
    const s0 = createConversationSession(BASE);
    const { session: s1, isNewMessage } = noteInboundDecrypted(s0, MSG_1);
    expect(isNewMessage).toBe(true);
    expect(s1.sessionState).toBe("ready");
    expect(s1.lastProcessedInboundMessageUuid).toBe(MSG_1);
  });

  it("повторная доставка того же messageUuid — не новое сообщение (anti-duplicate)", () => {
    const s0 = createConversationSession(BASE);
    const { session: s1 } = noteInboundDecrypted(s0, MSG_1.toUpperCase());
    const second = noteInboundDecrypted(s1, MSG_1);
    expect(second.isNewMessage).toBe(false);
    expect(second.session).toBe(s1);
  });

  it("принятое сервером исходящее переводит в ready", () => {
    const s0 = createConversationSession(BASE);
    const s1 = noteOutboundAccepted(s0, MSG_2);
    expect(s1.sessionState).toBe("ready");
    expect(s1.lastAcceptedOutboundMessageUuid).toBe(MSG_2);
  });

  it.each([
    "device_revoked",
    "epoch_identity_changed",
    "user_reset",
    "decrypt_failure",
  ] as const)("триггер %s → compromised_local, исходящие приостановлены", (reason) => {
    const ready = noteOutboundAccepted(createConversationSession(BASE), MSG_1);
    const s = markCompromisedLocal(ready, reason);
    expect(s.sessionState).toBe("compromised_local");
    expect(s.compromiseReason).toBe(reason);
    expect(canSendOutbound(s)).toBe(false);
    expect(() => noteOutboundAccepted(s, MSG_2)).toThrow("re-handshake");
  });

  it("markCompromisedLocal идемпотентен, первая причина сохраняется", () => {
    const s0 = markCompromisedLocal(createConversationSession(BASE), "device_revoked");
    const s1 = markCompromisedLocal(s0, "decrypt_failure");
    expect(s1).toBe(s0);
    expect(s1.compromiseReason).toBe("device_revoked");
  });

  it("входящие продолжают читаться в compromised_local, но состояние не лечится", () => {
    const s0 = markCompromisedLocal(createConversationSession(BASE), "user_reset");
    const { session: s1, isNewMessage } = noteInboundDecrypted(s0, MSG_1);
    expect(isNewMessage).toBe(true);
    expect(s1.sessionState).toBe("compromised_local");
  });

  it("re-handshake даёт свежую uninitialized-сессию (та же или новая эпоха)", () => {
    const compromised = markCompromisedLocal(
      noteOutboundAccepted(createConversationSession(BASE), MSG_1),
      "epoch_identity_changed",
    );
    const sameEpoch = reHandshake(compromised);
    expect(sameEpoch.sessionState).toBe("uninitialized");
    expect(sameEpoch.keyEpochId).toBe(BASE.keyEpochId);
    expect(sameEpoch.lastAcceptedOutboundMessageUuid).toBeUndefined();
    expect(sameEpoch.compromiseReason).toBeUndefined();

    const newEpoch = reHandshake(compromised, {
      newKeyEpochId: "00000000-0000-4000-8000-00000000000A",
    });
    expect(newEpoch.keyEpochId).toBe("00000000-0000-4000-8000-00000000000a");
    expect(canSendOutbound(newEpoch)).toBe(true);
    // Полный цикл восстановления: первое сообщение после re-handshake → ready.
    expect(noteOutboundAccepted(newEpoch, MSG_2).sessionState).toBe("ready");
  });
});
