import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { FrcRowDecodeState, FrcRowMediaMode } from "@/lib/frcMediaMode";

/**
 * Pane-level media map: which rows (by post uuid) may decode and in what mode.
 *
 * `managed: false` (default, no `FrcMediaModeScope` mounted above) means no
 * one is managing decoding here at all — fail-open, rows decode as
 * `"visible"`, so code outside any managed pane (profile, communities before
 * this change) never silently stops decoding. `managed: true` with
 * `enabled: false` is the deliberate "this pane is off" case (inactive pager
 * page); `managed: true` with `enabled: true` gates each row by `modes`.
 */
type PaneMediaContextValue = {
  managed: boolean;
  enabled: boolean;
  modes: Map<string, FrcRowMediaMode>;
};

const PaneMediaContext = createContext<PaneMediaContextValue>({
  managed: false,
  enabled: false,
  modes: new Map(),
});

/** Resolved decode state for the row currently rendering. */
const RowMediaModeContext = createContext<FrcRowDecodeState>("visible");

export function FrcMediaModeScope({
  enabled,
  modes,
  children,
}: {
  enabled: boolean;
  modes: Map<string, FrcRowMediaMode>;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ managed: true, enabled, modes }),
    [enabled, modes],
  );
  return <PaneMediaContext.Provider value={value}>{children}</PaneMediaContext.Provider>;
}

export function FrcRowMediaScope({
  postUuid,
  children,
}: {
  postUuid: string;
  children: ReactNode;
}) {
  const { managed, enabled, modes } = useContext(PaneMediaContext);
  const state: FrcRowDecodeState = !managed
    ? "visible"
    : !enabled
      ? "gated-out"
      : modes.get(postUuid) ?? "out-of-band";
  return <RowMediaModeContext.Provider value={state}>{children}</RowMediaModeContext.Provider>;
}

/**
 * The current row's decode state; fails open to `"visible"` for code that
 * renders outside any `FrcRowMediaScope` (e.g. avatars), and only reaches
 * `"gated-out"`/`"out-of-band"` inside a managed pane.
 */
export function useFrcRowMediaMode(): FrcRowDecodeState {
  return useContext(RowMediaModeContext);
}
