import { describe, expect, it } from "vitest";

import {
  bubbleAnchorFromPress,
  estimateMenuPanelHeight,
  MENU_ROW_HEIGHT_PX,
  lockMenuFit,
  menuDismissStrips,
  menuFeedVerticalBounds,
  menuPanelShiftYIntoBand,
  menuPanelWindowRect,
  menuPinToParentStyle,
  readMenuPressCoords,
  resolveDockedMenuFit,
  resolveMenuPlacement,
  resolveVisibleMenuPosition,
  shiftMenuAnchor,
  shouldCloseMessageMenuOnListMotion,
  resolveAboveDockTop,
  resolveMenuPanelMotion,
  visualMenuOriginY,
  windowRectFromNativeMeasure,
  type BubbleAnchorRect,
  type VisibleMenuPosition,
} from "./messageBubbleMoreMenuLayout";

const menuGap = 5;
const feedTopY = 100;
const feedBottomY = 520;
const parentWindowX = 0;
const parentWindowY = 0;
const parentLayoutHeight = 800;

function bubbleAt(top: number, bottom: number): BubbleAnchorRect {
  return {
    top,
    left: 80,
    right: 340,
    bottom,
    originY: top,
    visualTop: top,
    visualBottom: bottom,
    yogaHeight: bottom - top,
  };
}

function panelBand(panelHeight: number) {
  return menuFeedVerticalBounds(feedTopY, feedBottomY, panelHeight, menuGap);
}

function placed(
  anchor: BubbleAnchorRect,
  panelHeight: number,
  isFromMe = false,
): VisibleMenuPosition {
  const result = resolveVisibleMenuPosition({
    anchor,
    feedTopY,
    feedBottomY,
    panelHeight,
    menuGap,
    isFromMe,
    canDelete: isFromMe,
    parentWindowX,
    parentWindowY,
    parentLayoutHeight,
  });
  if (result == null) throw new Error("expected a menu position");
  return result;
}

function menuTopWindowY(result: VisibleMenuPosition, panelHeight: number): number {
  if (result.pin.placement === "above") {
    return result.pin.menuBottomY - panelHeight;
  }
  return result.pin.menuTopY;
}

describe("resolveMenuPanelMotion", () => {
  it("below + fromMe → top right, emerge toward the bubble", () => {
    expect(resolveMenuPanelMotion("below", true)).toEqual({
      transformOrigin: "top right",
      emergeX: 2.5,
      emergeY: -8,
    });
  });

  it("below + peer → top left, emerge toward the bubble", () => {
    expect(resolveMenuPanelMotion("below", false)).toEqual({
      transformOrigin: "top left",
      emergeX: -2.5,
      emergeY: -8,
    });
  });

  it("above + fromMe → bottom right, emerge toward the bubble", () => {
    expect(resolveMenuPanelMotion("above", true)).toEqual({
      transformOrigin: "bottom right",
      emergeX: 2.5,
      emergeY: 8,
    });
  });

  it("above + peer → bottom left, emerge toward the bubble", () => {
    expect(resolveMenuPanelMotion("above", false)).toEqual({
      transformOrigin: "bottom left",
      emergeX: -2.5,
      emergeY: 8,
    });
  });
});

describe("shouldCloseMessageMenuOnListMotion", () => {
  it("does not close on programmatic offset changes (keyboard, dock, KCSV)", () => {
    expect(shouldCloseMessageMenuOnListMotion("offset-change")).toBe(false);
  });

  it("closes when the user starts dragging the thread", () => {
    expect(shouldCloseMessageMenuOnListMotion("user-drag")).toBe(true);
  });
});

describe("windowRectFromNativeMeasure", () => {
  it("keeps a normal top-left box", () => {
    expect(windowRectFromNativeMeasure(10, 20, 30, 40)).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 60,
    });
  });

  it("flips a negative height from scaleY -1 into a visual top-left box", () => {
    expect(windowRectFromNativeMeasure(10, 60, 30, -40)).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 60,
    });
  });
});

