import { useCallback, useRef, useState } from "react";
import { createPullRefreshController } from "@/lib/pullRefreshController";

/**
 * Binds {@link createPullRefreshController} to React state for RefreshControl.
 * Pass a `run` that refetches the active list; it is read from a ref each pull.
 */
export function usePullToRefresh(run: () => Promise<void>): {
  pullRefreshing: boolean;
  onRefresh: () => void;
} {
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const runRef = useRef(run);
  runRef.current = run;

  const controllerRef = useRef<ReturnType<typeof createPullRefreshController> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createPullRefreshController({
      onChange: setPullRefreshing,
    });
  }

  const onRefresh = useCallback(() => {
    void controllerRef.current!.requestRefresh(() => runRef.current());
  }, []);

  return { pullRefreshing, onRefresh };
}
