import { postImageUrl } from "@flora/client-core/display";
import { useEffect, useMemo, useRef } from "react";
import { useWindowDimensions } from "react-native";
import { feedRowContentWidth, firstImageDisplayWidth } from "@/lib/feedImageGeometry";
import { prefetchFrcImage } from "@/lib/frcImage";
import {
  backgroundPrefetchUrls,
  computeRowMediaModes,
  FrcPrefetchBand,
  nextScrollDirection,
  type FrcBandRow,
  type FrcRowMediaMode,
  type FrcScrollDirection,
  type FrcVisibleRange,
} from "@/lib/frcMediaMode";
import { getRowsAhead } from "@/lib/mediaBandwidth";

type MediaBandState = { range: FrcVisibleRange; direction: FrcScrollDirection };

/** Everything `FrcMediaModeScope` needs, decided in one place. */
export type FrcMediaBand = {
  enabled: boolean;
  modes: Map<string, FrcRowMediaMode>;
};

/**
 * Media bands for a post list: which rows may decode, in what mode, and which
 * images are warmed before their row exists.
 *
 * Every list that decodes FRC-I needs the same inputs — how many rows the
 * channel can deliver ahead of the gesture, which way that gesture is going,
 * and the index → post mapping — so they live here once instead of in each
 * screen. Direction is derived from consecutive visible bands rather than from
 * scroll handlers: viewability already reports it, and no `runOnJS` hop is
 * added to the gesture.
 *
 * The download band is deeper than the window FlashList mounts, so the rows at
 * its far end have no component to ask for their image. This is where they get
 * warmed instead, at `background` priority and outside React state; `enabled`
 * gates both halves at once, so a pane that is switched off (the inactive
 * pager page) cannot start a single download behind the one the user sees.
 * Each warm-up asks for the width of the cell its row will actually show it
 * in — not the row's full content width — so the file the mounted row wants
 * is already the one sitting in cache (see `firstImageDisplayWidth`).
 */
export function useFrcMediaBand(
  rows: readonly FrcBandRow[],
  visibleRange: FrcVisibleRange,
  options: { enabled?: boolean; online?: boolean } = {},
): FrcMediaBand {
  const enabled = options.enabled ?? true;
  const online = options.online ?? true;
  const { width: windowWidth } = useWindowDimensions();

  const stateRef = useRef<MediaBandState>({
    range: { min: null, max: null },
    direction: "down",
  });

  const prefetchWidthsRef = useRef<Map<string, number>>(new Map());

  const prefetchRef = useRef<FrcPrefetchBand | null>(null);
  if (prefetchRef.current === null) {
    prefetchRef.current = new FrcPrefetchBand((url) =>
      prefetchFrcImage(url, { displayWidth: prefetchWidthsRef.current.get(url) }),
    );
  }

  const band = useMemo(() => {
    const previous = stateRef.current;
    const direction = nextScrollDirection(previous.range, visibleRange, previous.direction);
    stateRef.current = { range: visibleRange, direction };

    const indexModes = computeRowMediaModes({
      count: rows.length,
      minVisible: visibleRange.min,
      maxVisible: visibleRange.max,
      // Offline never warms a channel that is not there; otherwise the depth
      // is whatever the measured throughput covers in the next few seconds.
      rowsAhead: online ? getRowsAhead() : 0,
      direction,
    });

    const modes = new Map<string, FrcRowMediaMode>();
    for (const [index, mode] of indexModes) {
      const row = rows[index];
      if (row) modes.set(row.postUuid, mode);
    }

    return {
      modes,
      prefetchTargets: backgroundPrefetchUrls({
        rows,
        modes: indexModes,
        urlForImage: postImageUrl,
        enabled,
      }),
    };
  }, [enabled, online, rows, visibleRange]);

  // Read at warm-up time rather than captured: rotation must not restart the
  // downloads already in flight, only change the bucket of the next ones.
  // Keyed by url (not a single scalar) because different rows in the same
  // band can have different image counts, and therefore different first-cell
  // widths.
  const contentWidth = feedRowContentWidth(windowWidth);
  prefetchWidthsRef.current = new Map(
    band.prefetchTargets.map((target) => [
      target.url,
      firstImageDisplayWidth(contentWidth, target.imageCount),
    ]),
  );

  // After the commit, never during render: starting a download is a side
  // effect, and a render React throws away must not leave one behind.
  useEffect(() => {
    prefetchRef.current?.sync(band.prefetchTargets.map((target) => target.url));
  }, [band.prefetchTargets]);

  useEffect(() => () => prefetchRef.current?.stop(), []);

  return useMemo(() => ({ enabled, modes: band.modes }), [band.modes, enabled]);
}
