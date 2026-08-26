import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgMessageDto } from "@flora/client-core/contracts";
import {
  CHAT_CACHE_PERSIST_DEBOUNCE_MS,
  createChatCachePersister,
  type ChatDiskWriter,
} from "@/lib/chatCachePersistCore";

function message(uuid: string): MsgMessageDto {
  return {
    messageUuid: uuid,
    conversationUuid: "conv-1",
    senderUserUuid: "user-2",
    encryptedPayload: "wire",
    createdAt: "2026-08-24T10:00:00Z",
    isFromMe: false,
    isRead: true,
  };
}

function makeWriter() {
  return {
    writeConversations: vi.fn(),
    writeGroups: vi.fn(),
    writeThread: vi.fn(),
    writeGroupDetail: vi.fn(),
  } satisfies ChatDiskWriter;
}

describe("createChatCachePersister", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });

  it("persists conversations after the debounce window with cache updatedAt", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    const page = { items: [], nextCursor: null };
    queryClient.setQueryData(["conversations"], page, { updatedAt: 12_345 });

    expect(writer.writeConversations).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CHAT_CACHE_PERSIST_DEBOUNCE_MS + 1);
    expect(writer.writeConversations).toHaveBeenCalledTimes(1);
    expect(writer.writeConversations).toHaveBeenCalledWith(page, 12_345);
    persister.stop();
  });

  it("coalesces rapid updates into a single trailing write", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    for (let i = 0; i < 5; i++) {
      queryClient.setQueryData(["conversations"], { items: [], nextCursor: String(i) });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(CHAT_CACHE_PERSIST_DEBOUNCE_MS + 1);

    expect(writer.writeConversations).toHaveBeenCalledTimes(1);
    expect(writer.writeConversations.mock.calls[0]![0]).toMatchObject({ nextCursor: "4" });
    persister.stop();
  });

  it("persists dm and group threads with kind and otherUserUuid from the query key", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    queryClient.setQueryData(["messages", "Conv-A", "peer-1"], {
      items: [message("m1")],
      nextCursor: null,
    });
    queryClient.setQueryData(["group-messages", "Conv-G"], {
      items: [message("g1")],
      nextCursor: null,
    });
    vi.advanceTimersByTime(CHAT_CACHE_PERSIST_DEBOUNCE_MS + 1);

    expect(writer.writeThread).toHaveBeenCalledTimes(2);
    expect(writer.writeThread).toHaveBeenCalledWith(
      "Conv-A",
      expect.objectContaining({ kind: "dm", otherUserUuid: "peer-1" }),
    );
    expect(writer.writeThread).toHaveBeenCalledWith(
      "Conv-G",
      expect.objectContaining({ kind: "group", otherUserUuid: "" }),
    );
    persister.stop();
  });

  it("persists group detail and ignores unrelated queries", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    queryClient.setQueryData(["group", "Conv-G"], { conversationUuid: "Conv-G" });
    queryClient.setQueryData(["profile-posts", "user"], { items: [] });
    queryClient.setQueryData(["notifications", "all", ""], { items: [] });
    vi.advanceTimersByTime(CHAT_CACHE_PERSIST_DEBOUNCE_MS + 1);

    expect(writer.writeGroupDetail).toHaveBeenCalledTimes(1);
    expect(writer.writeConversations).not.toHaveBeenCalled();
    expect(writer.writeGroups).not.toHaveBeenCalled();
    expect(writer.writeThread).not.toHaveBeenCalled();
    persister.stop();
  });

  it("flush() writes pending immediately (background flush path)", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    queryClient.setQueryData(["groups"], []);
    persister.flush();
    expect(writer.writeGroups).toHaveBeenCalledTimes(1);

    // Повторный flush без новых событий не пишет ничего.
    persister.flush();
    expect(writer.writeGroups).toHaveBeenCalledTimes(1);
    persister.stop();
  });

  it("stop() cancels pending writes without flushing (logout wipe safety)", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    queryClient.setQueryData(["conversations"], { items: [], nextCursor: null });
    persister.stop();
    vi.advanceTimersByTime(CHAT_CACHE_PERSIST_DEBOUNCE_MS * 2);

    expect(writer.writeConversations).not.toHaveBeenCalled();

    // После stop новые события тоже игнорируются.
    queryClient.setQueryData(["groups"], []);
    vi.advanceTimersByTime(CHAT_CACHE_PERSIST_DEBOUNCE_MS * 2);
    expect(writer.writeGroups).not.toHaveBeenCalled();
  });

  it("skips writes when the query has no success data", () => {
    const writer = makeWriter();
    const persister = createChatCachePersister({ queryClient, writer });

    queryClient.setQueryData(["conversations"], { items: [], nextCursor: null });
    queryClient.removeQueries({ queryKey: ["conversations"] });
    persister.flush();

    expect(writer.writeConversations).not.toHaveBeenCalled();
    persister.stop();
  });
});
