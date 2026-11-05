"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_WEB_FLORA_THEME_ID,
  WEB_FLORA_THEME_ATTR,
  WEB_FLORA_THEME_STORAGE_KEY,
  readStoredWebFloraTheme,
  writeStoredWebFloraTheme,
  type WebFloraThemeId,
} from "@/lib/floraTheme";

const THEME_TRANSITION_MS = 240;

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

type FloraThemeContextValue = {
  themeId: WebFloraThemeId;
  savedThemeId: WebFloraThemeId;
  previewTheme: (themeId: WebFloraThemeId) => void;
  commitTheme: (themeId?: WebFloraThemeId) => void;
  discardPreview: () => void;
};

const FloraThemeContext = createContext<FloraThemeContextValue | null>(null);

function setThemeAttribute(themeId: WebFloraThemeId): void {
  document.documentElement.setAttribute(WEB_FLORA_THEME_ATTR, themeId);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Global web theme owner.
 *
 * `previewTheme` applies immediately without persisting (settings draft),
 * `commitTheme` writes the choice to `flora.userSettings.prefs`, and
 * `discardPreview` returns to the saved theme.
 */
export function FloraThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<WebFloraThemeId>(DEFAULT_WEB_FLORA_THEME_ID);
  const [savedThemeId, setSavedThemeId] = useState<WebFloraThemeId>(DEFAULT_WEB_FLORA_THEME_ID);
  const themeRef = useRef<WebFloraThemeId>(DEFAULT_WEB_FLORA_THEME_ID);
  const savedRef = useRef<WebFloraThemeId>(DEFAULT_WEB_FLORA_THEME_ID);

  const applyTheme = useCallback((next: WebFloraThemeId) => {
    if (next === themeRef.current) return;
    themeRef.current = next;

    const commit = () => {
      setThemeAttribute(next);
      setThemeId(next);
    };

    if (prefersReducedMotion()) {
      commit();
      return;
    }

    const doc = document as ViewTransitionDocument;
    if (typeof doc.startViewTransition === "function") {
      try {
        doc.startViewTransition(commit);
        return;
      } catch {
        commit();
        return;
      }
    }

    // Fallback for browsers without View Transitions: animate color changes
    // for one frame, then apply the palette.
    const root = document.documentElement;
    root.classList.add("flora-theme-transition");
    void root.offsetWidth;
    commit();
    window.setTimeout(() => root.classList.remove("flora-theme-transition"), THEME_TRANSITION_MS);
  }, []);

  useEffect(() => {
    const stored = readStoredWebFloraTheme();
    savedRef.current = stored;
    themeRef.current = stored;
    // One-time hydration sync from localStorage: the inline script already set
    // the attribute before paint, so this only aligns React state with the DOM.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedThemeId(stored);
    setThemeId(stored);
    setThemeAttribute(stored);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== WEB_FLORA_THEME_STORAGE_KEY) return;
      const stored = readStoredWebFloraTheme();
      savedRef.current = stored;
      setSavedThemeId(stored);
      applyTheme(stored);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyTheme]);

  const previewTheme = useCallback(
    (next: WebFloraThemeId) => {
      applyTheme(next);
    },
    [applyTheme],
  );

  const commitTheme = useCallback(
    (next?: WebFloraThemeId) => {
      const id = next ?? themeRef.current;
      writeStoredWebFloraTheme(id);
      savedRef.current = id;
      setSavedThemeId(id);
      applyTheme(id);
    },
    [applyTheme],
  );

  const discardPreview = useCallback(() => {
    applyTheme(savedRef.current);
  }, [applyTheme]);

  const value = useMemo<FloraThemeContextValue>(
    () => ({ themeId, savedThemeId, previewTheme, commitTheme, discardPreview }),
    [themeId, savedThemeId, previewTheme, commitTheme, discardPreview],
  );

  return <FloraThemeContext.Provider value={value}>{children}</FloraThemeContext.Provider>;
}

export function useFloraTheme(): FloraThemeContextValue {
  const value = useContext(FloraThemeContext);
  if (!value) {
    throw new Error("useFloraTheme must be used inside FloraThemeProvider");
  }
  return value;
}
