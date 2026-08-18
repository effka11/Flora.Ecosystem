import { describe, expect, it } from "vitest";
import { parseMePayload } from "./auth.js";
import { parsePostComment } from "./comments.js";
import { parseFeedPostsList } from "./feed.js";
import { parseConversationsPage } from "./messaging.js";
import { parsePeopleUsersList } from "./people.js";
import { parsePublicProfile } from "./profile.js";

describe("accountBlocked parsers", () => {
  it("missing accountBlocked parses as false on /me", () => {
    const parsed = parseMePayload({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      displayName: "Alice",
    });
    expect(parsed.accountBlocked).toBe(false);
    expect(parsed.accountBlockedUntil).toBeUndefined();
  });

  it("accountBlockedUntil is ignored when accountBlocked is false on /me", () => {
    const parsed = parseMePayload({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      displayName: "Alice",
      accountBlocked: false,
      accountBlockedUntil: null,
    });
    expect(parsed.accountBlocked).toBe(false);
    expect(parsed.accountBlockedUntil).toBeUndefined();
  });

  it("accountBlockedUntil null means forever only when accountBlocked is true on /me", () => {
    const parsed = parseMePayload({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      displayName: "Alice",
      accountBlocked: true,
      accountBlockedUntil: null,
    });
    expect(parsed.accountBlocked).toBe(true);
    expect(parsed.accountBlockedUntil).toBeNull();
  });

  it("missing accountBlockedUntil does not imply forever on /me", () => {
    const parsed = parseMePayload({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      displayName: "Alice",
      accountBlocked: true,
    });
    expect(parsed.accountBlocked).toBe(true);
    expect(parsed.accountBlockedUntil).toBeUndefined();
  });

  it("parses accountBlocked on nested user-shaped profile", () => {
    const parsed = parsePublicProfile({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      displayName: "Alice",
      accountBlocked: true,
    });
    expect(parsed?.accountBlocked).toBe(true);
  });

  it("parses accountBlocked on people list items", () => {
    const parsed = parsePeopleUsersList([
      { username: "alice", displayName: "Alice", accountBlocked: true },
    ]);
    expect(parsed[0]?.accountBlocked).toBe(true);
  });

  it("parses authorAccountBlocked on feed posts", () => {
    const parsed = parseFeedPostsList([
      {
        postUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        authorUsername: "alice",
        authorAccountBlocked: true,
        content: "hi",
        createdAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    expect(parsed[0]?.authorAccountBlocked).toBe(true);
  });

  it("missing authorAccountBlocked on feed posts parses false", () => {
    const parsed = parseFeedPostsList([
      {
        postUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        authorUsername: "alice",
        content: "hi",
        createdAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    expect(parsed[0]?.authorAccountBlocked).toBe(false);
  });

  it("parses authorAccountBlocked on comments", () => {
    const parsed = parsePostComment({
      commentUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      authorUsername: "alice",
      authorAccountBlocked: true,
      content: "note",
      createdAt: "2026-08-18T12:00:00.000Z",
    });
    expect(parsed?.authorAccountBlocked).toBe(true);
  });

  it("parses otherAccountBlocked on conversation peers", () => {
    const page = parseConversationsPage({
      items: [
        {
          conversationUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          otherUserUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          otherUsername: "alice",
          otherAccountBlocked: true,
          lastMessageAt: "2026-08-18T12:00:00.000Z",
        },
      ],
    });
    expect(page.items[0]?.otherAccountBlocked).toBe(true);
  });
});