describe("readMenuPressCoords", () => {
  it("reads RNGH Pressable nativeEvent.pageY (mapped from absoluteY)", () => {
    expect(readMenuPressCoords({ nativeEvent: { pageY: 180, locationY: 12 } })).toEqual({
      windowY: 180,
      locationY: 12,
    });
  });

  it("reads a top-level absoluteY gesture payload", () => {
    expect(readMenuPressCoords({ absoluteY: 210, locationY: 8 })).toEqual({
      windowY: 210,
      locationY: 8,
    });
  });

  it("returns null when the event has no window Y", () => {
    expect(readMenuPressCoords({ nativeEvent: { locationY: 10 } })).toBeNull();
    expect(readMenuPressCoords(undefined)).toBeNull();
  });
});

describe("visualMenuOriginY", () => {
  it("reconstructs the bubble midpoint from window press and local Y", () => {
    expect(
      visualMenuOriginY({
        pressWindowY: 160,
        locationY: 10,
        bubbleHeight: 40,
        fallbackY: 999,
      }),
    ).toBe(170);
  });

  it("falls back to the finger when local Y is missing", () => {
    expect(
      visualMenuOriginY({
        pressWindowY: 160,
        locationY: null,
        bubbleHeight: 40,
        fallbackY: 999,
      }),
    ).toBe(160);
  });

  it("uses fallbackY when the press has no window coordinate", () => {
    expect(
      visualMenuOriginY({
        pressWindowY: null,
        locationY: 10,
        bubbleHeight: 40,
        fallbackY: 250,
      }),
    ).toBe(250);
  });
});

describe("bubbleAnchorFromPress", () => {
  it("does not use inverted measure top when a press window Y exists", () => {
    const anchor = bubbleAnchorFromPress(
      { nativeEvent: { pageY: 150, locationY: 10 } },
      40,
    );
    expect(anchor.originY).toBe(160);
    expect(anchor.visualTop).toBe(140);
    expect(anchor.visualBottom).toBe(180);
    expect(anchor.yogaHeight).toBe(40);
  });

  it("uses captured window Y when the press event has no coordinates", () => {
    const anchor = bubbleAnchorFromPress(undefined, 40, {
      windowY: 180,
      locationY: null,
    });
    expect(anchor.originY).toBe(180);
    expect(anchor.visualTop).toBeNull();
    expect(anchor.visualBottom).toBeNull();
    expect(anchor.yogaHeight).toBe(40);
  });
});

describe("resolveMenuPlacement", () => {
  it("opens below when the visual Y is above the feed midpoint", () => {
    expect(
      resolveMenuPlacement({
        visualY: 150,
        feedTopY,
        feedBottomY,
      }),
    ).toBe("below");
  });

  it("opens above when the visual Y is at or below the feed midpoint", () => {
    expect(
      resolveMenuPlacement({
        visualY: 430,
        feedTopY,
        feedBottomY,
      }),
    ).toBe("above");
    expect(
      resolveMenuPlacement({
        visualY: 310,
        feedTopY,
        feedBottomY,
      }),
    ).toBe("above");
  });
});

describe("menuPinToParentStyle", () => {
  it("pins the menu bottom edge via style.bottom without using panel height", () => {
    expect(
      menuPinToParentStyle({ placement: "above", menuBottomY: 285 }, 0, 800),
    ).toEqual({ bottom: 800 - 285 });
  });

  it("pins the menu top edge via style.top", () => {
    expect(
      menuPinToParentStyle({ placement: "below", menuTopY: 165 }, 0, 800),
    ).toEqual({ top: 165 });
  });
});

