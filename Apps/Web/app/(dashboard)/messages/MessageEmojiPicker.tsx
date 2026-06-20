"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EmojiCategoryId, MessageEmojiCategory } from "./messageEmojiCategories";
import {
  findEmojiVisibleRowRange,
  findRowIndexAtOrBefore,
  getEmojiVirtualModel,
  type EmojiVirtualModel,
} from "./messageEmojiLayout";
import { patchEmojiVirtualRows } from "./messageEmojiVirtualDom";
import styles from "./messages.module.css";

type MessageEmojiPickerContextValue = {
  categories: readonly MessageEmojiCategory[] | null;
  virtualModel: EmojiVirtualModel | null;
  scrollToCategory: (categoryId: EmojiCategoryId) => void;
  syncCategoryFromScroll: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  railNavRef: React.RefObject<HTMLElement | null>;
};

const MessageEmojiPickerContext = createContext<MessageEmojiPickerContextValue | null>(null);

function useMessageEmojiPickerContext(): MessageEmojiPickerContextValue {
  const ctx = useContext(MessageEmojiPickerContext);
  if (!ctx) throw new Error("MessageEmojiPicker.* must be used inside MessageEmojiPicker");
  return ctx;
}

type CategoriesModule = typeof import("./messageEmojiCategories");

let categoriesModuleCache: CategoriesModule | null = null;
let categoriesLoadPromise: Promise<CategoriesModule> | null = null;

function loadEmojiCategories(): Promise<CategoriesModule> {
  if (categoriesModuleCache) return Promise.resolve(categoriesModuleCache);
  if (!categoriesLoadPromise) {
    categoriesLoadPromise = import("./messageEmojiCategories").then((mod) => {
      categoriesModuleCache = mod;
      getEmojiVirtualModel(mod.MESSAGE_EMOJI_CATEGORIES);
      return mod;
    });
  }
  return categoriesLoadPromise;
}

/** Вызвать при входе в чат — панель откроется без паузы на import. */
export function preloadMessageEmojiPicker(): void {
  void loadEmojiCategories();
}

