import { describe, expect, it } from "vitest";

import { sliceThreadListToViewport } from "@/lib/threadListWindow";
import type { ThreadListItem } from "@/lib/threadMessageGroups";

/** Однострочный текст ≈ TEXT_BASE_INSERT_LIFT_PX (52 px) на строку. */
function ownText(uuid: string, text = "ok"): ThreadListItem {
  return {
    kind: "own",
    message: { messageUuid: uuid, text, imageBlocks: [] },
  } as unknown as ThreadListItem;
}

function ownImage(uuid: string): ThreadListItem {
  return {
    kind: "own",
    message: { messageUuid: uuid, text: "", imageBlocks: [{}] },
  } as unknown as ThreadListItem;
}

function peerText(uuid: string, groupKey: string, isGroupTail = false): ThreadListItem {
  return {
    kind: "peer",
    groupKey,
    isGroupTail,
    message: { messageUuid: uuid, text: "a", imageBlocks: [] },
  } as unknown as ThreadListItem;
}

const ctx = { own: { maxInnerWidthPx: 280 }, peer: { maxInnerWidthPx: 260 } };

describe("sliceThreadListToViewport", () => {
  it("короткий список возвращает по ссылке (без среза)", () => {
    const items = [ownText("a"), ownText("b")];
    expect(sliceThreadListToViewport(items, 500, ctx)).toBe(items);
  });

  it("режет медиа-ленту по накопленной оценке", () => {
    // 12 фото-строк по 220 px: цель 1000 px должна закрыться ~5 строками.
    const items = Array.from({ length: 12 }, (_, i) => ownImage(`img-${i}`));
    const sliced = sliceThreadListToViewport(items, 1000, ctx);
    expect(sliced.length).toBeGreaterThanOrEqual(5);
    expect(sliced.length).toBeLessThan(12);
    // Срез — головной (новые сообщения, индекс 0 у якоря).
    expect(sliced[0]).toBe(items[0]);
  });

  it("держит минимум строк при завышенных оценках", () => {
    const items = Array.from({ length: 12 }, (_, i) => ownImage(`img-${i}`));
    // Цель 1 px — без минимума окно бы выродилось в одну строку. Минимум —
    // ровно страховка: полноэкранные пузыри не должны тянуть лишние экраны.
    expect(sliceThreadListToViewport(items, 1, ctx).length).toBe(4);
  });

  it("текстовая лента без достижения цели возвращается целиком по ссылке", () => {
    const items = Array.from({ length: 16 }, (_, i) => ownText(`t-${i}`));
    // 16 × 52 = 832 < 1020 — реального среза нет, ссылка та же.
    expect(sliceThreadListToViewport(items, 1020, ctx)).toBe(items);
  });

  it("peer-строки взвешиваются по-пузырно", () => {
    // 20 peer-однострочников по 52 px: цель 520 закрывается десятью строками.
    const items = Array.from({ length: 20 }, (_, i) =>
      peerText(`p-${i}`, "g", i === 0),
    );
    const sliced = sliceThreadListToViewport(items, 520, ctx);
    expect(sliced.length).toBe(10);
    expect(sliced[0]).toBe(items[0]);
  });
});
