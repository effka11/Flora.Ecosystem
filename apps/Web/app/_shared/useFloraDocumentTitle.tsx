"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePathname } from "next/navigation";
import { formatFloraDocumentTitle, resolveFloraDocumentTitle } from "@/lib/floraDocumentTitle";

const FloraDocumentTitleOverrideContext = createContext<Dispatch<SetStateAction<string | null>> | null>(
  null,
);

export function FloraDocumentTitleProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [override, setOverride] = useState<string | null>(null);

  useEffect(() => {
    const custom = override?.trim();
    if (!custom) {
      // Без override не трогаем title — его задаёт Next metadata (как /rules),
      // иначе `document.title = …` может схлопнуть NBSP во вкладке.
      return;
    }

    document.title = formatFloraDocumentTitle(custom);
    return () => {
      document.title = resolveFloraDocumentTitle(pathname);
    };
  }, [override, pathname]);

  return (
    <FloraDocumentTitleOverrideContext.Provider value={setOverride}>
      {children}
    </FloraDocumentTitleOverrideContext.Provider>
  );
}

/** Подставить имя с API поверх заголовка по маршруту (профиль, сообщество, плейлист…). */
export function useFloraPageTitleOverride(pageTitle: string | null | undefined): void {
  const setOverride = useContext(FloraDocumentTitleOverrideContext);

  useEffect(() => {
    if (!setOverride) return;
    const trimmed = pageTitle?.trim();
    setOverride(trimmed && trimmed.length > 0 ? trimmed : null);
    return () => setOverride(null);
  }, [pageTitle, setOverride]);
}
