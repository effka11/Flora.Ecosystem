import { describe, expect, it, vi } from "vitest";
import { emptyChatListOverlayState, type ChatListOverlayState } from "./chatListFolders.js";
import { createChatListOverlaySession } from "./chatListOverlaySession.js";

describe("createChatListOverlaySession", () => {
  it("hydrates from persistence and refreshes from HTTP (latest-wins)", async () => {
    const store = new Map<string, ChatListOverlayState>();
    const owner = "11111111-1111-1111-1111-111111111111";
    store.set(owner, {
      ...emptyChatListOverlayState(),
      mutedByPeer: { "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": true },
    });

    const getOverlay = vi.fn(async () => ({
      entities: [],
      archivedPeerUuids: ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
      mutedPeerUuids: [],
    }));

    const session = createChatListOverlaySession({
      http: {
        getOverlay,
        createFolder: vi.fn(),
        deleteFolder: vi.fn(),
        addMember: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        mute: vi.fn(),
        unmute: vi.fn(),
      },
      persistence: {
        read: (id) => store.get(id) ?? emptyChatListOverlayState(),
        write: (id, state) => {
          store.set(id, state);
        },
      },
    });

    session.hydrate(owner);
    expect(session.getSnapshot().state.mutedByPeer).toEqual({
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": true,
    });

    await vi.waitFor(() => {
      expect(getOverlay).toHaveBeenCalled();
      expect(session.getSnapshot().state.archivedByPeer).toEqual({
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": true,
      });
      expect(session.getSnapshot().state.mutedByPeer).toEqual({});
      expect(session.getSnapshot().syncing).toBe(false);
    });
  });

  it("rolls back optimistic mute on HTTP failure", async () => {
    const owner = "11111111-1111-1111-1111-111111111111";
    let persisted = emptyChatListOverlayState();
    const session = createChatListOverlaySession({
      http: {
        getOverlay: vi.fn(async () => ({
          entities: [],
          archivedPeerUuids: [],
          mutedPeerUuids: [],
        })),
        createFolder: vi.fn(),
        deleteFolder: vi.fn(),
        addMember: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        mute: vi.fn(async () => {
          throw new Error("network");
        }),
        unmute: vi.fn(),
      },
      persistence: {
        read: () => persisted,
        write: (_id, state) => {
          persisted = state;
        },
      },
    });

    session.hydrate(owner);
    await vi.waitFor(() => expect(session.getSnapshot().syncing).toBe(false));

    await session.setMuted(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "cccccccccccccccccccccccccccccccccccc",
      true,
    );
    expect(session.getSnapshot().state.mutedByPeer).toEqual({});
  });
});
