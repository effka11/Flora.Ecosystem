import { describe, expect, it } from "vitest";
import { floraGridRuntimeFromTemplate, getFloraGridRuntime, setFloraGridRuntime } from "@/lib/floraGridRuntime";
import { pickGridTemplate } from "@flora/client-core/display";
import { floraSpacing } from "@/lib/theme";

describe("mobile live grid step", () => {
  it("is 15 / triple 45 at min-side 390 and 18 / 54 at min-side 800", () => {
    const phone = pickGridTemplate({ family: "mobile", width: 390, height: 844 });
    setFloraGridRuntime(floraGridRuntimeFromTemplate(phone));
    expect(getFloraGridRuntime().step).toBe(15);
    expect(getFloraGridRuntime().stepFine).toBe(5);
    expect(floraSpacing.grid).toBe(15);
    expect(3 * floraSpacing.grid).toBe(45);

    const tablet = pickGridTemplate({ family: "mobile", width: 800, height: 1280 });
    setFloraGridRuntime(floraGridRuntimeFromTemplate(tablet));
    expect(getFloraGridRuntime().step).toBe(18);
    expect(getFloraGridRuntime().stepFine).toBe(6);
    expect(floraSpacing.grid).toBe(18);
    expect(3 * floraSpacing.grid).toBe(54);

    setFloraGridRuntime(floraGridRuntimeFromTemplate(phone));
  });
});
