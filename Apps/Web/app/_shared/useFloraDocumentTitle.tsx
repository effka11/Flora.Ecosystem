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
    document.title = custom
      ? formatFloraDocumentTitle(custom)
      : resolveFloraDocumentTitle(pathname);
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
