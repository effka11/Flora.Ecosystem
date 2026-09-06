import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import {
  gridCanvasSize,
  pickGridTemplate,
  resetFloraGridDebugState,
  takeFloraGridDebugView
} from "@flora/client-core/display";
import {
  floraGridRuntimeFromTemplate,
  getFloraGridRuntime,
  setFloraGridRuntime,
  type FloraGridRuntime
} from "@/lib/floraGridRuntime";

const FloraGridContext = createContext<FloraGridRuntime>(getFloraGridRuntime());

function logFloraGrid(
  width: number,
  height: number,
  previousId: string | undefined,
  chosen: ReturnType<typeof pickGridTemplate>
) {
  if (!__DEV__) return;
  const view = takeFloraGridDebugView({
    family: "mobile",
    width,
    height,
    previousId,
    chosen,
    canvas: gridCanvasSize(chosen)
  });
  if (!view) return;
  // Metro forwards console.log as LOG. console.warn becomes a yellow LogBox + WARN
  // and drowns in package.json export noise.
  console.log(`[flora-grid] ${view.reasonLabel}  ${view.headline}`);
  for (const line of view.lines) {
    console.log(`[flora-grid]   ${line.label.padEnd(10)} ${line.value}`);
  }
}

export function FloraGridProvider({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const previousIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => resetFloraGridDebugState();
  }, []);

  const runtime = useMemo(() => {
    const template = pickGridTemplate({
      family: "mobile",
      width,
      height,
      previousId: previousIdRef.current
    });
    if (previousIdRef.current === undefined) {
      resetFloraGridDebugState();
    }
    logFloraGrid(width, height, previousIdRef.current, template);
    previousIdRef.current = template.id;
    const next = floraGridRuntimeFromTemplate(template);
    setFloraGridRuntime(next);
    return next;
  }, [width, height]);

  return <FloraGridContext.Provider value={runtime}>{children}</FloraGridContext.Provider>;
}

export function useFloraGrid(): FloraGridRuntime {
  return useContext(FloraGridContext);
}
