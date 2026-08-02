import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api/errors.js";
import { emptyChatListOverlayState, type ChatListOverlayState } from "./chatListFolders.js";
import {
  overlayStateToOrganizerPlaintext,
  type ChatOrganizerPlaintext,
} from "./chatOrganizerMap.js";
import { createChatOrganizerSession } from "./chatOrganizerSession.js";

const KEYS = {
  agreementPrivateKey: new Uint8Array(32).fill(1),
  signingPrivateKey: new Uint8Array(64).fill(2),
};

function memPersistence() {
  const map = new Map<string, ChatListOverlayState>();
  return {
    read: (owner: string) => map.get(owner) ?? emptyChatListOverlayState(),
    write: (owner: string, state: ChatListOverlayState) => {
      map.set(owner, state);
    },
    map,
  };
}

function fakeCrypto() {
  const store = new Map<number, ChatOrganizerPlaintext>();
  return {
    store,
    buildWire: async (params: {
      revision: number;
      state: ChatOrganizerPlaintext;
    }) => {
      store.set(params.revision, params.state);
      return `fscporg1:rev${params.revision}`;
    },
    decryptWire: async (params: { wire: string }) => {
      const m = /^fscporg1:rev(\d+)$/.exec(params.wire);
      if (!m) throw new Error("bad wire");
      const revision = Number(m[1]);
      const state = store.get(revision);
      if (!state) throw new Error("missing");
      return { state, revision };
    },
  };
}

