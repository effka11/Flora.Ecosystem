/**
 * Wire-shape smoke for chat-list-overlay (не Artifacts/ — regenerate-only там).
 * Паритет с `ChatListOverlayDto` / `ChatListEntityDto` (camelCase).
 */
import { describe, expect, it } from "vitest";
import { chatListOverlayFromApi } from "./chatListFolders.js";

describe("chat-list-overlay wire shape", () => {
  it("parses camelCase overlay DTO", () => {
    const parsed = chatListOverlayFromApi({
      entities: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "folder",
          label: "Work",
          icon: "briefcase-outline",
          memberPeerUuids: ["22222222-2222-4222-8222-222222222222"],
          createdAt: "2026-08-02T12:00:00.000Z",
        },
      ],
      archivedPeerUuids: ["33333333-3333-4333-8333-333333333333"],
      mutedPeerUuids: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.entities).toHaveLength(1);
    expect(parsed!.entities[0]?.icon).toBe("briefcase-outline");
    expect(parsed!.archivedByPeer).toEqual({
      "33333333-3333-4333-8333-333333333333": true,
    });
    expect(parsed!.mutedByPeer).toEqual({
      "44444444-4444-4444-8444-444444444444": true,
    });
  });
});