describe("resolveVisibleMenuPosition", () => {
  it("returns null until the positioning parent has a layout height", () => {
    expect(
      resolveVisibleMenuPosition({
        anchor: bubbleAt(290, 330),
        feedTopY,
        feedBottomY,
        panelHeight: 180,
        menuGap,
        isFromMe: false,
        canDelete: false,
        parentWindowX: 0,
        parentWindowY: 0,
        parentLayoutHeight: 0,
      }),
    ).toBeNull();
  });

  it("pins above to the bubble top edge minus 5px, not via panel height", () => {
    const result = resolveVisibleMenuPosition({
      anchor: bubbleAt(470, 510),
      feedTopY: null,
      feedBottomY: null,
      panelHeight: 0,
      menuGap,
      isFromMe: true,
      canDelete: true,
      parentWindowX,
      parentWindowY,
      parentLayoutHeight,
    });

    expect(result).not.toBeNull();
    expect(result?.placement).toBe("above");
    expect(result?.pin).toEqual({ placement: "above", menuBottomY: 470 - menuGap });
    expect(result?.style.bottom).toBe(parentLayoutHeight - (470 - menuGap));
    expect(result?.style.top).toBeUndefined();
    expect(result?.style.left).toBe(80);
    expect(result?.style.width).toBe(260);
  });

  it("opens below when the bubble is above the feed midpoint, even if above would fit", () => {
    const panelHeight = estimateMenuPanelHeight(false, false);
    const anchor = bubbleAt(150, 190);
    const result = placed(anchor, panelHeight);

    expect((anchor.top + anchor.bottom) / 2).toBeLessThan((feedTopY + feedBottomY) / 2);
    expect(result.placement).toBe("below");
    expect(result.pin).toEqual({ placement: "below", menuTopY: anchor.bottom + menuGap });
  });

  it("prefers above when the bubble is at or below the feed midpoint and both sides fit", () => {
    const panelHeight = estimateMenuPanelHeight(false, false);
    const anchor = bubbleAt(290, 330);
    const result = placed(anchor, panelHeight);

    expect(result.placement).toBe("above");
    expect(result.pin).toEqual({ placement: "above", menuBottomY: anchor.top - menuGap });
    expect(result.style.bottom).toBe(parentLayoutHeight - (anchor.top - menuGap));
    expect(result.style.top).toBeUndefined();
    expect(result.style.paddingTop).toBeUndefined();
    expect(result.style.paddingBottom).toBeUndefined();
  });

  it("places below a header-near bubble: 5px from bubble bottom to menu top", () => {
    const panelHeight = estimateMenuPanelHeight(false, false);
    const anchor = bubbleAt(110, 160);
    const result = placed(anchor, panelHeight);

    expect(result.placement).toBe("below");
    expect(result.pin).toEqual({ placement: "below", menuTopY: anchor.bottom + menuGap });
    expect(result.style.top).toBe(anchor.bottom + menuGap);
    expect(result.style.bottom).toBeUndefined();
  });

  it("uses bubble height on below: same top and different bottoms yield different menu tops", () => {
    const panelHeight = estimateMenuPanelHeight(false, false);
    const short = placed(bubbleAt(110, 160), panelHeight);
    const tall = placed(bubbleAt(110, 220), panelHeight);

    expect(short.placement).toBe("below");
    expect(tall.placement).toBe("below");
    expect(short.style.top).toBe(160 + menuGap);
    expect(tall.style.top).toBe(220 + menuGap);
    expect(tall.style.top).not.toBe(short.style.top);
  });

  it("keeps the above edge pin when panel height estimate is replaced by the real height", () => {
    const anchor = bubbleAt(360, 430);
    const estimated = placed(anchor, 100);
    const measured = placed(anchor, 220);

    expect(estimated.placement).toBe("above");
    expect(measured.placement).toBe("above");
    expect(estimated.style.bottom).toBe(measured.style.bottom);
    expect(estimated.pin).toEqual({ placement: "above", menuBottomY: anchor.top - menuGap });
    expect(measured.pin).toEqual({ placement: "above", menuBottomY: anchor.top - menuGap });
  });

  it("puts the menu above a bubble near compose so the panel stays in the feed", () => {
    const panelHeight = estimateMenuPanelHeight(true, true);
    const anchor = bubbleAt(470, 510);
    const result = placed(anchor, panelHeight, true);
    const top = menuTopWindowY(result, panelHeight);
    const { minTop, maxTop } = panelBand(panelHeight);

    expect(result.placement).toBe("above");
    expect(top).toBeGreaterThanOrEqual(minTop);
    expect(top).toBeLessThanOrEqual(maxTop);
    expect(result.pin.placement === "above" && result.pin.menuBottomY).toBe(anchor.top - menuGap);
  });

  it("never places the panel over the header or compose, for any bubble in the feed", () => {
    const panelHeight = estimateMenuPanelHeight(true, true);
    const { minTop, maxTop } = panelBand(panelHeight);
    const bubbleHeight = 40;

    for (let top = feedTopY; top <= feedBottomY - bubbleHeight; top += 20) {
      const anchor = bubbleAt(top, top + bubbleHeight);
      const result = placed(anchor, panelHeight, true);
      const panelTopY = menuTopWindowY(result, panelHeight);
      expect(panelTopY).toBeGreaterThanOrEqual(minTop);
      expect(panelTopY).toBeLessThanOrEqual(maxTop);
      expect(panelTopY + panelHeight).toBeLessThanOrEqual(feedBottomY - menuGap + 0.5);
      expect(panelTopY).toBeGreaterThanOrEqual(feedTopY + menuGap - 0.5);
    }
  });

  it("clamps into the feed with only top when neither side fits", () => {
    const result = placed(bubbleAt(280, 340), 400);

    expect(result.placement).toBe("clamped");
    expect(typeof result.style.top).toBe("number");
    expect(result.style.bottom).toBeUndefined();
    expect(result.style.paddingTop).toBeUndefined();
    expect(result.style.paddingBottom).toBeUndefined();
  });

  it("returns null until the bubble rect exists", () => {
    expect(
      resolveVisibleMenuPosition({
        anchor: null,
        feedTopY,
        feedBottomY,
        panelHeight: 180,
        menuGap,
        isFromMe: false,
        canDelete: false,
        parentWindowX,
        parentWindowY,
        parentLayoutHeight,
      }),
    ).toBeNull();
  });
});