describe("createChatOrganizerSession", () => {
  it("migrates on GET null → put rev1", async () => {
    const persistence = memPersistence();
    const crypto = fakeCrypto();
    let blob: { revision: number; wire: string; updatedAt: string } | null = null;
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async (p) =>
          crypto.buildWire({ revision: p.revision, state: p.state }),
        decryptWire: async (p) => crypto.decryptWire(p),
      },
      http: {
        getBlob: async () => blob,
        putBlob: async (wire) => {
          const m = /^fscporg1:rev(\d+)$/.exec(wire);
          expect(m).toBeTruthy();
          blob = {
            revision: Number(m![1]),
            wire,
            updatedAt: new Date().toISOString(),
          };
        },
      },
      persistence,
    });

    session.hydrate("11111111-1111-4111-8111-111111111111");
    session.setKeys(KEYS);
    await vi.waitFor(() => {
      expect(session.getSnapshot().state.revision).toBe(1);
      expect(session.getSnapshot().state.migratedToOrg).toBe(true);
    });
    expect(blob?.revision).toBe(1);
  });

  it("re-applies intent after 409", async () => {
    const persistence = memPersistence();
    const crypto = fakeCrypto();
    const owner = "11111111-1111-4111-8111-111111111111";
    const serverState = overlayStateToOrganizerPlaintext(emptyChatListOverlayState());
    crypto.store.set(1, serverState);
    let serverRev = 1;
    let putCalls = 0;

    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async (p) =>
          crypto.buildWire({ revision: p.revision, state: p.state }),
        decryptWire: async (p) => crypto.decryptWire(p),
      },
      http: {
        getBlob: async () => ({
          revision: serverRev,
          wire: `fscporg1:rev${serverRev}`,
          updatedAt: new Date().toISOString(),
        }),
        putBlob: async (wire) => {
          putCalls += 1;
          const m = /^fscporg1:rev(\d+)$/.exec(wire);
          const rev = Number(m![1]);
          if (putCalls === 1) {
            serverRev = 2;
            crypto.store.set(2, {
              ...serverState,
              entities: [
                {
                  id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
                  kind: "folder",
                  label: "Other",
                  memberPeerUuids: [],
                  memberConversationUuids: [],
                  createdAtMs: 1,
                },
              ],
            });
            throw new ApiRequestError(409, "conflict");
          }
          if (rev !== serverRev + 1) throw new ApiRequestError(409, "conflict");
          serverRev = rev;
        },
      },
      persistence,
    });

    session.hydrate(owner);
    session.setKeys(KEYS);
    await vi.waitFor(() => expect(session.getSnapshot().state.revision).toBe(1));

    await session.setMuted("22222222-2222-4222-8222-222222222222", "conv", true);
    await vi.waitFor(() => {
      expect(
        session.getSnapshot().state.mutedByPeer[
          "22222222-2222-4222-8222-222222222222"
        ],
      ).toBe(true);
      expect(session.getSnapshot().state.mutedByConversation?.conv).toBe(true);
      expect(session.getSnapshot().state.revision).toBe(3);
    });
    expect(putCalls).toBeGreaterThanOrEqual(2);
  });

  it("does not remigrate when decrypt fails", async () => {
    const persistence = memPersistence();
    let putCount = 0;
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async () => "fscporg1:x",
        decryptWire: async () => {
          throw new Error("rke_unwrap_failed");
        },
      },
      http: {
        getBlob: async () => ({
          revision: 4,
          wire: "fscporg1:bad",
          updatedAt: new Date().toISOString(),
        }),
        putBlob: async () => {
          putCount += 1;
        },
      },
      persistence,
    });
    session.hydrate("11111111-1111-4111-8111-111111111111");
    session.setKeys(KEYS);
    await vi.waitFor(() =>
      expect(session.getSnapshot().decryptError).toContain("rke_unwrap_failed"),
    );
    expect(putCount).toBe(0);
  });

  it("serializes concurrent mutates (no self-409)", async () => {
    const persistence = memPersistence();
    const crypto = fakeCrypto();
    let serverRev = 0;
    const puts: number[] = [];
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async (p) =>
          crypto.buildWire({ revision: p.revision, state: p.state }),
        decryptWire: async (p) => crypto.decryptWire(p),
      },
      http: {
        getBlob: async () =>
          serverRev === 0
            ? null
            : {
                revision: serverRev,
                wire: `fscporg1:rev${serverRev}`,
                updatedAt: new Date().toISOString(),
              },
        putBlob: async (wire) => {
          const rev = Number(/^fscporg1:rev(\d+)$/.exec(wire)![1]);
          if (serverRev > 0 && rev !== serverRev + 1) {
            throw new ApiRequestError(409, `expected ${serverRev + 1}`);
          }
          if (serverRev === 0 && rev !== 1) {
            throw new ApiRequestError(409, "expected 1");
          }
          puts.push(rev);
          serverRev = rev;
        },
      },
      persistence,
    });
    const owner = "11111111-1111-4111-8111-111111111111";
    session.hydrate(owner);
    session.setKeys(KEYS);
    await vi.waitFor(() => expect(session.getSnapshot().state.revision).toBe(1));

    await Promise.all([
      session.setMuted("a", "c1", true),
      session.setArchived("b", "c2", true),
    ]);
    await vi.waitFor(() => {
      expect(session.getSnapshot().state.mutedByPeer.a).toBe(true);
      expect(session.getSnapshot().state.archivedByPeer.b).toBe(true);
      expect(session.getSnapshot().state.mutedByConversation?.c1).toBe(true);
      expect(session.getSnapshot().state.archivedByConversation?.c2).toBe(true);
    });
    for (let i = 1; i < puts.length; i++) {
      expect(puts[i]).toBe(puts[i - 1]! + 1);
    }
  });

  it("failed mutate does not wipe a later optimistic intent", async () => {
    const persistence = memPersistence();
    const crypto = fakeCrypto();
    let serverRev = 0;
    let putCount = 0;
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async (p) =>
          crypto.buildWire({ revision: p.revision, state: p.state }),
        decryptWire: async (p) => crypto.decryptWire(p),
      },
      http: {
        getBlob: async () =>
          serverRev === 0
            ? null
            : {
                revision: serverRev,
                wire: `fscporg1:rev${serverRev}`,
                updatedAt: new Date().toISOString(),
              },
        putBlob: async (wire) => {
          putCount += 1;
          const rev = Number(/^fscporg1:rev(\d+)$/.exec(wire)![1]);
          // First post-migrate put fails hard (not 409)
          if (putCount === 2) {
            throw new ApiRequestError(500, "boom");
          }
          if (serverRev > 0 && rev !== serverRev + 1) {
            throw new ApiRequestError(409, "conflict");
          }
          serverRev = rev;
        },
      },
      persistence,
    });
    const owner = "11111111-1111-4111-8111-111111111111";
    session.hydrate(owner);
    session.setKeys(KEYS);
    await vi.waitFor(() => expect(session.getSnapshot().state.revision).toBe(1));

    const muteA = session.setMuted("a", "c1", true);
    const muteB = session.setMuted("b", "c2", true);
    await Promise.all([muteA, muteB]);

    await vi.waitFor(() => {
      // A failed and was reverted; B should still be present (succeeded or optimistic kept)
      expect(session.getSnapshot().state.mutedByPeer.a).toBeUndefined();
      expect(session.getSnapshot().state.mutedByPeer.b).toBe(true);
    });
  });

  it("409 then missing blob does not rewrite as rev1", async () => {
    const persistence = memPersistence();
    const crypto = fakeCrypto();
    const owner = "11111111-1111-4111-8111-111111111111";
    crypto.store.set(1, overlayStateToOrganizerPlaintext(emptyChatListOverlayState()));
    let serverRev = 1;
    let puts: number[] = [];
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async (p) =>
          crypto.buildWire({ revision: p.revision, state: p.state }),
        decryptWire: async (p) => crypto.decryptWire(p),
      },
      http: {
        getBlob: async () => {
          // After conflict, blob is gone (ops delete / race)
          if (puts.length > 0) return null;
          return {
            revision: serverRev,
            wire: `fscporg1:rev${serverRev}`,
            updatedAt: new Date().toISOString(),
          };
        },
        putBlob: async (wire) => {
          const rev = Number(/^fscporg1:rev(\d+)$/.exec(wire)![1]);
          puts.push(rev);
          // First mutate conflicts; must not follow with rev1
          throw new ApiRequestError(409, "conflict");
        },
      },
      persistence,
    });
    session.hydrate(owner);
    session.setKeys(KEYS);
    await vi.waitFor(() => expect(session.getSnapshot().state.revision).toBe(1));

    await session.setMuted("a", "c1", true);
    await vi.waitFor(() => {
      // Intent reverted; never wrote rev1 rewrite
      expect(session.getSnapshot().state.mutedByPeer.a).toBeUndefined();
    });
    expect(puts.every((r) => r >= 2)).toBe(true);
    expect(puts.some((r) => r === 1)).toBe(false);
  });

  it("sync rejects older remote revision", async () => {
    const persistence = memPersistence();
    const crypto = fakeCrypto();
    const owner = "11111111-1111-4111-8111-111111111111";
    const newer = overlayStateToOrganizerPlaintext({
      ...emptyChatListOverlayState(),
      mutedByPeer: { a: true },
    });
    const older = overlayStateToOrganizerPlaintext(emptyChatListOverlayState());
    crypto.store.set(5, newer);
    crypto.store.set(3, older);
    persistence.write(owner, {
      ...emptyChatListOverlayState(),
      revision: 5,
      migratedToOrg: true,
      mutedByPeer: { a: true },
    });
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async (p) =>
          crypto.buildWire({ revision: p.revision, state: p.state }),
        decryptWire: async (p) => crypto.decryptWire(p),
      },
      http: {
        getBlob: async () => ({
          revision: 3,
          wire: "fscporg1:rev3",
          updatedAt: new Date().toISOString(),
        }),
        putBlob: async () => {
          throw new Error("should not put");
        },
      },
      persistence,
    });
    session.hydrate(owner);
    session.setKeys(KEYS);
    await vi.waitFor(() =>
      expect(session.getSnapshot().decryptError).toMatch(/rollback rejected/i),
    );
    expect(session.getSnapshot().state.revision).toBe(5);
    expect(session.getSnapshot().state.mutedByPeer.a).toBe(true);
  });

  it("does not re-seed when local migrated but server 404", async () => {
    const persistence = memPersistence();
    const owner = "11111111-1111-4111-8111-111111111111";
    persistence.write(owner, {
      ...emptyChatListOverlayState(),
      revision: 5,
      migratedToOrg: true,
      mutedByPeer: { a: true },
    });
    let putCount = 0;
    const session = createChatOrganizerSession({
      crypto: {
        buildWire: async () => "fscporg1:x",
        decryptWire: async () => {
          throw new Error("unused");
        },
      },
      http: {
        getBlob: async () => null,
        putBlob: async () => {
          putCount += 1;
        },
      },
      persistence,
    });
    session.hydrate(owner);
    session.setKeys(KEYS);
    await vi.waitFor(() =>
      expect(session.getSnapshot().decryptError).toMatch(/missing on server/i),
    );
    expect(putCount).toBe(0);
    expect(session.getSnapshot().state.mutedByPeer.a).toBe(true);
  });
});
