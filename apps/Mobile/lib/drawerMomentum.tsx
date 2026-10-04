import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useFocusEffect } from "expo-router/react-navigation";
import type { GestureType } from "react-native-gesture-handler";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import {
  SCROLL_PHASE_COAST,
  SCROLL_PHASE_DRAG,
  SCROLL_PHASE_IDLE,
} from "@/lib/drawerFlingPolicy";

export { SCROLL_PHASE_COAST, SCROLL_PHASE_DRAG, SCROLL_PHASE_IDLE };

/** Слоты гамбургера: вкладки People / папки Messages — activePane 0..4. */
export const DRAWER_PAGER_PANE_COUNT = 5;

export type DrawerMomentumPane = {
  viewTag: SharedValue<number>;
  phase: SharedValue<number>;
  velocityY: SharedValue<number>;
  lastEventTs: SharedValue<number>;
  lastCoastVelocityY: SharedValue<number>;
  lastCoastEventTs: SharedValue<number>;
};

export type DrawerMomentumPanes = readonly [
  DrawerMomentumPane,
  DrawerMomentumPane,
  DrawerMomentumPane,
  DrawerMomentumPane,
  DrawerMomentumPane,
];

export type DrawerMomentumController = {
  activePane: SharedValue<number>;
  panes: DrawerMomentumPanes;
  edgePanRef: MutableRefObject<GestureType | undefined>;
  /** Нижняя граница top chrome в absoluteY; edge-pan ниже неё. */
  edgeChromeBottomY: SharedValue<number>;
};

const DrawerMomentumContext = createContext<DrawerMomentumController | null>(null);

function useDrawerMomentumPane(): DrawerMomentumPane {
  const viewTag = useSharedValue(0);
  const phase = useSharedValue(SCROLL_PHASE_IDLE);
  const velocityY = useSharedValue(0);
  const lastEventTs = useSharedValue(0);
  const lastCoastVelocityY = useSharedValue(0);
  const lastCoastEventTs = useSharedValue(0);
  return useMemo(
    () => ({
      viewTag,
      phase,
      velocityY,
      lastEventTs,
      lastCoastVelocityY,
      lastCoastEventTs,
    }),
    [lastCoastEventTs, lastCoastVelocityY, lastEventTs, phase, velocityY, viewTag],
  );
}

export function drawerPaneAt(
  panes: readonly DrawerMomentumPane[],
  activePane: number,
): DrawerMomentumPane {
  "worklet";
  const last = panes.length - 1;
  const rounded = Math.round(activePane);
  const index = rounded < 0 ? 0 : rounded > last ? last : rounded;
  const pane = panes[index];
  return pane ?? panes[0]!;
}

export function DrawerMomentumProvider({ children }: { children: ReactNode }) {
  const edgePanRef = useRef<GestureType | undefined>(undefined);
  const edgeChromeBottomY = useSharedValue(0);
  const activePane = useSharedValue(0);
  const pane0 = useDrawerMomentumPane();
  const pane1 = useDrawerMomentumPane();
  const pane2 = useDrawerMomentumPane();
  const pane3 = useDrawerMomentumPane();
  const pane4 = useDrawerMomentumPane();

  const value = useMemo<DrawerMomentumController>(
    () => ({
      activePane,
      edgePanRef,
      edgeChromeBottomY,
      panes: [pane0, pane1, pane2, pane3, pane4],
    }),
    [activePane, edgeChromeBottomY, pane0, pane1, pane2, pane3, pane4],
  );

  return <DrawerMomentumContext.Provider value={value}>{children}</DrawerMomentumContext.Provider>;
}

export function useDrawerMomentumController(): DrawerMomentumController {
  const controller = useContext(DrawerMomentumContext);
  if (!controller) {
    throw new Error("useDrawerMomentumController must be used within DrawerMomentumProvider");
  }
  return controller;
}

/** 1 пока вкладка в фокусе — только она держит drawer viewTag / edge-fling. */
export function useDrawerScreenActiveSv(): SharedValue<number> {
  const screenActiveSv = useSharedValue(0);
  useFocusEffect(
    useCallback(() => {
      screenActiveSv.value = 1;
      return () => {
        screenActiveSv.value = 0;
      };
    }, [screenActiveSv]),
  );
  return screenActiveSv;
}
