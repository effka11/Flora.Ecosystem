import { describe, expect, it } from "vitest";
import {
  shouldForceChatListMount,
  shouldForceChatSurfaceOpen,
  shouldRecoverReveal,
  shouldUnmountEnterCover,
} from "@/lib/chatThreadVisibility";

describe("reveal watchdog", () => {
  it("recovers only a started reveal that never committed", () => {
    expect(shouldRecoverReveal({ revealStarted: true, revealed: false })).toBe(true);
    expect(shouldRecoverReveal({ revealStarted: true, revealed: true })).toBe(false);
    // Цикл не запускался (лента спрятана намеренно) — watchdog не вмешивается.
    expect(shouldRecoverReveal({ revealStarted: false, revealed: false })).toBe(false);
  });
});

describe("enter cover unmount", () => {
  it("removes the opaque cover only after the list is revealed", () => {
    expect(shouldUnmountEnterCover(true)).toBe(true);
    expect(shouldUnmountEnterCover(false)).toBe(false);
  });
});

describe("push surface repair", () => {
  it("forces an open route back into frame even with a stuck driven flag", () => {
    expect(
      shouldForceChatSurfaceOpen({ surfaceOpen: true, offEdge: true, exiting: false }),
    ).toBe(true);
    // Анимация уже вывезла surface из-за края — это нормальный старт входа.
    expect(
      shouldForceChatSurfaceOpen({ surfaceOpen: true, offEdge: false, exiting: false }),
    ).toBe(false);
    // Идёт выход: принудительное открытие перебило бы слайд.
    expect(
      shouldForceChatSurfaceOpen({ surfaceOpen: true, offEdge: true, exiting: true }),
    ).toBe(false);
    // Маршрут не открыт (парковка/список) — чинить нечего.
    expect(
      shouldForceChatSurfaceOpen({ surfaceOpen: false, offEdge: true, exiting: false }),
    ).toBe(false);
  });
});

describe("list mount watchdog", () => {
  it("mounts the list when the route is open but the latch never opened", () => {
    expect(shouldForceChatListMount({ surfaceOpen: true, listMounted: false })).toBe(true);
    expect(shouldForceChatListMount({ surfaceOpen: true, listMounted: true })).toBe(false);
    expect(shouldForceChatListMount({ surfaceOpen: false, listMounted: false })).toBe(false);
  });
});
