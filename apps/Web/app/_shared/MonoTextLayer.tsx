"use client";

import { useEffect } from "react";

const MONO_TEXT_ATTR = "data-flora-mono-text";
const SKIP_SELECTOR = "script, style, noscript";

interface ClientHintsNavigator extends Navigator {
  readonly userAgentData?: { readonly platform?: string };
}

/**
 * Color fringes are a Windows ClearType trait. Other platforms already paint text
 * with grayscale AA, so there the layer would only thin the glyphs without fixing
 * anything.
 */
function usesClearType(): boolean {
  const hints = (navigator as ClientHintsNavigator).userAgentData;
  return hints?.platform === "Windows";
}

/**
 * Windows ClearType paints light text on dark with RGB fringes. CSS compositing
 * hints on page containers do not reach text inside nested scrollers and sticky
 * headers, so mark the parent of every text node: the attribute forces a
 * composited layer on the element that actually paints the glyphs. The grayscale
 * layer reads heavier than ClearType, so the attribute also trims the variable
 * axis (`--flora-text-wght` in globals.css) back to the original weight.
 *
 * Presentation-only: no color or business state is changed.
 */
function markTextNode(node: Text): void {
  const value = node.nodeValue;
  if (!value || !value.trim()) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR)) return;
  parent.setAttribute(MONO_TEXT_ATTR, "");
}

function markSubtree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    markTextNode(root as Text);
    return;
  }
  if (!(root instanceof Element) || root.matches(SKIP_SELECTOR)) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    markTextNode(node as Text);
    node = walker.nextNode();
  }

  // Input values and placeholders are not text nodes.
  const fields = root.matches("input, textarea, select")
    ? [root as HTMLElement]
    : Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select"));
  for (const field of fields) field.setAttribute(MONO_TEXT_ATTR, "");
}

export function MonoTextLayer(): null {
  useEffect(() => {
    if (!usesClearType()) return;
    const body = document.body;
    markSubtree(body);

    let frame = 0;
    const pending = new Set<Node>();
    const flush = () => {
      frame = 0;
      for (const node of pending) markSubtree(node);
      pending.clear();
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          pending.add(mutation.target);
        } else {
          for (const node of mutation.addedNodes) pending.add(node);
        }
      }
      if (pending.size > 0 && frame === 0) {
        frame = window.requestAnimationFrame(flush);
      }
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      pending.clear();
    };
  }, []);

  return null;
}
