import { useCallback, useMemo } from "react";
import type { ComponentType } from "react";
import type { ScrollViewProps } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import {
  DRAWER_PAGER_PANE_COUNT,
  useDrawerMomentumController,
  useDrawerScreenActiveSv,
} from "@/lib/drawerMomentum";
import { createPagerFlashListScroll } from "@/lib/pagerFlashListScroll";

/**
 * RNGH FlashList-скролл для N страниц пейджера без collapse шапки.
 * Панели 0–4 — слоты DrawerMomentumProvider (гамбургер-fling на активной).
 */
export function usePagerListScroll(pageCount: number): {
  renderScrollComponents: ComponentType<ScrollViewProps>[];
  setActivePane: (index: number) => void;
  activePaneSv: SharedValue<number>;
} {
  const controller = useDrawerMomentumController();
  const screenActiveSv = useDrawerScreenActiveSv();
  const panes = controller.panes;

  const renderScrollComponents = useMemo(() => {
    const count = Math.max(1, Math.min(pageCount, DRAWER_PAGER_PANE_COUNT));
    return Array.from({ length: count }, (_, index) =>
      createPagerFlashListScroll({
        pane: panes[index] ?? panes[0],
        edgePanRef: controller.edgePanRef,
        activePaneSv: controller.activePane,
        paneIndex: index,
        screenActiveSv,
      }),
    );
  }, [controller.activePane, controller.edgePanRef, pageCount, panes, screenActiveSv]);

  const setActivePane = useCallback(
    (index: number) => {
      controller.activePane.value = index;
    },
    [controller.activePane],
  );

  return {
    renderScrollComponents,
    setActivePane,
    activePaneSv: controller.activePane,
  };
}
