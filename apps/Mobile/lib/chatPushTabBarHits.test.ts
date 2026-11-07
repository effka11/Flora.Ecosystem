import { describe, expect, it } from "vitest";
import { CHAT_PUSH_OFF_EDGE } from "./chatListEnterMount";
import { chatPushTabBarHits } from "./chatPushTabBarHits";

const atRest = {
  styleBlocksHits: false,
  threadOpen: false,
  chatProgress: 0,
  composeCoversDock: false,
};

describe("chatPushTabBarHits", () => {
  it("keeps the dock hittable at rest", () => {
    expect(chatPushTabBarHits(atRest)).toEqual({ host: "box-none", tabBar: "box-none" });
  });

  it("skips hits while the chat covers the dock", () => {
    expect(
      chatPushTabBarHits({
        ...atRest,
        styleBlocksHits: true,
        chatProgress: 1,
      }),
    ).toEqual({ host: "none", tabBar: "none" });
  });

  it("mutes the bar for the whole open thread even at progress 0", () => {
    // Возврат из системного пикера мог сбросить progress под живым тредом:
    // бар всё равно не должен ловить тапы над полем ввода.
    expect(
      chatPushTabBarHits({
        ...atRest,
        threadOpen: true,
        styleBlocksHits: true,
        chatProgress: 0,
      }),
    ).toEqual({ host: "none", tabBar: "none" });
  });

  it("restores host and BottomTabBar hits once the chat is off the edge with a stuck none", () => {
    expect(
      chatPushTabBarHits({
        ...atRest,
        styleBlocksHits: true,
        chatProgress: 0,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
    expect(
      chatPushTabBarHits({
        ...atRest,
        styleBlocksHits: true,
        chatProgress: CHAT_PUSH_OFF_EDGE,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
  });

  it("skips hits while compose covers the dock", () => {
    expect(
      chatPushTabBarHits({
        ...atRest,
        composeCoversDock: true,
      }),
    ).toEqual({ host: "none", tabBar: "none" });
  });

  it("does not mute the visible strip while the route style still allows hits", () => {
    expect(
      chatPushTabBarHits({
        ...atRest,
        chatProgress: 0.4,
      }),
    ).toEqual({ host: "box-none", tabBar: "box-none" });
  });
});
