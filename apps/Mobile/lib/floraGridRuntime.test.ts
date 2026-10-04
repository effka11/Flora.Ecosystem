import { describe, expect, it } from "vitest";
import { pickGridTemplate } from "@flora/client-core/display";
import {
  floraGridRuntimeFromTemplate,
  getFloraGridRuntime,
  kegl,
  sPx,
  setFloraGridRuntime,
  tracking,
} from "@/lib/floraGridRuntime";
import {
  messageBubbleBodyTextMetrics,
  messageBubbleTimeTextMetrics,
} from "@/lib/messageBubbleTextStyle";
import { floraFeedPost, floraProfile, floraSpacing } from "@/lib/theme";

function setFromViewport(width: number, height: number) {
  const template = pickGridTemplate({ family: "mobile", width, height });
  setFloraGridRuntime(floraGridRuntimeFromTemplate(template));
  return template;
}

describe("mobile live grid step", () => {
  it("is 15 / triple 45 at min-side 390 and 18 / 54 at min-side 800", () => {
    const phone = setFromViewport(390, 844);
    expect(phone.id).toBe("mobile-1");
    expect(getFloraGridRuntime().step).toBe(15);
    expect(getFloraGridRuntime().stepFine).toBe(5);
    expect(floraSpacing.grid).toBe(15);
    expect(3 * floraSpacing.grid).toBe(45);

    const tablet = setFromViewport(800, 1280);
    expect(tablet.id).toBe("mobile-1-2");
    expect(getFloraGridRuntime().step).toBe(18);
    expect(getFloraGridRuntime().stepFine).toBe(6);
    expect(floraSpacing.grid).toBe(18);
    expect(3 * floraSpacing.grid).toBe(54);

    setFromViewport(390, 844);
  });

  it("scales kegl / sPx / tracking at tablet s=1.2 and keeps phone fixtures", () => {
    setFromViewport(800, 1280);
    const s = getFloraGridRuntime().s;
    expect(s).toBe(1.2);
    expect(kegl(15)).toBe(18);
    expect(sPx(22, s)).toBe(26);
    expect(tracking(0.45)).toBe(0.54);

    setFromViewport(390, 844);
    expect(kegl(15)).toBe(15);
    expect(3 * floraSpacing.grid).toBe(45);
    expect(1.7 * kegl(15)).toBe(25.5);
    expect(2.1 * kegl(15)).toBe(31.5);
  });

  it("keeps profile avatar as 6×grid + 2×sPx(4), not sPx(98), at s=1.4", () => {
    const template = setFromViewport(1024, 1366);
    expect(template.id).toBe("mobile-1-4");
    const s = getFloraGridRuntime().s;
    expect(s).toBe(1.4);
    expect(floraProfile.avatarSize).toBe(6 * floraSpacing.grid + 2 * sPx(4, s));
    expect(floraProfile.avatarSize).not.toBe(sPx(98, s));
    expect(floraProfile.avatarSize).toBe(138);
    expect(sPx(98, s)).toBe(137);
  });

  it("derives nickname shiftY and text cap-trim from live line boxes at s=1.4", () => {
    setFromViewport(1024, 1366);
    expect(floraFeedPost.nicknamePaintShiftY).toBe(
      -((floraFeedPost.nicknamePaintLineHeight - kegl(15)) / 2),
    );
    expect(floraFeedPost.textCapTrim).toBe(-((floraFeedPost.textLineHeight - kegl(15)) / 2));
    expect(floraFeedPost.nicknamePaintShiftY).not.toBe(sPx(-2.5));
  });

  it("rebuilds bubble body and time metrics after s=1.2", () => {
    setFromViewport(800, 1280);
    const s = getFloraGridRuntime().s;
    expect(messageBubbleBodyTextMetrics.letterSpacing).toBe(tracking(0.45));
    expect(messageBubbleBodyTextMetrics.fontSize).toBe(kegl(15));
    expect(messageBubbleTimeTextMetrics.fontSize).toBe(kegl(12));
    expect(messageBubbleTimeTextMetrics.lineHeight).toBe(sPx(18, s));
  });

  it("keeps bubble metrics readable after a dev-style freeze attempt", () => {
    setFromViewport(390, 844);
    expect(() => Object.freeze(messageBubbleBodyTextMetrics)).toThrow(TypeError);
    expect({ ...messageBubbleBodyTextMetrics }.fontSize).toBe(kegl(15));
    expect(Object.keys(messageBubbleTimeTextMetrics)).toContain("lineHeight");
  });
});
