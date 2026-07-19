import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { GestureType } from "react-native-gesture-handler";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import {
  SCROLL_PHASE_COAST,
  SCROLL_PHASE_DRAG,
  SCROLL_PHASE_IDLE,
} from "@/lib/drawerFlingPolicy";

export { SCROLL_PHASE_COAST, SCROLL_PHASE_DRAG, SCROLL_PHASE_IDLE };

export type DrawerMomentumPane = {
  viewTag: SharedValue<number>;
  phase: SharedValue<number>;
  velocityY: SharedValue<number>;
  lastEventTs: SharedValue<number>;
  lastCoastVelocityY: SharedValue<number>;
  lastCoastEventTs: SharedValue<number>;
};

export type DrawerMomentumController = {
  activePane: SharedValue<number>;
  panes: readonly [DrawerMomentumPane, DrawerMomentumPane];
  edgePanRef: MutableRefObject<GestureType | undefined>;
  /** Нижняя граница top chrome в absoluteY; edge-pan ниже неё. */
  edgeChromeBottomY: SharedValue<number>;
};

const DrawerMomentumContext = createContext<DrawerMomentumController | null>(null);

export function DrawerMomentumProvider({ children }: { children: ReactNode }) {
  const edgePanRef = useRef<GestureType | undefined>(undefined);
  const edgeChromeBottomY = useSharedValue(0);
  const activePane = useSharedValue(0);
  const pane0Tag = useSharedValue(0);
  const pane0Phase = useSharedValue(SCROLL_PHASE_IDLE);
  const pane0Velocity = useSharedValue(0);
  const pane0LastEvent = useSharedValue(0);
  const pane0LastCoastVelocity = useSharedValue(0);
  const pane0LastCoastEvent = useSharedValue(0);
  const pane1Tag = useSharedValue(0);
  const pane1Phase = useSharedValue(SCROLL_PHASE_IDLE);
  const pane1Velocity = useSharedValue(0);
  const pane1LastEvent = useSharedValue(0);
  const pane1LastCoastVelocity = useSharedValue(0);
  const pane1LastCoastEvent = useSharedValue(0);

  const value = useMemo<DrawerMomentumController>(
    () => ({
      activePane,
      edgePanRef,
      edgeChromeBottomY,
      panes: [
        {
          viewTag: pane0Tag,
          phase: pane0Phase,
          velocityY: pane0Velocity,
          lastEventTs: pane0LastEvent,
          lastCoastVelocityY: pane0LastCoastVelocity,
          lastCoastEventTs: pane0LastCoastEvent,
        },
        {
          viewTag: pane1Tag,
          phase: pane1Phase,
          velocityY: pane1Velocity,
          lastEventTs: pane1LastEvent,
          lastCoastVelocityY: pane1LastCoastVelocity,
          lastCoastEventTs: pane1LastCoastEvent,
        },
      ],
    }),
    [
      activePane,
      edgeChromeBottomY,
      pane0LastEvent,
      pane0LastCoastEvent,
      pane0LastCoastVelocity,
      pane0Phase,
      pane0Tag,
      pane0Velocity,
      pane1LastEvent,
      pane1LastCoastEvent,
      pane1LastCoastVelocity,
      pane1Phase,
      pane1Tag,
      pane1Velocity,
    ],
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
