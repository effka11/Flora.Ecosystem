import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTypingEmitter,
  PRESENCE_TYPING_IDLE_MS,
  PRESENCE_TYPING_REFRESH_MS,
} from "./typingEmitter.js";

describe("createTypingEmitter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const posts: boolean[] = [];
    const heartbeats: number[] = [];
    let clock = 0;
    const emitter = createTypingEmitter({
      postTyping: (isTyping) => {
        posts.push(isTyping);
      },
      onTrueHeartbeat: () => {
        heartbeats.push(clock);
      },
      now: () => clock,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (id) => clearTimeout(id),
    });
    const advance = (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    return { emitter, posts, heartbeats, advance, setClock: (t: number) => { clock = t; } };
  }

  it("posts true immediately on first non-empty text", () => {
    const { emitter, posts, heartbeats } = setup();
    emitter.onText("a");
    expect(posts).toEqual([true]);
    expect(heartbeats).toHaveLength(1);
  });

  it("throttles true refresh while typing rapidly", () => {
    const { emitter, posts, advance } = setup();
    emitter.onText("a");
    advance(200);
    emitter.onText("ab");
    advance(200);
    emitter.onText("abc");
    expect(posts).toEqual([true]);
    advance(PRESENCE_TYPING_REFRESH_MS - 400);
    emitter.onText("abcd");
    expect(posts).toEqual([true, true]);
  });

  it("posts false after idle with non-empty draft", () => {
    const { emitter, posts, advance } = setup();
    emitter.onText("hello");
    expect(posts).toEqual([true]);
    advance(PRESENCE_TYPING_IDLE_MS - 1);
    expect(posts).toEqual([true]);
    advance(1);
    expect(posts).toEqual([true, false]);
  });

  it("resets idle on each character", () => {
    const { emitter, posts, advance } = setup();
    emitter.onText("h");
    advance(PRESENCE_TYPING_IDLE_MS - 100);
    emitter.onText("hi");
    advance(PRESENCE_TYPING_IDLE_MS - 100);
    expect(posts.filter((p) => !p)).toHaveLength(0);
    advance(100);
    expect(posts.at(-1)).toBe(false);
  });

  it("posts false immediately on empty trim", () => {
    const { emitter, posts } = setup();
    emitter.onText("x");
    emitter.onText("   ");
    expect(posts).toEqual([true, false]);
  });

  it("posts true again after idle then next character", () => {
    const { emitter, posts, advance } = setup();
    emitter.onText("x");
    advance(PRESENCE_TYPING_IDLE_MS);
    expect(posts).toEqual([true, false]);
    emitter.onText("xy");
    expect(posts).toEqual([true, false, true]);
  });

  it("stop posts false only when active", () => {
    const { emitter, posts } = setup();
    emitter.stop();
    expect(posts).toEqual([]);
    emitter.onText("a");
    emitter.stop();
    expect(posts).toEqual([true, false]);
    emitter.stop();
    expect(posts).toEqual([true, false]);
  });

  it("dispose stops and ignores further text", () => {
    const { emitter, posts } = setup();
    emitter.onText("a");
    emitter.dispose();
    expect(posts).toEqual([true, false]);
    emitter.onText("ab");
    expect(posts).toEqual([true, false]);
  });
});