describe("shiftMenuAnchor", () => {
  it("follows the bubble box and keeps the visual originY from the press", () => {
    const prev: BubbleAnchorRect = {
      top: 400,
      left: 80,
      right: 340,
      bottom: 450,
      originY: 160,
      visualTop: 140,
      visualBottom: 180,
      yogaHeight: 40,
    };
    const next = shiftMenuAnchor(prev, {
      top: 380,
      left: 80,
      right: 340,
      bottom: 430,
    });
    expect(next.originY).toBe(160);
    expect(next.visualTop).toBe(140);
    expect(next.visualBottom).toBe(180);
    expect(next.top).toBe(380);
    expect(next.bottom).toBe(430);
  });
});

describe("menuPanelWindowRect", () => {
  it("pins below the visual bubble bottom with the gap", () => {
    expect(
      menuPanelWindowRect({
        placement: "below",
        originY: 200,
        bubbleLeft: 80,
        bubbleRight: 200,
        bubbleHeight: 40,
        panelWidth: 200,
        panelHeight: 100,
        menuGap: 5,
        isFromMe: false,
      }),
    ).toEqual({
      top: 225,
      left: 80,
      right: 280,
      bottom: 325,
    });
  });

  it("pins above the visual bubble top and aligns to the trailing edge", () => {
    expect(
      menuPanelWindowRect({
        placement: "above",
        originY: 400,
        bubbleLeft: 100,
        bubbleRight: 340,
        bubbleHeight: 40,
        panelWidth: 200,
        panelHeight: 100,
        menuGap: 5,
        isFromMe: true,
      }),
    ).toEqual({
      top: 275,
      left: 140,
      right: 340,
      bottom: 375,
    });
  });
});

describe("menuDismissStrips", () => {
  const host = { x: 0, y: 0, width: 400, height: 800 };

  it("leaves a hole over the panel and covers the rest", () => {
    const strips = menuDismissStrips(
      { left: 100, top: 200, right: 300, bottom: 400 },
      host,
    );
    expect(strips).toEqual([
      { key: "n", style: { position: "absolute", left: 0, right: 0, top: 0, height: 200 } },
      { key: "s", style: { position: "absolute", left: 0, right: 0, top: 400, bottom: 0 } },
      { key: "w", style: { position: "absolute", left: 0, width: 100, top: 200, height: 200 } },
      { key: "e", style: { position: "absolute", left: 300, right: 0, top: 200, height: 200 } },
    ]);
  });

  it("omits empty strips when the panel sits in a corner", () => {
    const strips = menuDismissStrips({ left: 0, top: 0, right: 50, bottom: 40 }, host);
    expect(strips.map((s) => s.key)).toEqual(["s", "e"]);
  });

  it("returns no strips when the panel covers the host", () => {
    expect(
      menuDismissStrips({ left: 0, top: 0, right: 400, bottom: 800 }, host),
    ).toEqual([]);
  });
});

