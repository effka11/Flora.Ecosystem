"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { floraDurationMs } from "@/lib/floraMotion";

const FLIP_MS = floraDurationMs(2);
const TAB_SWAP_FADE_MS = floraDurationMs(6);
const FLIP_MIN_DELTA_PX = 2;
const FOOTER_KEY = "footer";
const SCOPE_IDS_SEP = "\x1e";

export function buildComposeDraftsFlipStructureKey(
  composeScopeId: string,
  draftIds: readonly string[],
  canAddDraft: boolean,
): string {
  return `${composeScopeId}${SCOPE_IDS_SEP}${draftIds.join("\0")}|${canAddDraft ? 1 : 0}`;
}

function parseStructureKey(key: string): { scopeId: string; draftIds: string[]; canAddDraft: boolean } {
  const separator = key.lastIndexOf("|");
  if (separator < 0) return { scopeId: "", draftIds: [], canAddDraft: true };

  const canAddDraft = key.slice(separator + 1) === "1";
  const scopeAndIds = key.slice(0, separator);
  const scopeSep = scopeAndIds.indexOf(SCOPE_IDS_SEP);
  if (scopeSep < 0) {
    const draftIds = scopeAndIds ? scopeAndIds.split("\0") : [];
    return { scopeId: "", draftIds, canAddDraft };
  }

  const scopeId = scopeAndIds.slice(0, scopeSep);
  const idsPart = scopeAndIds.slice(scopeSep + 1);
  const draftIds = idsPart ? idsPart.split("\0") : [];
  return { scopeId, draftIds, canAddDraft };
}

function getDraftRowElements(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>("[data-compose-flip-key]")].filter(
    (el) => el.dataset.composeFlipKey !== FOOTER_KEY,
  );
}

function animateFlip(el: HTMLElement, deltaY: number) {
  el.style.transition = "none";
  el.style.transform = `translateY(${deltaY}px)`;
  requestAnimationFrame(() => {
    el.style.transition = `transform ${FLIP_MS}ms var(--flora-ease-out)`;
    el.style.transform = "";
  });
}

function animateFadeIn(el: HTMLElement, durationMs: number) {
  el.style.transition = "none";
  el.style.opacity = "0";
  requestAnimationFrame(() => {
    el.style.transition = `opacity ${durationMs}ms var(--flora-ease-out)`;
    el.style.opacity = "";
  });
}

function animateFooterFlip(
  list: HTMLElement,
  topsRef: Map<string, number>,
  nextTops: Map<string, number>,
) {
  const footer = list.querySelector<HTMLElement>(`[data-compose-flip-key="${FOOTER_KEY}"]`);
  if (!footer) return;

  const prevTop = topsRef.get(FOOTER_KEY);
  const relTop = nextTops.get(FOOTER_KEY);
  if (prevTop === undefined || relTop === undefined) return;

  const deltaY = prevTop - relTop;
  if (Math.abs(deltaY) < FLIP_MIN_DELTA_PX) return;

  animateFlip(footer, deltaY);
}

/** FLIP + fade сайдбара черновиков: add/remove в scope и смена вкладки compose. */
export function useComposeDraftsSidebarFlip(
  listRef: RefObject<HTMLUListElement | null>,
  structureKey: string,
) {
  const topsRef = useRef<Map<string, number>>(new Map());
  const indexTopsRef = useRef<number[]>([]);
  const primedRef = useRef(false);
  const prevStructureKeyRef = useRef(structureKey);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const listTop = list.getBoundingClientRect().top;
    const draftRows = getDraftRowElements(list);
    const nextIndexTops = draftRows.map((el) => el.getBoundingClientRect().top - listTop);
    const nextTops = new Map<string, number>();

    list.querySelectorAll<HTMLElement>("[data-compose-flip-key]").forEach((el) => {
      const key = el.dataset.composeFlipKey;
      if (!key) return;
      nextTops.set(key, el.getBoundingClientRect().top - listTop);
    });

    const prevStructure = parseStructureKey(prevStructureKeyRef.current);
    const nextStructure = parseStructureKey(structureKey);
    const prevIdSet = new Set(prevStructure.draftIds);
    const nextIdSet = new Set(nextStructure.draftIds);
    const addedDraftIds = new Set(nextStructure.draftIds.filter((id) => !prevIdSet.has(id)));
    const removedDraftIds = new Set(prevStructure.draftIds.filter((id) => !nextIdSet.has(id)));
    const structureMutated = addedDraftIds.size > 0 || removedDraftIds.size > 0;
    const skipBatchFade =
      prevStructure.draftIds.length === 0 &&
      addedDraftIds.size > 1 &&
      prevStructure.scopeId === nextStructure.scopeId;
    const scopeSwitched = prevStructure.scopeId !== nextStructure.scopeId;
    const idOverlap = nextStructure.draftIds.some((id) => prevIdSet.has(id));
    const fullDraftSetSwap =
      prevStructure.draftIds.length > 0 &&
      nextStructure.draftIds.length > 0 &&
      addedDraftIds.size > 0 &&
      removedDraftIds.size > 0 &&
      !idOverlap;
    // Клик по вкладке до ответа API: те же id, другой scope — не дёргать список.
    const skipStaleScopeFrame =
      scopeSwitched && addedDraftIds.size === 0 && removedDraftIds.size === 0;

    if (primedRef.current && !skipStaleScopeFrame) {
      if (fullDraftSetSwap) {
        const prevIndexTops = indexTopsRef.current;
        draftRows.forEach((el, index) => {
          const prevTop = prevIndexTops[index];
          const newTop = nextIndexTops[index];
          if (prevTop !== undefined && newTop !== undefined) {
            const deltaY = prevTop - newTop;
            if (Math.abs(deltaY) >= FLIP_MIN_DELTA_PX) {
              animateFlip(el, deltaY);
            }
          }
          animateFadeIn(el, TAB_SWAP_FADE_MS);
        });
        animateFooterFlip(list, topsRef.current, nextTops);
      } else if (!scopeSwitched) {
        const flipCandidates: { el: HTMLElement; deltaY: number }[] = [];

        list.querySelectorAll<HTMLElement>("[data-compose-flip-key]").forEach((el) => {
          const key = el.dataset.composeFlipKey;
          if (!key) return;

          const relTop = nextTops.get(key);
          if (relTop === undefined) return;

          const prevTop = topsRef.current.get(key);
          if (prevTop === undefined) {
            if (key !== FOOTER_KEY && addedDraftIds.has(key) && !skipBatchFade) {
              animateFadeIn(el, FLIP_MS);
            }
            return;
          }

          const deltaY = prevTop - relTop;
          if (Math.abs(deltaY) < FLIP_MIN_DELTA_PX) return;

          flipCandidates.push({ el, deltaY });
        });

        if (!structureMutated && flipCandidates.length > 1) {
          const firstDelta = flipCandidates[0].deltaY;
          const uniformShift = flipCandidates.every(
            (candidate) => Math.abs(candidate.deltaY - firstDelta) < 1,
          );
          if (uniformShift) {
            flipCandidates.length = 0;
          }
        }

        for (const { el, deltaY } of flipCandidates) {
          animateFlip(el, deltaY);
        }
      }
    }

    primedRef.current = true;
    topsRef.current = nextTops;
    indexTopsRef.current = nextIndexTops;
    prevStructureKeyRef.current = structureKey;
  }, [listRef, structureKey]);
}
