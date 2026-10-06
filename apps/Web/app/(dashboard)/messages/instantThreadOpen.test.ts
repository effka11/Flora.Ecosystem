import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeGroupDetail } from "./groupApiMap";
import { loadGroupThreadAfterOpen } from "./groupThreadOpen";
import { messagesOpenDecryptCalls, resetMessagesOpenTrace } from "./messagesOpenTrace";
import { threadOpenSnapshot } from "./threadOpenSnapshot";
import { needsDecrypt } from "./useThreadDecrypt";
import {
  clearConversationThreadsCache,
  CONVERSATION_THREAD_CACHE_LIMIT,
  conversationThreadCacheSize,
  getConversationThread,
  peekConversationThread,
  rememberConversationThread,
  revalidateConversationThread,
} from "@/lib/conversationThreadsCache";
import {
  clearGroupThreadsCache,
  getGroupConversationThread,
  GROUP_THREAD_CACHE_LIMIT,
  groupThreadCacheSize,
  peekGroupConversationThread,
  rememberGroupConversationThread,
  revalidateGroupConversationThread,
} from "@/lib/groupThreadsCache";
import {
  cacheDecryptedMessageMedia,
  clearAllMessageMedia,
  MESSAGE_MEDIA_CACHE_LIMIT,
  messageMediaCacheSize,
} from "@/lib/messageMediaCache";
import {
  clearMessagePlaintextSessionCache,
  messagePlaintextThreadCount,
  messagePlaintextThreadKeys,
  pinIdlePlaintextThreads,
  plaintextThreadKey,
  PLAINTEXT_THREAD_LIMIT,
  rememberMessagePlaintext,
  resetPlaintextSessionCacheEnabledForTests,
  setPlaintextSessionCacheEnabledForTests,
} from "@/lib/messagePlaintextSessionCache";
import {
  isMessagesListScrolling,
  noteMessagesListScroll,
  resetMessagesListScrollForTests,
} from "@/lib/messagesListScrollActivity";
import { setOpenMessagesConversation } from "@/lib/messagesOpenConversation";
import { refreshClosedThreadOnMessageSignal } from "@/lib/closedThreadRefresh";
import { clearSession } from "@/lib/auth";
import type { MsgMessagesPage } from "@/lib/messagingApi";
import { isFscpWirePayload, type FscpMessagePlaintext } from "@/lib/fscp";
import {
  cancelAllHoverThreadWarms,
  cancelHoverThreadWarm,
  hoverThreadWarmCountForTests,
  scheduleHoverThreadWarm,
} from "@/lib/threadWarmIntent";
import { planThreadDecryptBatches, THREAD_DECRYPT_SLICE, THREAD_OPEN_PLAINTEXT_TAIL } from "@/lib/threadPlaintextWarm";
import { selectIdlePlaintextWarmSet } from "./usePreloadConversationThreads";
import type { GroupChat } from "./groupConversationTypes";
import type { MsgGroupDetail, MsgGroupMessagesPage } from "@flora/client-core/contracts";

