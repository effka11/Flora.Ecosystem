import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import {
  FSCP_ORGANIZER_WIRE_PREFIX,
  buildFscpOrganizerWireEnvelope,
  decryptFscpOrganizerWireEnvelope,
  emptyFscpOrganizerState,
  isFscpOrganizerWirePayload,
  normalizeFscpOrganizerState,
  type FscpOrganizerStatePlaintext,
} from "./chatOrganizer.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

function sampleState(): FscpOrganizerStatePlaintext {
  return {
    ...emptyFscpOrganizerState("2026-08-02T10:00:00.000Z"),
    entities: [
      {
        id: "fld_1",
        kind: "folder",
        label: "Работа",
        icon: "briefcase-outline",
        memberPeerUuids: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        memberConversationUuids: ["11111111-2222-4333-8444-555555555555"],
        createdAtMs: 1754000000000,
      },
    ],
    archivedByPeer: { "cccccccc-cccc-4ccc-8ccc-cccccccccccc": true },
    mutedByPeer: {},
    archivedByConversation: { "11111111-2222-4333-8444-555555555555": true },
    mutedByConversation: {},
  };
}

describe("FSCP-ORG v1 chat organizer envelope", () => {
  it("round-trips folder/archive state through self-encrypted wire", async () => {
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();

    const wire = await buildFscpOrganizerWireEnvelope({
      ownerUserUuid: OWNER,
      ownerAgreementPrivateKey: box.privateKey.subarray(0, 32),
      ownerSigningPrivateKey: sign.privateKey,
      revision: 3,
      state: sampleState(),
    });

    expect(isFscpOrganizerWirePayload(wire)).toBe(true);

    const opened = await decryptFscpOrganizerWireEnvelope({
      wire,
      ownerUserUuid: OWNER,
      agreementPrivateKey: box.privateKey.subarray(0, 32),
    });
    expect(opened.revision).toBe(3);
    expect(opened.state.entities).toHaveLength(1);
    expect(opened.state.entities[0].label).toBe("Работа");
    expect(opened.state.entities[0].memberConversationUuids).toEqual([
      "11111111-2222-4333-8444-555555555555",
    ]);
    expect(opened.state.archivedByPeer["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]).toBe(true);
    expect(opened.state.archivedByConversation["11111111-2222-4333-8444-555555555555"]).toBe(true);
  });

  it("server (or another user) cannot read folder names from the wire", async () => {
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();

    const wire = await buildFscpOrganizerWireEnvelope({
      ownerUserUuid: OWNER,
      ownerAgreementPrivateKey: box.privateKey.subarray(0, 32),
      ownerSigningPrivateKey: sign.privateKey,
      revision: 1,
      state: sampleState(),
    });

    // Метка папки не должна встречаться в открытой части wire ни в каком виде.
    const inner = new TextDecoder().decode(
      fromBase64Url(wire.slice(FSCP_ORGANIZER_WIRE_PREFIX.length)),
    );
    expect(inner).not.toContain("Работа");
    expect(inner).not.toContain(toBase64Url(utf8Bytes("Работа")));

    // Чужой agreement key не разворачивает ключ состояния.
    const stranger = sodium.crypto_box_keypair();
    await expect(
      decryptFscpOrganizerWireEnvelope({
        wire,
        ownerUserUuid: OWNER,
        agreementPrivateKey: stranger.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "rke_unwrap_failed" });
  });

  it("revision is bound by AAD: swapping revision field breaks decrypt", async () => {
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();

    const wire = await buildFscpOrganizerWireEnvelope({
      ownerUserUuid: OWNER,
      ownerAgreementPrivateKey: box.privateKey.subarray(0, 32),
      ownerSigningPrivateKey: sign.privateKey,
      revision: 5,
      state: sampleState(),
    });

    const env = JSON.parse(
      new TextDecoder().decode(fromBase64Url(wire.slice(FSCP_ORGANIZER_WIRE_PREFIX.length))),
    );
    env.revision = 6;
    const tampered = FSCP_ORGANIZER_WIRE_PREFIX + toBase64Url(utf8Bytes(JSON.stringify(env)));

    // Подпись покрывает revision — первая линия защиты.
    await expect(
      decryptFscpOrganizerWireEnvelope({
        wire: tampered,
        ownerUserUuid: OWNER,
        agreementPrivateKey: box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "signature_invalid" });
  });

  it("rejects envelope of another owner", async () => {
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();

    const wire = await buildFscpOrganizerWireEnvelope({
      ownerUserUuid: OWNER,
      ownerAgreementPrivateKey: box.privateKey.subarray(0, 32),
      ownerSigningPrivateKey: sign.privateKey,
      revision: 1,
      state: emptyFscpOrganizerState(),
    });

    await expect(
      decryptFscpOrganizerWireEnvelope({
        wire,
        ownerUserUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agreementPrivateKey: box.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "no_recipient_entry" });
  });

  it("normalize keeps unknown entity kinds out and tolerates unknown top-level fields", () => {
    const raw = {
      type: "chat-organizer",
      version: 1,
      entities: [
        {
          id: "fld_1",
          kind: "folder",
          label: "A",
          memberPeerUuids: ["x", "x", " "],
          memberConversationUuids: [],
          createdAtMs: 1,
        },
        { id: "future_1", kind: "smart-folder", label: "Z" },
      ],
      archivedByPeer: { p1: true, p2: false },
      mutedByPeer: {},
      archivedByConversation: {},
      mutedByConversation: {},
      clientUpdatedAt: "2026-08-02T10:00:00.000Z",
      pad: "0000",
      futureField: { anything: 1 },
    };
    const state = normalizeFscpOrganizerState(raw);
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0].memberPeerUuids).toEqual(["x"]);
    expect(state.archivedByPeer).toEqual({ p1: true });
  });
});
