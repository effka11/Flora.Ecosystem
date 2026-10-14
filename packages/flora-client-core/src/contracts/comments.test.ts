import { describe, expect, it } from "vitest";
import { parsePostComment } from "./comments.js";

describe("parsePostComment likes", () => {
  it("reads likesCount and liked", () => {
    const parsed = parsePostComment({
      commentUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      authorUsername: "alice",
      content: "note",
      createdAt: "2026-08-18T12:00:00.000Z",
      likesCount: 2,
      liked: true,
    });
    expect(parsed?.likesCount).toBe(2);
    expect(parsed?.liked).toBe(true);
  });

  it("defaults likesCount and liked when the fields are absent", () => {
    const parsed = parsePostComment({
      commentUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      authorUsername: "alice",
      content: "note",
      createdAt: "2026-08-18T12:00:00.000Z",
    });
    expect(parsed?.likesCount).toBe(0);
    expect(parsed?.liked).toBe(false);
  });
});