function setRailActiveCategory(nav: HTMLElement | null, categoryId: EmojiCategoryId): void {
  if (!nav) return;
  nav.querySelectorAll<HTMLButtonElement>("[data-emoji-category]").forEach((button) => {
    if (button.dataset.emojiCategory === categoryId) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
}

function useMessageEmojiPickerState(active: boolean): MessageEmojiPickerContextValue {
  const [categories, setCategories] = useState<readonly MessageEmojiCategory[] | null>(() =>
    categoriesModuleCache?.MESSAGE_EMOJI_CATEGORIES ?? null,
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railNavRef = useRef<HTMLElement | null>(null);
  const scrollLockRef = useRef(false);
  const scrollUnlockTimerRef = useRef<number | null>(null);
  const scrollGenerationRef = useRef(0);
  const activeCategoryRef = useRef<EmojiCategoryId>("smileys_emotion");
  const virtualModelRef = useRef<EmojiVirtualModel | null>(null);

  const virtualModel = categories ? getEmojiVirtualModel(categories) : null;
  virtualModelRef.current = virtualModel;

  useEffect(() => {
    if (!active) return;
    if (categories) return;
    let cancelled = false;
    void loadEmojiCategories().then((mod) => {
      if (cancelled) return;
      const list = mod.MESSAGE_EMOJI_CATEGORIES;
      setCategories(list);
      const firstId = list[0]?.id ?? "smileys_emotion";
      activeCategoryRef.current = firstId;
      setRailActiveCategory(railNavRef.current, firstId);
    });
    return () => {
      cancelled = true;
    };
  }, [active, categories]);

  useLayoutEffect(() => {
    if (!active) return;
    const scrollRoot = scrollRef.current;
    if (!scrollRoot) return;
    scrollRoot.scrollTop = 0;
    const firstId = categories?.[0]?.id ?? "smileys_emotion";
    activeCategoryRef.current = firstId;
    setRailActiveCategory(railNavRef.current, firstId);
  }, [active, categories]);

  const syncCategoryFromScroll = useCallback(() => {
    const scrollRoot = scrollRef.current;
    const model = virtualModelRef.current;
    if (!scrollRoot || scrollLockRef.current || !model || model.rows.length === 0) return;

    const scrollTop = scrollRoot.scrollTop;
    const maxScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);

    let nextId: EmojiCategoryId;
    if (scrollTop >= maxScroll - 2) {
      nextId = model.sections[model.sections.length - 1]?.categoryId ?? activeCategoryRef.current;
    } else {
      const rowIndex = findRowIndexAtOrBefore(model.rowOffsetTops, scrollTop + 4);
      const sectionIndex = model.sectionIndexByRow[rowIndex] ?? 0;
      nextId = model.sections[sectionIndex]?.categoryId ?? activeCategoryRef.current;
    }

    if (activeCategoryRef.current === nextId) return;
    activeCategoryRef.current = nextId;
    setRailActiveCategory(railNavRef.current, nextId);
  }, []);

  const scrollToCategory = useCallback(
    (categoryId: EmojiCategoryId) => {
      const scrollRoot = scrollRef.current;
      const model = virtualModelRef.current;
      if (!scrollRoot || !model) return;

      const section = model.sectionByCategoryId.get(categoryId);
      if (!section) return;

      const scrollGeneration = scrollGenerationRef.current + 1;
      scrollGenerationRef.current = scrollGeneration;

      if (scrollUnlockTimerRef.current !== null) {
        window.clearTimeout(scrollUnlockTimerRef.current);
        scrollUnlockTimerRef.current = null;
      }

      scrollLockRef.current = true;
      activeCategoryRef.current = categoryId;
      setRailActiveCategory(railNavRef.current, categoryId);
      scrollRoot.scrollTo({ top: section.firstRowOffsetTop, behavior: "smooth" });

      const unlock = () => {
        if (scrollGenerationRef.current !== scrollGeneration) return;
        scrollLockRef.current = false;
        if (scrollUnlockTimerRef.current !== null) {
          window.clearTimeout(scrollUnlockTimerRef.current);
          scrollUnlockTimerRef.current = null;
        }
        syncCategoryFromScroll();
      };

      scrollUnlockTimerRef.current = window.setTimeout(unlock, 520);
      scrollRoot.addEventListener("scrollend", unlock, { once: true });
    },
    [syncCategoryFromScroll],
  );

  return {
    categories,
    virtualModel,
    scrollToCategory,
    syncCategoryFromScroll,
    scrollRef,
    railNavRef,
  };
}

type VirtualEmojiGridProps = {
  model: EmojiVirtualModel;
  scrollRoot: HTMLDivElement;
  onPick: (emoji: string) => void;
  onScrollFrame: () => void;
};

/** Императивная сетка: при скролле нет React-перерисовки строк, только patch DOM. */
function VirtualEmojiGrid({ model, scrollRoot, onPick, onScrollFrame }: VirtualEmojiGridProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowPoolRef = useRef(new Map<string, HTMLDivElement>());
  const visibleRangeRef = useRef({ start: 0, end: Math.min(model.rows.length, 24) });
  const onPickRef = useRef(onPick);
  const onScrollFrameRef = useRef(onScrollFrame);
  onPickRef.current = onPick;
  onScrollFrameRef.current = onScrollFrame;

  const applyVisibleRange = useCallback(
    (start: number, end: number) => {
      const body = bodyRef.current;
      if (!body) return;
      visibleRangeRef.current = { start, end };
      patchEmojiVirtualRows(body, model.rows, start, end, rowPoolRef.current);
    },
    [model.rows],
  );

  const updateVisibleRange = useCallback(() => {
    if (model.rows.length === 0) return;
    const next = findEmojiVisibleRowRange(model, scrollRoot.scrollTop, scrollRoot.clientHeight);
    const prev = visibleRangeRef.current;
    if (next.start === prev.start && next.end === prev.end) return;
    applyVisibleRange(next.start, next.end);
  }, [applyVisibleRange, model, scrollRoot]);

  useLayoutEffect(() => {
    const initialEnd = Math.min(model.rows.length, 24);
    applyVisibleRange(0, initialEnd);
    updateVisibleRange();
    onScrollFrameRef.current();
  }, [applyVisibleRange, model, updateVisibleRange]);

  useEffect(() => {
    let scrollRafId = 0;
    const onScroll = () => {
      if (scrollRafId !== 0) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        updateVisibleRange();
        onScrollFrameRef.current();
      });
    };

    let resizeRafId = 0;
    const onResize = () => {
      if (resizeRafId !== 0) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        updateVisibleRange();
      });
    };

    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(scrollRoot);

    return () => {
      scrollRoot.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
      if (scrollRafId !== 0) cancelAnimationFrame(scrollRafId);
      if (resizeRafId !== 0) cancelAnimationFrame(resizeRafId);
      rowPoolRef.current.clear();
    };
  }, [scrollRoot, updateVisibleRange]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>("[data-emoji]");
    const emoji = cell?.dataset.emoji;
    if (emoji) onPickRef.current(emoji);
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>("[data-emoji]");
    const emoji = cell?.dataset.emoji;
    if (!emoji) return;
    event.preventDefault();
    onPickRef.current(emoji);
  }, []);

  return (
    <div
      ref={bodyRef}
      className={styles.messagesEmojiVirtualBody}
      style={{ height: model.totalHeight }}
      role="grid"
      aria-label="Сетка эмодзи"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}

