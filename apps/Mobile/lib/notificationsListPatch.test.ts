import type { NotificationDto } from "@flora/client-core/contracts";
import type { NotificationRealtimeSignal } from "@flora/client-core/signals";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import {
  insertNotificationIntoLists,
  notificationDtoFromSignal,
  removeNotificationFromLists,
} from "./notificationsListPatch";

function makeSignal(
  overrides: Partial<NotificationRealtimeSignal> = {},
): NotificationRealtimeSignal {
  return {
    notificationUuid: "n-new",
    type: "like",
    category: "social",
    text: "liked your post",
    actorUserUuid: "u-actor",
    postUuid: "p-1",
    commentUuid: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    update: null,
    ...overrides,
  };
}

function makeRow(
  notificationUuid: string,
  category: NotificationDto["category"] = "social",
): NotificationDto {
  return {
    notificationUuid,
    type: "like",
    category,
    text: "older row",
    createdAt: "2026-08-19T10:00:00.000Z",
    isRead: true,
    postUuid: null,
    commentUuid: null,
  };
}

describe("notificationsListPatch", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  describe("notificationDtoFromSignal", () => {
    it("maps a signal to an unread inbox row", () => {
      expect(notificationDtoFromSignal(makeSignal({ commentUuid: "c-1" }))).toEqual({
        notificationUuid: "n-new",
        type: "like",
        category: "social",
        text: "liked your post",
        createdAt: "2026-08-20T10:00:00.000Z",
        isRead: false,
        postUuid: "p-1",
        commentUuid: "c-1",
      });
    });

    it("keeps the developer category and falls back to social otherwise", () => {
      expect(notificationDtoFromSignal(makeSignal({ category: "developer" }))?.category).toBe(
        "developer",
      );
      expect(notificationDtoFromSignal(makeSignal({ category: "whatever" }))?.category).toBe(
        "social",
      );
    });

    it("returns null for app_update (sideload metadata, not an inbox row)", () => {
      expect(notificationDtoFromSignal(makeSignal({ type: "app_update" }))).toBeNull();
    });
  });

  describe("insertNotificationIntoLists", () => {
    it("prepends into the all cache and the matching category cache", () => {
      queryClient.setQueryData<NotificationDto[]>(["notifications", "all", ""], [makeRow("n-old")]);
      queryClient.setQueryData<NotificationDto[]>(
        ["notifications", "social", ""],
        [makeRow("n-old")],
      );

      insertNotificationIntoLists(queryClient, makeSignal());

      expect(
        queryClient
          .getQueryData<NotificationDto[]>(["notifications", "all", ""])
          ?.map((n) => n.notificationUuid),
      ).toEqual(["n-new", "n-old"]);
      expect(
        queryClient
          .getQueryData<NotificationDto[]>(["notifications", "social", ""])
          ?.map((n) => n.notificationUuid),
      ).toEqual(["n-new", "n-old"]);
    });

    it("does not insert into a cache of another category", () => {
      queryClient.setQueryData<NotificationDto[]>(
        ["notifications", "developer", ""],
        [makeRow("n-old", "developer")],
      );

      insertNotificationIntoLists(queryClient, makeSignal());

      expect(
        queryClient
          .getQueryData<NotificationDto[]>(["notifications", "developer", ""])
          ?.map((n) => n.notificationUuid),
      ).toEqual(["n-old"]);
    });

    it("routes a developer signal to the developer cache", () => {
      queryClient.setQueryData<NotificationDto[]>(["notifications", "all", ""], []);
      queryClient.setQueryData<NotificationDto[]>(["notifications", "social", ""], []);
      queryClient.setQueryData<NotificationDto[]>(["notifications", "developer", ""], []);

      insertNotificationIntoLists(
        queryClient,
        makeSignal({ category: "developer", type: "developer_reply" }),
      );

      expect(queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""])).toHaveLength(
        1,
      );
      expect(
        queryClient.getQueryData<NotificationDto[]>(["notifications", "developer", ""]),
      ).toHaveLength(1);
      expect(
        queryClient.getQueryData<NotificationDto[]>(["notifications", "social", ""]),
      ).toHaveLength(0);
    });

    it("skips search caches (server ranks them)", () => {
      queryClient.setQueryData<NotificationDto[]>(
        ["notifications", "all", "cat"],
        [makeRow("n-old")],
      );

      insertNotificationIntoLists(queryClient, makeSignal());

      expect(
        queryClient
          .getQueryData<NotificationDto[]>(["notifications", "all", "cat"])
          ?.map((n) => n.notificationUuid),
      ).toEqual(["n-old"]);
    });

    it("skips app_update signals", () => {
      queryClient.setQueryData<NotificationDto[]>(["notifications", "all", ""], [makeRow("n-old")]);

      insertNotificationIntoLists(queryClient, makeSignal({ type: "app_update" }));

      expect(
        queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""]),
      ).toHaveLength(1);
    });

    it("does not duplicate a uuid already in the list", () => {
      const existing = [makeRow("n-new"), makeRow("n-old")];
      queryClient.setQueryData<NotificationDto[]>(["notifications", "all", ""], existing);

      insertNotificationIntoLists(queryClient, makeSignal());

      expect(queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""])).toBe(
        existing,
      );
    });

    it("leaves an unfetched cache undefined instead of materializing a list", () => {
      queryClient
        .getQueryCache()
        .build<NotificationDto[], Error, NotificationDto[], readonly unknown[]>(queryClient, {
          queryKey: ["notifications", "all", ""],
        });

      insertNotificationIntoLists(queryClient, makeSignal());

      expect(
        queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""]),
      ).toBeUndefined();
    });
  });

  describe("removeNotificationFromLists", () => {
    it("cuts the uuid from every notifications cache, including search ones", () => {
      queryClient.setQueryData<NotificationDto[]>(
        ["notifications", "all", ""],
        [makeRow("n-gone"), makeRow("n-old")],
      );
      queryClient.setQueryData<NotificationDto[]>(
        ["notifications", "social", ""],
        [makeRow("n-gone")],
      );
      queryClient.setQueryData<NotificationDto[]>(
        ["notifications", "all", "cat"],
        [makeRow("n-gone"), makeRow("n-old")],
      );

      removeNotificationFromLists(queryClient, "n-gone");

      expect(
        queryClient
          .getQueryData<NotificationDto[]>(["notifications", "all", ""])
          ?.map((n) => n.notificationUuid),
      ).toEqual(["n-old"]);
      expect(queryClient.getQueryData<NotificationDto[]>(["notifications", "social", ""])).toEqual(
        [],
      );
      expect(
        queryClient
          .getQueryData<NotificationDto[]>(["notifications", "all", "cat"])
          ?.map((n) => n.notificationUuid),
      ).toEqual(["n-old"]);
    });

    it("keeps the cached array identity when the uuid is absent", () => {
      const existing = [makeRow("n-old")];
      queryClient.setQueryData<NotificationDto[]>(["notifications", "all", ""], existing);

      removeNotificationFromLists(queryClient, "n-gone");

      expect(queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""])).toBe(
        existing,
      );
    });

    it("leaves an unfetched cache undefined", () => {
      queryClient
        .getQueryCache()
        .build<NotificationDto[], Error, NotificationDto[], readonly unknown[]>(queryClient, {
          queryKey: ["notifications", "all", ""],
        });

      removeNotificationFromLists(queryClient, "n-gone");

      expect(
        queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""]),
      ).toBeUndefined();
    });

    it("ignores an empty uuid", () => {
      const existing = [makeRow("n-old")];
      queryClient.setQueryData<NotificationDto[]>(["notifications", "all", ""], existing);

      removeNotificationFromLists(queryClient, "");

      expect(queryClient.getQueryData<NotificationDto[]>(["notifications", "all", ""])).toBe(
        existing,
      );
    });
  });
});
