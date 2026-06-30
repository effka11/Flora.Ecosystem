import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLoginPayload, parseMePayload } from "./auth.js";
import { parseFeedPage } from "./feed.js";
import { parseProfilePostsList } from "./profile.js";
import { parseConversationsPage, parseMessagesPage } from "./messaging.js";
import { parseNotificationsList, parseUnreadCount } from "./notifications.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../artifacts/contract-fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

describe("contract fixtures", () => {
  it("parses auth-login.json", () => {
    const parsed = parseLoginPayload(loadFixture("auth-login.json"));
    expect(parsed.accessToken).toContain("eyJ");
    expect(parsed.refreshToken).toBe("refresh-token-sample");
  });

  it("parses auth-refresh.json", () => {
    const parsed = parseLoginPayload(loadFixture("auth-refresh.json"));
    expect(parsed.accessToken).toContain("rotated");
  });

  it("parses auth-me.json", () => {
    const parsed = parseMePayload(loadFixture("auth-me.json"));
    expect(parsed.username).toBe("flora_user");
    expect(parsed.followersCount).toBe(10);
  });

  it("parses feed-page.json", () => {
    const parsed = parseFeedPage(loadFixture("feed-page.json"));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.text).toBe("Hello Flora");
  });

  it("parses community fields on feed posts", () => {
    const parsed = parseFeedPage({
      items: [
        {
          postUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          authorUserUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          authorUsername: "founder",
          authorDisplayName: "Founder",
          communityId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          communityName: "My Group",
          communitySlug: "my-group",
          communityAvatarUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          content: "Community post",
          createdAt: "2026-06-12T10:00:00.000Z",
          likesCount: 0,
          commentsCount: 0,
          repostsCount: 0,
          viewsCount: 0,
          liked: false,
          reposted: false,
          imageUuids: [],
        },
      ],
    });
    expect(parsed.items).toHaveLength(1);
    const post = parsed.items[0]!;
    expect(post.communityUuid).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(post.communityName).toBe("My Group");
    expect(post.communitySlug).toBe("my-group");
    expect(post.communityAvatarUuid).toBe("dddddddd-dddd-dddd-dddd-dddddddddddd");
  });

  it("parses profile posts array", () => {
    const parsed = parseProfilePostsList([
      {
        postUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        content: "Hello profile",
        createdAt: "2026-06-12T10:00:00.000Z",
        commentsCount: 2,
        likesCount: 5,
        repostsCount: 1,
        viewsCount: 10,
        liked: true,
        reposted: false,
        imageUuids: ["img-1"],
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.content).toBe("Hello profile");
    expect(parsed[0]?.likesCount).toBe(5);
    expect(parsed[0]?.imageUuids).toEqual(["img-1"]);
  });

  it("parses messaging fixtures", () => {
    const conv = loadFixture("messaging-conversations.json");
    const parsed = parseConversationsPage(conv);
    expect(parsed.items).toHaveLength(1);
    const msgs = loadFixture("messaging-messages.json");
    const messages = parseMessagesPage(msgs);
    expect(messages.items).toHaveLength(1);
  });

  it("parses notifications unread", () => {
    const parsed = parseUnreadCount({ count: 3 });
    expect(parsed).toBe(3);
    const list = parseNotificationsList(loadFixture("notifications-page.json"));
    expect(list.length).toBeGreaterThan(0);
  });
});