describe("resolveDockedMenuFit", () => {
  const feedInset = 20;
  const base = {
    bubbleLeft: 80,
    bubbleRight: 200,
    panelWidth: 200,
    menuGap: 5,
    feedTopY: 100,
    feedBottomY: 520,
    feedInset,
    isFromMe: false,
  } as const;

  it("keeps the 5px dock when the preferred side already sits in the feed band", () => {
    const fit = resolveDockedMenuFit({
      ...base,
      originY: 200,
      bubbleHeight: 40,
      panelHeight: 100,
    });
    expect(fit.placement).toBe("below");
    expect(fit.shiftY).toBe(0);
    expect(fit.rect.top).toBe(225);
    expect(fit.rect.bottom).toBe(325);
    expect(fit.rect.top).toBeGreaterThanOrEqual(100 + feedInset);
    expect(fit.rect.bottom).toBeLessThanOrEqual(520 - feedInset);
  });

  it("opens above in the lower half with the 5px bubble gap", () => {
    const fit = resolveDockedMenuFit({
      ...base,
      originY: 400,
      bubbleHeight: 40,
      panelHeight: 100,
    });
    expect(fit.placement).toBe("above");
    expect(fit.shiftY).toBe(0);
    expect(fit.rect.top).toBe(275);
    expect(fit.rect.bottom).toBe(375);
    expect(fit.rect.top).toBeGreaterThanOrEqual(100 + feedInset);
    expect(fit.rect.bottom).toBeLessThanOrEqual(520 - feedInset);
  });

  it("shifts a long-message panel into the feed, 20px from the dividers", () => {
    const fit = resolveDockedMenuFit({
      ...base,
      originY: 310,
      bubbleHeight: 320,
      panelHeight: 200,
    });
    expect(fit.shiftY).not.toBe(0);
    expect(fit.rect.top).toBeGreaterThanOrEqual(100 + feedInset);
    expect(fit.rect.bottom).toBeLessThanOrEqual(520 - feedInset);
    expect(fit.rect.top).toBe(100 + feedInset);
    expect(fit.rect.bottom - fit.rect.top).toBe(200);
  });

  it("nudges the panel up to keep 20px from compose when below almost fits", () => {
    const fit = resolveDockedMenuFit({
      ...base,
      originY: 250,
      bubbleHeight: 40,
      panelHeight: 240,
    });
    expect(fit.placement).toBe("below");
    expect(fit.shiftY).toBe(-15);
    expect(fit.rect.bottom).toBe(520 - feedInset);
    expect(fit.rect.top).toBe(260);
  });

  it("pins a too-tall panel to the top inset rather than leaving the feed", () => {
    const shift = menuPanelShiftYIntoBand(
      { left: 0, top: 0, right: 10, bottom: 500 },
      115,
      505,
    );
    expect(shift).toBe(115);
  });
});

describe("lockMenuFit", () => {
  const windowHeight = 800;
  const base = {
    feedTopY: 100,
    feedBottomY: 520,
    windowHeight,
    menuGap: 5,
    feedInset: 20,
  } as const;

  it("opens below a short bubble in the upper half with shiftY 0", () => {
    const fit = lockMenuFit({
      ...base,
      visualTop: 150,
      visualBottom: 190,
      panelHeight: 100,
      allowBottomClamp: true,
    });
    expect(fit.placement).toBe("below");
    expect(fit.shiftY).toBe(0);
  });

  it("opens above a short bubble in the lower half with shiftY 0", () => {
    const fit = lockMenuFit({
      ...base,
      visualTop: 400,
      visualBottom: 440,
      panelHeight: 100,
      allowBottomClamp: true,
    });
    expect(fit.placement).toBe("above");
    expect(fit.shiftY).toBe(0);
  });

  it("does not window-shift an overflowing above dock (CSS pin stays)", () => {
    const fit = lockMenuFit({
      ...base,
      visualTop: 200,
      visualBottom: 500,
      panelHeight: 200,
      allowBottomClamp: true,
    });
    expect(fit.placement).toBe("above");
    expect(fit.shiftY).toBe(0);
  });

  it("clamps an overflowing below dock to feedBottom-20 when allowBottomClamp", () => {
    const fit = lockMenuFit({
      ...base,
      visualTop: 200,
      visualBottom: 240,
      panelHeight: 280,
      allowBottomClamp: true,
    });
    expect(fit.placement).toBe("below");
    const predictedBottom = 240 + 5 + 280;
    expect(fit.shiftY).toBe(520 - 20 - predictedBottom);
    expect(predictedBottom + fit.shiftY).toBe(500);
  });

  it("does not clamp the bottom when allowBottomClamp is false", () => {
    const fit = lockMenuFit({
      ...base,
      visualTop: 200,
      visualBottom: 240,
      panelHeight: 280,
      allowBottomClamp: false,
    });
    expect(fit.placement).toBe("below");
    expect(fit.shiftY).toBe(0);
  });

  it("does not clamp when feed bounds are missing", () => {
    const fit = lockMenuFit({
      visualTop: 150,
      visualBottom: 190,
      feedTopY: null,
      feedBottomY: null,
      windowHeight,
      panelHeight: 100,
      menuGap: 5,
      feedInset: 20,
      allowBottomClamp: true,
    });
    expect(fit.placement).toBe("below");
    expect(fit.shiftY).toBe(0);
  });

  it("does not flip side when the preferred dock overflows", () => {
    const fit = lockMenuFit({
      ...base,
      visualTop: 200,
      visualBottom: 240,
      panelHeight: 280,
      allowBottomClamp: true,
    });
    expect(fit.placement).toBe("below");
    expect(fit.shiftY).not.toBe(0);
  });
});

