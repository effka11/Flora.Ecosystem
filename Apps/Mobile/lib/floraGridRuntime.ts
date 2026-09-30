import {
  FLORA_GRID_FINE_PX,
  FLORA_GRID_PRIMARY_PX,
  type GridTemplate
} from "@flora/client-core/display";
import { sPx as designSPx } from "@flora/design";

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

export function getFloraGridRuntime(): FloraGridRuntime {
  return current;
}

export function setFloraGridRuntime(next: FloraGridRuntime): void {
  current = next;
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
  let cachedKey = "";
  let cached: T | undefined;

  const resolve = (): T => {
    const key = `${getFloraGridRuntime().step}:${getFloraGridRuntime().stepFine}`;
    if (cached && key === cachedKey) {
      return cached;
    }
    cachedKey = key;
    cached = factory();
    return cached;
  };

  return new Proxy({} as T, {
    get(_target, prop) {
      return (resolve() as Record<PropertyKey, unknown>)[prop];
    },
    ownKeys() {
      return Reflect.ownKeys(resolve() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(resolve() as object, prop);
    },
    has(_target, prop) {
      return prop in (resolve() as object);
    },
    // StyleSheet.create freezes style objects in dev. Accepting that on an
    // empty target makes the next ownKeys throw for the rest of the session.
    preventExtensions() {
      return false;
    }
  });
}
