import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { FrcRowMediaMode } from "@/lib/frcMediaMode";

/**
 * Pane-level media map: which rows (by post uuid) may decode and in what mode.
 * A disabled pane (inactive pager page) exposes an empty map so nothing decodes.
 */
type PaneMediaContextValue = {
  enabled: boolean;
  modes: Map<string, FrcRowMediaMode>;
};

const PaneMediaContext = createContext<PaneMediaContextValue>({
  enabled: false,
  modes: new Map(),
});

/** Resolved mode for the row currently rendering; `undefined` → do not decode. */
const RowMediaModeContext = createContext<FrcRowMediaMode | undefined>(undefined);

export function FrcMediaModeScope({
  enabled,
  modes,
  children,
}: {
  enabled: boolean;
  modes: Map<string, FrcRowMediaMode>;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ enabled, modes }), [enabled, modes]);
  return <PaneMediaContext.Provider value={value}>{children}</PaneMediaContext.Provider>;
}

export function FrcRowMediaScope({
  postUuid,
  children,
}: {
  postUuid: string;
  children: ReactNode;
}) {
  const { enabled, modes } = useContext(PaneMediaContext);
  const mode = enabled ? modes.get(postUuid) : undefined;
  return <RowMediaModeContext.Provider value={mode}>{children}</RowMediaModeContext.Provider>;
}

/** The current row's media mode; `undefined` when the row should not decode. */
export function useFrcRowMediaMode(): FrcRowMediaMode | undefined {
  return useContext(RowMediaModeContext);
}
