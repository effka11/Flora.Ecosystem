/**
 * Consumer golden-транскрипта fscp-revoked-device-v1.json
 * (`message_session_revoked_device_v1_failure`, FSCP.md §Device revocation):
 * цепочка session 1:1 → decrypt M1 → revoke sender-устройства → M2 отклоняется
 * policy-слоем, исходящие блокируются FSM до re-handshake.
 * Серверный consumer — fscp_revoked_device_vectors.rs (flora-parity).
 * Файл вектора — regenerate-only: python Documents/test-vectors/_gen_fscp_revoked_device_v1.py
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canSendOutbound,
  createConversationSession,
  evaluateInboundSenderDevice,
  markCompromisedLocal,
  noteInboundDecrypted,
  noteOutboundAccepted,
  reHandshake,
  type FscpDeviceBindingStatus,
  type FscpV1ConversationSession,
} from "./conversationSession.js";
import { decryptFscpWireEnvelope } from "./envelope.js";
import { fromBase64Url } from "./base64url.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "Documents", "test-vectors",
);

type VectorMessage = {
  messageUuid: string;
  text: string;
  plaintextUtf8: string;
  wire: string;
};

type RevokedVector = {
  vectorId: string;
  uuids: Record<string, string>;
  keys: Record<string, string>;
  messageBeforeRevoke: VectorMessage;
  messageAfterRevoke: VectorMessage;
  deviceSetBeforeRevoke: { deviceUuid: string; userUuid: string; status: FscpDeviceBindingStatus }[];
  deviceSetAfterRevoke: { deviceUuid: string; userUuid: string; status: FscpDeviceBindingStatus }[];
  expected: {
    beforeRevoke: { clientPeerDecrypt: string; clientSessionStateAfterInbound: string };
    afterRevoke: {
      clientInboundPolicy: string;
      clientSessionState: string;
      clientCompromiseReason: string;
      clientOutboundBlocked: boolean;
      clientOutboundError: string;
      cryptoBypassDecrypt: string;
    };
  };
};

const v = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-revoked-device-v1.json"), "utf8"),
) as RevokedVector;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

function senderDeviceStatus(
  deviceSet: RevokedVector["deviceSetBeforeRevoke"],
): FscpDeviceBindingStatus | undefined {
  return deviceSet.find(
    (d) => d.deviceUuid.toLowerCase() === v.uuids.senderDeviceUuid!.toLowerCase(),
  )?.status;
}

function freshPeerSession(): FscpV1ConversationSession {
  return createConversationSession({
    conversationUuid: v.uuids.conversationUuid!,
    keyEpochId: v.uuids.keyEpochId!,
    peerUserUuid: v.uuids.senderUserUuid!,
  });
}

describe("golden: fscp-revoked-device-v1.json (message_session_revoked_device_v1_failure)", () => {
  it("vectorId соответствует compliance-таблице e2e-security.md", () => {
    expect(v.vectorId).toBe("message_session_revoked_device_v1_failure");
  });

  it("до revoke: peer принимает M1 (policy allow + decrypt ok), сессия → ready", async () => {
    let session = freshPeerSession();
    const policy = evaluateInboundSenderDevice(session, senderDeviceStatus(v.deviceSetBeforeRevoke));
    expect(policy.acceptInbound).toBe(true);

    const plain = await decryptFscpWireEnvelope({
      wire: v.messageBeforeRevoke.wire,
      viewerUserUuid: v.uuids.receiverUserUuid!,
      agreementPrivateKey: fromBase64Url(v.keys.receiverAgreementPrivateKeyBase64Url!),
    });
    expect(JSON.stringify(plain)).toBe(v.messageBeforeRevoke.plaintextUtf8);

    const outcome = noteInboundDecrypted(policy.session, v.messageBeforeRevoke.messageUuid);
    session = outcome.session;
    expect(outcome.isNewMessage).toBe(true);
    expect(session.sessionState).toBe(v.expected.beforeRevoke.clientSessionStateAfterInbound);
  });

  it("после revoke: инбаунд-policy отклоняет M2 и повтор M1, сессия compromised_local", async () => {
    // Peer уже в ready после M1.
    let session = noteInboundDecrypted(freshPeerSession(), v.messageBeforeRevoke.messageUuid).session;

    const status = senderDeviceStatus(v.deviceSetAfterRevoke);
    expect(status).toBe("Revoked");

    for (const wire of [v.messageAfterRevoke.wire, v.messageBeforeRevoke.wire]) {
      const policy = evaluateInboundSenderDevice(session, status);
      session = policy.session;
      expect(policy.acceptInbound).toBe(false);
      expect(wire.startsWith("fscp1:")).toBe(true); // конверт не обрабатывается дальше
    }
    expect(session.sessionState).toBe(v.expected.afterRevoke.clientSessionState);
    expect(session.compromiseReason).toBe(v.expected.afterRevoke.clientCompromiseReason);
  });

  it("после revoke: исходящие с того же device id блокируются FSM (golden-строка ошибки)", () => {
    // Сессия на стороне отправителя: устройство отозвано → compromised_local.
    const sender = markCompromisedLocal(
      createConversationSession({
        conversationUuid: v.uuids.conversationUuid!,
        keyEpochId: v.uuids.keyEpochId!,
        peerUserUuid: v.uuids.receiverUserUuid!,
      }),
      "device_revoked",
    );
    expect(canSendOutbound(sender)).toBe(!v.expected.afterRevoke.clientOutboundBlocked);
    expect(() => noteOutboundAccepted(sender, v.messageAfterRevoke.messageUuid)).toThrow(
      v.expected.afterRevoke.clientOutboundError,
    );
  });

  it("честность вектора: криптографически M2 валиден (отказ — policy, не крипто)", async () => {
    expect(v.expected.afterRevoke.cryptoBypassDecrypt).toBe("ok");
    const plain = await decryptFscpWireEnvelope({
      wire: v.messageAfterRevoke.wire,
      viewerUserUuid: v.uuids.receiverUserUuid!,
      agreementPrivateKey: fromBase64Url(v.keys.receiverAgreementPrivateKeyBase64Url!),
    });
    expect(JSON.stringify(plain)).toBe(v.messageAfterRevoke.plaintextUtf8);
  });

  it("выход из compromised_local — только re-handshake (fresh uninitialized session)", () => {
    const compromised = markCompromisedLocal(freshPeerSession(), "device_revoked");
    const next = reHandshake(compromised);
    expect(next.sessionState).toBe("uninitialized");
    expect(next.compromiseReason).toBeUndefined();
    expect(canSendOutbound(next)).toBe(true);
  });
});
