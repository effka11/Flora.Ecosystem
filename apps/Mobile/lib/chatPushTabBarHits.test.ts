import { describe, expect, it } from "vitest";
import { CHAT_PUSH_OFF_EDGE } from "./chatListEnterMount";
import { chatPushTabBarHits } from "./chatPushTabBarHits";

describe("chatPushTabBarHits", () => {
  it("keeps the dock hittable at rest", () => {
    expect(
      chatPushTabBarHits({
        styleBlocksHits: false,
        chatProgress: 0,
        composeCoversDock: false,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
  });

  it("skips hits while the chat covers the dock", () => {
    expect(
      chatPushTabBarHits({
        styleBlocksHits: true,
        chatProgress: 1,
        composeCoversDock: false,
      }),
    ).toEqual({ host: "none", tabBar: "none" });
  });

  it("restores host and BottomTabBar hits once the chat is off the edge with a stuck none", () => {
    expect(
      chatPushTabBarHits({
        styleBlocksHits: true,
        chatProgress: 0,
        composeCoversDock: false,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
    expect(
      chatPushTabBarHits({
        styleBlocksHits: true,
        chatProgress: CHAT_PUSH_OFF_EDGE,
        composeCoversDock: false,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
  });

  it("skips hits while compose covers the dock", () => {
    expect(
      chatPushTabBarHits({
        styleBlocksHits: false,
        chatProgress: 0,
        composeCoversDock: true,
      }),
    ).toEqual({ host: "none", tabBar: "none" });
  });

  it("does not mute the visible strip while the route style still allows hits", () => {
    expect(
      chatPushTabBarHits({
        styleBlocksHits: false,
        chatProgress: 0.4,
        composeCoversDock: false,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
  });
});
