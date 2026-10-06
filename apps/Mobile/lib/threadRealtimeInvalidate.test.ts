import { describe, expect, it } from "vitest";
import { invalidateThreadForRealtime } from "@/lib/threadRealtimeInvalidate";

describe("invalidateThreadForRealtime", () => {
  it("marks the closed thread stale without refetching it", () => {
    const calls: { queryKey: readonly unknown[]; refetchType: string }[] = [];
    const client = {
      invalidateQueries: (opts: { queryKey: readonly unknown[]; refetchType: "none" }) => {
        calls.push(opts);
      },
    };
    invalidateThreadForRealtime(client, "conv-1", "dm");
    expect(calls).toEqual([{ queryKey: ["messages", "conv-1"], refetchType: "none" }]);

    calls.length = 0;
    invalidateThreadForRealtime(client, "group-1", "groupChat");
    expect(calls).toEqual([{ queryKey: ["group-messages", "group-1"], refetchType: "none" }]);

    calls.length = 0;
    invalidateThreadForRealtime(client, "unknown", null);
    expect(calls.map((call) => call.queryKey[0])).toEqual(["messages", "group-messages"]);
    expect(calls.every((call) => call.refetchType === "none")).toBe(true);
  });
});
