import { describe, expect, it } from "vitest";

import {
  createMeasureWarmQueue,
  type TextMeasureRequest,
} from "@/lib/messageTextMeasureWarmQueue";

function queueWithCache(cached: {
  bodies?: Set<string>;
  timeLabels?: Set<string>;
}) {
  const bodies = cached.bodies ?? new Set<string>();
  const timeLabels = cached.timeLabels ?? new Set<string>();
  return createMeasureWarmQueue({
    hasBodyMeasure: (body, width) => bodies.has(`${width}|${body}`),
    hasTimeLabelWidth: (label) => timeLabels.has(label),
  });
}

const request = (over: Partial<TextMeasureRequest> = {}): TextMeasureRequest => ({
  body: "привет",
  maxInnerWidthPx: 240,
  timeLabel: "12:30",
  ...over,
});

describe("createMeasureWarmQueue", () => {
  it("ставит заявку и отдаёт её пачкой", () => {
    const queue = queueWithCache({});
    queue.enqueue([request()]);
    expect(queue.size()).toBe(1);
    const batch = queue.takeBatch(8);
    expect(batch).toEqual([request()]);
    expect(queue.size()).toBe(0);
  });

  it("не ставит заявку, если и тело, и метка уже в кэше", () => {
    const queue = queueWithCache({
      bodies: new Set(["240|привет"]),
      timeLabels: new Set(["12:30"]),
    });
    queue.enqueue([request()]);
    expect(queue.size()).toBe(0);
  });

  it("мерит только метку, когда тело уже в кэше", () => {
    const queue = queueWithCache({ bodies: new Set(["240|привет"]) });
    queue.enqueue([request()]);
    expect(queue.takeBatch(8)).toEqual([
      { body: "", maxInnerWidthPx: 240, timeLabel: "12:30" },
    ]);
  });

  it("мерит только тело, когда метка уже в кэше", () => {
    const queue = queueWithCache({ timeLabels: new Set(["12:30"]) });
    queue.enqueue([request()]);
    expect(queue.takeBatch(8)).toEqual([
      { body: "привет", maxInnerWidthPx: 240, timeLabel: "" },
    ]);
  });

  it("дедуплицирует одинаковые тело+ширину", () => {
    const queue = queueWithCache({});
    queue.enqueue([request(), request(), request({ timeLabel: "12:31" })]);
    expect(queue.size()).toBe(1);
  });

  it("считает разные ширины разными заявками", () => {
    const queue = queueWithCache({});
    queue.enqueue([request(), request({ maxInnerWidthPx: 300 })]);
    expect(queue.size()).toBe(2);
  });

  it("пропускает пустое тело без метки", () => {
    const queue = queueWithCache({ timeLabels: new Set(["12:30"]) });
    queue.enqueue([request({ body: "   " })]);
    expect(queue.size()).toBe(0);
  });

  it("пропускает нулевую ширину, но метку берёт", () => {
    const queue = queueWithCache({});
    queue.enqueue([request({ maxInnerWidthPx: 0 })]);
    expect(queue.takeBatch(8)).toEqual([
      { body: "", maxInnerWidthPx: 0, timeLabel: "12:30" },
    ]);
  });

  it("не выдаёт повторно заявку, пока пачка не исполнена", () => {
    const queue = queueWithCache({});
    queue.enqueue([request()]);
    const batch = queue.takeBatch(8);
    queue.enqueue([request()]);
    expect(queue.size()).toBe(0);
    queue.settleBatch(batch);
    queue.enqueue([request()]);
    expect(queue.size()).toBe(1);
  });

  it("режет пачку по maxSize и сохраняет порядок постановки", () => {
    const queue = queueWithCache({});
    queue.enqueue([
      request({ body: "a" }),
      request({ body: "b" }),
      request({ body: "c" }),
    ]);
    expect(queue.takeBatch(2).map((r) => r.body)).toEqual(["a", "b"]);
    expect(queue.takeBatch(2).map((r) => r.body)).toEqual(["c"]);
  });

  it("уведомляет подписчика только на реально добавленные заявки", () => {
    const queue = queueWithCache({ bodies: new Set(["240|привет"]), timeLabels: new Set(["12:30"]) });
    let calls = 0;
    const unsubscribe = queue.subscribe(() => {
      calls += 1;
    });
    queue.enqueue([request()]);
    expect(calls).toBe(0);
    queue.enqueue([request({ body: "новое" })]);
    expect(calls).toBe(1);
    unsubscribe();
    queue.enqueue([request({ body: "ещё" })]);
    expect(calls).toBe(1);
  });

  it("держит потолок очереди, отбрасывая самые старые заявки", () => {
    const queue = queueWithCache({});
    for (let i = 0; i < 450; i++) {
      queue.enqueue([request({ body: `msg-${i}` })]);
    }
    expect(queue.size()).toBe(400);
    // Осталась свежая верхушка: старые вытеснены.
    expect(queue.takeBatch(1)[0]?.body).toBe("msg-50");
  });

  it("clear снимает и очередь, и заявки в работе", () => {
    const queue = queueWithCache({});
    queue.enqueue([request()]);
    queue.takeBatch(8);
    queue.clear();
    queue.enqueue([request()]);
    expect(queue.size()).toBe(1);
  });
});
