import {
  FLORA_GRID_FINE_PX,
  FLORA_GRID_PRIMARY_PX,
  type GridTemplate
} from "@flora/client-core/display";
import { sPx as designSPx } from "@flora/design";
import { createKeyedLiveValue } from "@/lib/liveCache";
import { setFloraRuntimeGridKey } from "@/lib/runtimeCacheVersion";

/** Extra-grid px at the given `s`, or the live Mobile `s` when omitted. */
export function sPx(n: number, s: number = getFloraGridRuntime().s): number {
  return designSPx(n, s);
}

export function kegl(n: number): number {
  return Math.max(1, sPx(n, getFloraGridRuntime().s));
}

export function tracking(n: number): number {
  return n * getFloraGridRuntime().s;
}

export type FloraGridRuntime = {
  step: number;
  stepFine: number;
  s: number;
  templateId: string;
};

const fallback: FloraGridRuntime = {
  step: FLORA_GRID_PRIMARY_PX,
  stepFine: FLORA_GRID_FINE_PX,
  s: 1,
  templateId: "mobile-1"
};

let current: FloraGridRuntime = fallback;
setFloraRuntimeGridKey(fallback.step, fallback.stepFine);

export function getFloraGridRuntime(): FloraGridRuntime {
  return current;
}

export function setFloraGridRuntime(next: FloraGridRuntime): void {
  current = next;
  setFloraRuntimeGridKey(next.step, next.stepFine);
}

export function floraGridRuntimeFromTemplate(template: GridTemplate): FloraGridRuntime {
  return {
    step: FLORA_GRID_PRIMARY_PX * template.s,
    stepFine: FLORA_GRID_FINE_PX * template.s,
    s: template.s,
    templateId: template.id
  };
}

export function liveGridRecord<T extends object>(factory: () => T): T {
  return createKeyedLiveValue(factory);
}