const VirtualEmojiGridMemo = memo(VirtualEmojiGrid);

export function MessageEmojiPicker({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const value = useMessageEmojiPickerState(active);
  return (
    <MessageEmojiPickerContext.Provider value={value}>{children}</MessageEmojiPickerContext.Provider>
  );
}

const RailCategoryButton = memo(function RailCategoryButton({
  category,
  isFirst,
  onSelect,
}: {
  category: MessageEmojiCategory;
  isFirst: boolean;
  onSelect: (id: EmojiCategoryId) => void;
}) {
  return (
    <button
      type="button"
      className={styles.messagesEmojiCategoryButton}
      data-emoji-category={category.id}
      aria-label={category.label}
      aria-current={isFirst ? "true" : undefined}
      onClick={() => onSelect(category.id)}
    >
      <span aria-hidden>{category.icon}</span>
    </button>
  );
});

export function MessageEmojiPickerRail({ collapsed = false }: { collapsed?: boolean }) {
  const { categories, scrollToCategory, railNavRef } = useMessageEmojiPickerContext();
  const railClassName = collapsed
    ? `${styles.messagesEmojiCategoryRail} ${styles.messagesEmojiCategoryRailCollapsed}`
    : styles.messagesEmojiCategoryRail;

  if (!categories) {
    return <nav className={railClassName} aria-label="Категории эмодзи" aria-busy="true" />;
  }

  return (
    <nav
      ref={railNavRef}
      className={railClassName}
      aria-label="Категории эмодзи"
      aria-hidden={collapsed ? true : undefined}
    >
      {categories.map((category, index) => (
        <RailCategoryButton
          key={category.id}
          category={category}
          isFirst={index === 0}
          onSelect={scrollToCategory}
        />
      ))}
    </nav>
  );
}

export function MessageEmojiPickerGrid({
  onPick,
  panelClassName,
}: {
  onPick: (emoji: string) => void;
  panelClassName?: string;
}) {
  const { categories, virtualModel, scrollRef, syncCategoryFromScroll } = useMessageEmojiPickerContext();
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

  const bindScrollRoot = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      setScrollRoot(node);
    },
    [scrollRef],
  );

  return (
    <div
      id="messages-sticker-panel-emoji"
      role="tabpanel"
      className={panelClassName ?? styles.messagesStickerTabPanel}
      aria-labelledby="messages-sticker-tab-emoji"
      aria-busy={categories ? undefined : "true"}
    >
      <div ref={bindScrollRoot} className={styles.messagesEmojiGridWrap}>
        {virtualModel && scrollRoot ? (
          <VirtualEmojiGridMemo
            model={virtualModel}
            scrollRoot={scrollRoot}
            onPick={onPick}
            onScrollFrame={syncCategoryFromScroll}
          />
        ) : null}
      </div>
    </div>
  );
}
