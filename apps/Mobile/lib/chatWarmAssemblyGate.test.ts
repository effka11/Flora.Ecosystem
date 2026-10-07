import { describe, expect, it } from "vitest";
import {
  chatWarmAssemblyAllowed,
  createChatWarmAssemblyGate,
  createScrollBusyTracker,
} from "@/lib/chatWarmAssemblyGate";

type Scheduled = { run: () => void; ms: number; cancelled: boolean };

function manualScheduler() {
  const queue: Scheduled[] = [];
  const schedule = (run: () => void, ms: number) => {
    const entry: Scheduled = { run, ms, cancelled: false };
    queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const flush = () => {
    const pending = queue.splice(0);
    for (const entry of pending) {
      if (!entry.cancelled) entry.run();
    }
  };
  return { queue, schedule, flush };
}

function gateHarness() {
  const applied: boolean[] = [];
  const timer = manualScheduler();
  const gate = createChatWarmAssemblyGate({
    apply: (enabled) => applied.push(enabled),
    schedule: timer.schedule,
  });
  return { gate, applied, timer };
}

describe("chatWarmAssemblyAllowed", () => {
  it("needs a focused Messages screen and no scroll", () => {
    expect(chatWarmAssemblyAllowed({ focusedScreens: 1, scrollBusyOwners: 0 })).toBe(true);
    expect(chatWarmAssemblyAllowed({ focusedScreens: 0, scrollBusyOwners: 0 })).toBe(false);
    expect(chatWarmAssemblyAllowed({ focusedScreens: 1, scrollBusyOwners: 1 })).toBe(false);
    expect(chatWarmAssemblyAllowed({ focusedScreens: 2, scrollBusyOwners: 0 })).toBe(true);
  });
});

describe("chat warm assembly gate", () => {
  const list = Symbol("list");
  const shell = Symbol("shell");

  it("enables on the next scheduled tick after the list takes focus", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScreenFocused(list, true);
    expect(applied).toEqual([]);
    expect(timer.queue[0]?.ms).toBe(0);
    timer.flush();
    expect(applied).toEqual([true]);
    expect(gate.applied()).toBe(true);
  });

  it("keeps assembling when the thread shell takes focus from the list in one transition", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScreenFocused(list, true);
    timer.flush();
    // blur списка → focus оболочки: один переход, пуш треда.
    gate.setScreenFocused(list, false);
    expect(applied).toEqual([true, false]);
    gate.setScreenFocused(shell, true, 600);
    expect(applied).toEqual([true, false]);
    expect(timer.queue.at(-1)?.ms).toBe(600);
    timer.flush();
    expect(applied).toEqual([true, false, true]);
  });

  it("disables immediately when no Messages screen is focused", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScreenFocused(shell, true, 600);
    timer.flush();
    expect(applied).toEqual([true]);
    // Уход с вкладки, пока открыт тред: только оболочка теряет фокус.
    gate.setScreenFocused(shell, false);
    expect(applied).toEqual([true, false]);
    expect(gate.applied()).toBe(false);
  });

  it("cancels a pending enable when focus is lost before the tick", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScreenFocused(shell, true, 600);
    gate.setScreenFocused(shell, false);
    timer.flush();
    expect(applied).toEqual([]);
  });

  it("pauses for scroll and resumes a tick after it settles", () => {
    const { gate, applied, timer } = gateHarness();
    const thread = Symbol("thread");
    gate.setScreenFocused(shell, true);
    timer.flush();
    gate.setScrollBusy(thread, true);
    expect(applied).toEqual([true, false]);
    gate.setScrollBusy(thread, false);
    expect(applied).toEqual([true, false]);
    timer.flush();
    expect(applied).toEqual([true, false, true]);
  });

  it("does not enable while only scroll flips with no focused screen", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScrollBusy(list, true);
    gate.setScrollBusy(list, false);
    timer.flush();
    expect(applied).toEqual([]);
  });

  it("clearOwner drops focus and scroll of an unmounted screen at once", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScreenFocused(shell, true);
    gate.setScrollBusy(shell, true);
    timer.flush();
    expect(applied).toEqual([]);
    gate.clearOwner(shell);
    expect(gate.allowed()).toBe(false);
    timer.flush();
    expect(applied).toEqual([]);
  });

  it("does not re-apply an enable that is already in effect", () => {
    const { gate, applied, timer } = gateHarness();
    gate.setScreenFocused(list, true);
    timer.flush();
    gate.setScreenFocused(list, true);
    timer.flush();
    expect(applied).toEqual([true]);
  });
});

describe("scroll busy tracker", () => {
  function harness() {
    const busy: boolean[] = [];
    const timer = manualScheduler();
    const tracker = createScrollBusyTracker({
      setBusy: (next) => busy.push(next),
      schedule: timer.schedule,
      coastFallbackMs: 240,
    });
    return { busy, timer, tracker };
  }

  it("holds busy from drag through momentum and frees on momentum end", () => {
    const { busy, tracker } = harness();
    tracker.beginDrag();
    tracker.endDrag(1.4);
    tracker.momentumBegin();
    expect(busy).toEqual([true]);
    tracker.momentumEnd();
    expect(busy).toEqual([true, false]);
  });

  it("frees on release without velocity", () => {
    const { busy, tracker } = harness();
    tracker.beginDrag();
    tracker.endDrag(0);
    expect(busy).toEqual([true, false]);
  });

  it("frees by fallback when momentum never begins", () => {
    const { busy, timer, tracker } = harness();
    tracker.beginDrag();
    tracker.endDrag(0.6);
    expect(busy).toEqual([true]);
    expect(timer.queue[0]?.ms).toBe(240);
    timer.flush();
    expect(busy).toEqual([true, false]);
  });

  it("a new drag cancels the pending fallback", () => {
    const { busy, timer, tracker } = harness();
    tracker.beginDrag();
    tracker.endDrag(0.6);
    tracker.beginDrag();
    timer.flush();
    expect(busy).toEqual([true]);
    tracker.dispose();
    expect(busy).toEqual([true, false]);
  });
});