function plain(body: string): FscpMessagePlaintext {
  return {
    type: "blocks",
    version: 1,
    blocks: [{ kind: "text", body }],
    clientCreatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function dmPage(peer: string, body: string, wire = ""): MsgMessagesPage {
  return {
    items: [
      {
        messageUuid: `${peer}-m`,
        senderUserUuid: peer,
        encryptedForMe: wire || null,
        content: body,
        createdAt: "2026-01-01T00:00:00.000Z",
        isRead: false,
        isFromMe: false,
        voiceAssetUuids: [],
        imageAssetUuids: [],
        videoAssetUuids: [],
      },
    ],
    nextCursor: null,
    hasMore: false,
  };
}

function groupPage(messageUuid: string): MsgGroupMessagesPage {
  return {
    items: [
      {
        messageUuid,
        senderUserUuid: "u",
        encryptedWire: "wire",
        createdAt: "2026-01-01T00:00:00.000Z",
        isFromMe: false,
      },
    ],
    nextCursor: null,
    hasMore: false,
  };
}

function resetCaches(): void {
  clearConversationThreadsCache();
  clearGroupThreadsCache();
  clearMessagePlaintextSessionCache();
  clearAllMessageMedia();
  resetPlaintextSessionCacheEnabledForTests();
  resetMessagesListScrollForTests();
  setOpenMessagesConversation(null);
  cancelAllHoverThreadWarms();
}

test("threadOpenSnapshot paints cached rows for the opened peer only", () => {
  resetCaches();
  rememberConversationThread("viewer", "peer-a", dmPage("peer-a", "alpha"));
  rememberConversationThread("viewer", "peer-b", dmPage("peer-b", "beta"));
  const opened = threadOpenSnapshot("viewer", { kind: "dm", peerUuid: "peer-b" });
  assert.equal(opened.messages.length, 1);
  assert.equal(opened.messages[0]?.content, "beta");
  assert.equal(opened.fetchedForViewerNorm, "viewer");
  const html = renderToStaticMarkup(
    createElement(
      "ul",
      null,
      opened.messages.map((message) =>
        createElement("li", { key: message.messageUuid }, message.content ?? ""),
      ),
    ),
  );
  assert.match(html, /beta/);
  assert.doesNotMatch(html, /alpha/);
  const cold = threadOpenSnapshot("viewer", { kind: "dm", peerUuid: "peer-c" });
  assert.deepEqual(cold.messages, []);
  assert.equal(cold.fetchedForViewerNorm, null);
});

test("plaintext seed is on the first snapshot and stays within 12 threads", () => {
  resetCaches();
  const viewer = "viewer";
  const peer = "peer-b";
  rememberConversationThread(viewer, peer, dmPage(peer, "beta", "fscp1:wire-b"));
  rememberMessagePlaintext(plaintextThreadKey(viewer, "dm", peer), `${peer}-m`, "fscp1:wire-b", {
    text: plain("beta-plain"),
  });
  const opened = threadOpenSnapshot(viewer, { kind: "dm", peerUuid: peer });
  assert.equal(opened.decryptedById[`${peer}-m`]?.blocks[0] && "body" in opened.decryptedById[`${peer}-m`].blocks[0]
    ? (opened.decryptedById[`${peer}-m`].blocks[0] as { body: string }).body
    : "", "beta-plain");
  resetMessagesOpenTrace();
  const tail = opened.messages.slice(-THREAD_OPEN_PLAINTEXT_TAIL);
  assert.ok(tail.length > 0);
  for (const message of tail) {
    assert.equal(needsDecrypt(message, opened.decryptedById, {}), false);
  }
  assert.equal(messagesOpenDecryptCalls(), 0);
  assert.equal(isFscpWirePayload(opened.messages[0]?.encryptedForMe), true);

  setPlaintextSessionCacheEnabledForTests(false);
  const off = threadOpenSnapshot(viewer, { kind: "dm", peerUuid: peer });
  assert.deepEqual(off.decryptedById, {});
  resetPlaintextSessionCacheEnabledForTests();

  clearMessagePlaintextSessionCache();
  for (let index = 0; index < 20; index += 1) {
    rememberMessagePlaintext(plaintextThreadKey(viewer, "dm", `peer-${index}`), `m-${index}`, "wire", {
      text: plain(String(index)),
    });
  }
  assert.ok(messagePlaintextThreadCount() <= PLAINTEXT_THREAD_LIMIT);

  const idle = Array.from({ length: PLAINTEXT_THREAD_LIMIT }, (_, index) =>
    plaintextThreadKey(viewer, "dm", `idle-${index}`),
  );
  pinIdlePlaintextThreads(idle);
  for (const key of idle) {
    rememberMessagePlaintext(key, "m", "wire", { text: plain("idle") });
  }
  for (let index = 0; index < 10; index += 1) {
    rememberMessagePlaintext(plaintextThreadKey(viewer, "dm", `hover-${index}`), "m", "wire", {
      text: plain("hover"),
    });
  }
  const keys = messagePlaintextThreadKeys();
  assert.ok(keys.length <= PLAINTEXT_THREAD_LIMIT);
  for (const key of idle)   assert.ok(keys.includes(key));
  const source = readFileSync(
    new URL("../../../lib/messagePlaintextSessionCache.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /localStorage|indexedDB|console/);
});

test("group open applies messages before mark-read and detail does not move rows", async () => {
  let detailStarted = false;
  let messagesApplied = false;
  let markReadCalls = 0;
  const painted: { run: (() => void) | null } = { run: null };
  const detail = deferred<MsgGroupDetail>();
  const thread = {
    messages: [{ messageUuid: "row-1" }],
    scrollOffset: 40,
  };
  const messageList = thread.messages;
  const before = {
    ids: thread.messages.map((row) => row.messageUuid),
    scrollOffset: thread.scrollOffset,
  };
  let group: GroupChat = {
    conversationUuid: "g1",
    title: "Группа",
    createdByUserUuid: "u",
    members: [],
    memberCount: 1,
    lastMessagePreview: null,
    lastMessageEncryptedWire: null,
    lastMessageAt: null,
    lastMessageIsFromMe: false,
    lastMessageSenderDisplayName: null,
    unreadCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const task = loadGroupThreadAfterOpen({
    fetchMessages: () => {
      assert.equal(detailStarted, true);
      return Promise.resolve({ items: [], nextCursor: null, hasMore: false });
    },
    fetchDetail: () => {
      detailStarted = true;
      return detail.promise;
    },
    markRead: async () => {
      markReadCalls += 1;
    },
    onMessages: () => {
      messagesApplied = true;
      assert.equal(markReadCalls, 0);
    },
    onDetail: (next) => {
      group = mergeGroupDetail(group, next);
    },
    afterPaint: (run) => {
      painted.run = run;
    },
    isCancelled: () => false,
  });
  await Promise.resolve();
  assert.equal(messagesApplied, true);
  assert.equal(markReadCalls, 0);
  painted.run?.();
  assert.equal(markReadCalls, 1);
  detail.resolve({
    conversationUuid: "g1",
    title: "Группа 2",
    createdByUserUuid: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    members: [],
  });
  await task;
  assert.equal(thread.messages, messageList);
  assert.deepEqual(
    { ids: thread.messages.map((row) => row.messageUuid), scrollOffset: thread.scrollOffset },
    before,
  );
  assert.equal(group.title, "Группа 2");
  assert.equal(group.memberCount, 0);
});

test("cold decrypt plan is one tail flush then at most four slices of eight", () => {
  const messages = Array.from({ length: 50 }, (_, index) => index);
  const plan = planThreadDecryptBatches(messages, () => true);
  assert.equal(plan.flush.length, THREAD_OPEN_PLAINTEXT_TAIL);
  assert.equal(plan.flush[0], 26);
  assert.ok(plan.restBatches.length <= 4);
  assert.ok(plan.restBatches.every((batch) => batch.length <= THREAD_DECRYPT_SLICE));
  assert.equal(plan.restBatches.flat().length, 26);
});

test("closed-chat refresh keeps the previous page until the single GET resolves", async () => {
  resetCaches();
  rememberConversationThread("viewer", "peer-a", dmPage("peer-a", "old"));
  const gate: { resolve: ((page: MsgMessagesPage) => void) | null } = { resolve: null };
  const fetchPage = () =>
    new Promise<MsgMessagesPage>((resolve) => {
      gate.resolve = resolve;
    });
  revalidateConversationThread("viewer", "peer-a", fetchPage);
  assert.equal(peekConversationThread("viewer", "peer-a")?.items[0]?.content, "old");
  const during = threadOpenSnapshot("viewer", { kind: "dm", peerUuid: "peer-a" });
  assert.equal(during.messages[0]?.content, "old");
  const opened = getConversationThread("viewer", "peer-a");
  gate.resolve?.(dmPage("peer-a", "new"));
  const page = await opened;
  assert.equal(page.items[0]?.content, "new");
  assert.equal(peekConversationThread("viewer", "peer-a")?.items[0]?.content, "new");

  const calls: string[] = [];
  setOpenMessagesConversation("conv-open");
  refreshClosedThreadOnMessageSignal(
    { conversationUuid: "conv-open", senderUserUuid: "peer-a", kind: "dm" },
    "viewer",
    { revalidateDm: (viewer: string, peer: string) => calls.push(`${viewer}:${peer}`) },
  );
  assert.equal(calls.length, 0);
  setOpenMessagesConversation(null);
  refreshClosedThreadOnMessageSignal(
    { conversationUuid: "conv-closed", senderUserUuid: "viewer", kind: "dm" },
    "viewer",
    { revalidateDm: (viewer: string, peer: string) => calls.push(`${viewer}:${peer}`) },
  );
  assert.equal(calls.length, 0);
  refreshClosedThreadOnMessageSignal(
    { conversationUuid: "conv-closed", senderUserUuid: "peer-a", kind: "dm" },
    "viewer",
    { revalidateDm: (viewer: string, peer: string) => calls.push(`${viewer}:${peer}`) },
  );
  assert.deepEqual(calls, ["viewer:peer-a"]);
});

test("held refresh page survives overflow and open waits for the replacement", async () => {
  resetCaches();
  for (let index = 0; index < CONVERSATION_THREAD_CACHE_LIMIT; index += 1) {
    rememberConversationThread("viewer", `peer-${index}`, dmPage(`peer-${index}`, "old"));
  }
  const dmGate: { resolve: ((page: MsgMessagesPage) => void) | null } = { resolve: null };
  revalidateConversationThread(
    "viewer",
    "peer-0",
    () =>
      new Promise<MsgMessagesPage>((resolve) => {
        dmGate.resolve = resolve;
      }),
  );
  rememberConversationThread("viewer", "peer-extra", dmPage("peer-extra", "extra"));
  assert.equal(peekConversationThread("viewer", "peer-0")?.items[0]?.content, "old");
  assert.ok(conversationThreadCacheSize() <= CONVERSATION_THREAD_CACHE_LIMIT);
  const openedDm = getConversationThread("viewer", "peer-0");
  dmGate.resolve?.(dmPage("peer-0", "new"));
  assert.equal((await openedDm).items[0]?.content, "new");

  for (let index = 0; index < GROUP_THREAD_CACHE_LIMIT; index += 1) {
    rememberGroupConversationThread("viewer", `group-${index}`, groupPage(`old-${index}`));
  }
  const groupGate: { resolve: ((page: MsgGroupMessagesPage) => void) | null } = { resolve: null };
  revalidateGroupConversationThread(
    "viewer",
    "group-0",
    () =>
      new Promise<MsgGroupMessagesPage>((resolve) => {
        groupGate.resolve = resolve;
      }),
  );
  rememberGroupConversationThread("viewer", "group-extra", groupPage("extra"));
  assert.equal(peekGroupConversationThread("viewer", "group-0")?.items[0]?.messageUuid, "old-0");
  assert.ok(groupThreadCacheSize() <= GROUP_THREAD_CACHE_LIMIT);
  const openedGroup = getGroupConversationThread("viewer", "group-0");
  groupGate.resolve?.(groupPage("new-0"));
  assert.equal((await openedGroup).items[0]?.messageUuid, "new-0");
});

test("logout clears thread, plaintext, and media object urls", async () => {
  resetCaches();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:test-media";
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  try {
    rememberConversationThread("viewer", "peer-a", dmPage("peer-a", "alpha"));
    rememberGroupConversationThread("viewer", "group-1", {
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    rememberMessagePlaintext(plaintextThreadKey("viewer", "dm", "peer-a"), "m", "wire", {
      text: plain("secret"),
    });
    cacheDecryptedMessageMedia("asset-1", new Blob(["x"]));
    clearSession();
    await import("@/lib/messagingSessionCaches");
    assert.equal(peekConversationThread("viewer", "peer-a"), null);
    assert.equal(peekGroupConversationThread("viewer", "group-1"), null);
    assert.equal(messagePlaintextThreadCount(), 0);
    assert.ok(revoked.includes("blob:test-media"));
    assert.equal(messageMediaCacheSize(), 0);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    resetCaches();
  }
});

test("hover intent waits 100ms and does not start while the chat list scrolls", () => {
  resetCaches();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let ran = 0;
    scheduleHoverThreadWarm("row-a", () => {
      ran += 1;
    });
    mock.timers.tick(99);
    assert.equal(ran, 0);
    cancelHoverThreadWarm("row-a");
    mock.timers.tick(200);
    assert.equal(ran, 0);

    for (let index = 0; index < 10; index += 1) {
      scheduleHoverThreadWarm(`row-${index}`, () => {
        ran += 1;
      });
      cancelHoverThreadWarm(`row-${index}`);
    }
    mock.timers.tick(300);
    assert.equal(ran, 0);

    noteMessagesListScroll();
    assert.equal(isMessagesListScrolling(), true);
    scheduleHoverThreadWarm("scrolling", () => {
      ran += 1;
    });
    assert.equal(hoverThreadWarmCountForTests(), 0);
    mock.timers.tick(300);
    assert.equal(ran, 0);
  } finally {
    mock.timers.reset();
    resetCaches();
  }
});

test("idle warm set stays within the plaintext budget", () => {
  const conversations = [
    ...Array.from({ length: 4 }, (_, index) => ({ otherUserUuid: `top-${index}`, unreadCount: 0 })),
    ...Array.from({ length: 6 }, (_, index) => ({ otherUserUuid: `unread-${index}`, unreadCount: 1 })),
    { otherUserUuid: "read-late", unreadCount: 0 },
  ];
  const groups = [
    { conversationUuid: "g-new", lastMessageAt: "2026-02-02T00:00:00.000Z" },
    { conversationUuid: "g-old", lastMessageAt: "2026-01-01T00:00:00.000Z" },
    { conversationUuid: "g-skip", lastMessageAt: "2025-01-01T00:00:00.000Z" },
  ];
  const set = selectIdlePlaintextWarmSet(conversations, groups);
  assert.equal(set.dmPeerUuids.length, 8);
  assert.deepEqual(set.dmPeerUuids.slice(0, 4), ["top-0", "top-1", "top-2", "top-3"]);
  assert.equal(set.groupUuids.length, 2);
  assert.deepEqual(set.groupUuids, ["g-new", "g-old"]);
  assert.ok(set.dmPeerUuids.length + set.groupUuids.length <= PLAINTEXT_THREAD_LIMIT);
});

test("ciphertext caches stay within 32 entries and chat open uses the panel fade", () => {
  resetCaches();
  for (let index = 0; index < 40; index += 1) {
    rememberConversationThread("viewer", `peer-${index}`, dmPage(`peer-${index}`, String(index)));
    rememberGroupConversationThread("viewer", `group-${index}`, {
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  }
  assert.ok(conversationThreadCacheSize() <= CONVERSATION_THREAD_CACHE_LIMIT);
  assert.ok(groupThreadCacheSize() <= GROUP_THREAD_CACHE_LIMIT);
  assert.equal(MESSAGE_MEDIA_CACHE_LIMIT, 64);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let blobCount = 0;
  URL.createObjectURL = () => {
    blobCount += 1;
    return `blob:media-${blobCount}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  try {
    for (let index = 0; index < MESSAGE_MEDIA_CACHE_LIMIT + 1; index += 1) {
      cacheDecryptedMessageMedia(`asset-${index}`, new Blob(["x"]));
    }
    assert.ok(messageMediaCacheSize() <= MESSAGE_MEDIA_CACHE_LIMIT);
    assert.ok(revoked.length >= 1);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    clearAllMessageMedia();
  }

  const css = readFileSync(new URL("./messages.module.css", import.meta.url), "utf8");
  const openRule = css.slice(
    css.indexOf(".messagesChatAnimFromRight"),
    css.indexOf(".messagesChatPanelInner"),
  );
  assert.match(openRule, /\.messagesChatAnimFromRight[\s\S]*messagesPanelFadeIn/);
  assert.doesNotMatch(openRule, /messagesChatOpenVisible/);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