describe("resolveAboveDockTop", () => {
  const feedTopY = 100;
  const menuGap = 5;
  const feedInset = 20;

  it("keeps a medium above bubble on the CSS dock when the panel fits", () => {
    const dock = resolveAboveDockTop({
      visualTop: 400,
      feedTopY,
      panelHeight: 100,
      menuGap,
      feedInset,
    });
    expect(dock.clipLocal).toBe(0);
    expect(dock.clearanceLocal).toBe(0);
    expect(dock.aboveAnchorTop).toBe(0);
  });

  it("clips to the header line and clears exactly to feedTop+inset", () => {
    const panelHeight = 171;
    const dock = resolveAboveDockTop({
      visualTop: 50,
      feedTopY,
      panelHeight,
      menuGap,
      feedInset,
    });
    expect(dock.clipLocal).toBe(50);
    const visibleTop = 100;
    expect(visibleTop - menuGap - panelHeight + dock.clearanceLocal).toBe(feedTopY + feedInset);
    expect(dock.aboveAnchorTop).toBe(dock.clipLocal + dock.clearanceLocal);
  });

  it("does not clip a short above bubble wholly below the header", () => {
    const dock = resolveAboveDockTop({
      visualTop: 400,
      feedTopY,
      panelHeight: 40,
      menuGap,
      feedInset,
    });
    expect(dock.clipLocal).toBe(0);
    expect(dock.aboveAnchorTop).toBe(0);
  });

  it("returns zeros when visualTop is missing", () => {
    expect(
      resolveAboveDockTop({
        visualTop: null,
        feedTopY,
        panelHeight: 171,
        menuGap,
        feedInset,
      }),
    ).toEqual({ clipLocal: 0, clearanceLocal: 0, aboveAnchorTop: 0 });
  });

  it("returns zeros when feedTopY is missing", () => {
    expect(
      resolveAboveDockTop({
        visualTop: 50,
        feedTopY: null,
        panelHeight: 171,
        menuGap,
        feedInset,
      }),
    ).toEqual({ clipLocal: 0, clearanceLocal: 0, aboveAnchorTop: 0 });
  });

  it("grows only clearanceLocal when the panel is taller", () => {
    const short = resolveAboveDockTop({
      visualTop: 50,
      feedTopY,
      panelHeight: 100,
      menuGap,
      feedInset,
    });
    const tall = resolveAboveDockTop({
      visualTop: 50,
      feedTopY,
      panelHeight: 200,
      menuGap,
      feedInset,
    });
    expect(tall.clipLocal).toBe(short.clipLocal);
    expect(tall.clearanceLocal).toBeGreaterThan(short.clearanceLocal);
  });
});

describe("estimateMenuPanelHeight", () => {
  it("adds a report row for peer DMs", () => {
    expect(estimateMenuPanelHeight(false, false, true)).toBe(
      estimateMenuPanelHeight(false, false, false) + MENU_ROW_HEIGHT_PX,
    );
  });
});
