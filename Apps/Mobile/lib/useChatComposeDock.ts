import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  Platform,
  StatusBar,
  type EmitterSubscription,
  type KeyboardEvent,
} from "react-native";

function androidStatusBarHeight(): number {
  return StatusBar.currentHeight ?? 0;
}

/** Высота клавиатуры от низа окна (верх IME до layout-bottom). */
function keyboardInsetPx(event: KeyboardEvent): number {
  const { screenY } = event.endCoordinates;
  if (screenY <= 0) return 0;

  if (Platform.OS === "ios") {
    return event.endCoordinates.height;
  }

  const statusBar = androidStatusBarHeight();
  const windowHeight = Dimensions.get("window").height;
  const candidates = [windowHeight - screenY, windowHeight + statusBar - screenY].filter(
    (v) => v > 0,
  );
  if (candidates.length === 0) return 0;

  return Math.min(...candidates);
}

/** Запасная высота панели, пока реальная высота клавиатуры ещё не измерена. */
function fallbackPanelHeight(): number {
  const windowHeight = Dimensions.get("window").height;
  return Math.round(Math.min(Math.max(windowHeight * 0.4, 260), 340));
}

/** Последняя измеренная высота IME в сессии — точнее fallback при первом открытии эмодзi. */
let sessionKeyboardHeightPx = 0;

/** Длительность выезда панели — близко к системной клавиатуре. */
const PANEL_ANIM_MS = Platform.OS === "ios" ? 250 : 200;

export type ChatComposeDock = {
  lift: Animated.Value;
  panelSlide: Animated.Value;
  emojiPanelMounted: boolean;
  emojiContentReady: boolean;
  bottomInset: number;
  panelHeight: number;
  emojiOpen: boolean;
  keyboardOpen: boolean;
  openEmoji: () => void;
  closeEmoji: () => void;
  showKeyboard: (focusInput: () => void) => void;
};

/**
 * Док поля ввода: поле сразу в целевой позиции (lift в useLayoutEffect, до paint);
 * панель выезжает отдельно; эмодзi → клавиатура через panelHideForKeyboardRef.
 */
export function useChatComposeDock(liftAdjustPx = 0): ChatComposeDock {
  const lift = useRef(new Animated.Value(0)).current;
  const panelSlide = useRef(new Animated.Value(0)).current;
  const [bottomInset, setBottomInset] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiPanelMounted, setEmojiPanelMounted] = useState(false);
  const [emojiContentReady, setEmojiContentReady] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [panelOpenToken, setPanelOpenToken] = useState(0);

  const liftAdjustRef = useRef(liftAdjustPx);
  liftAdjustRef.current = liftAdjustPx;
  const frameAnimCancelRef = useRef<(() => void) | null>(null);
  const emojiOpenRef = useRef(false);
  const keyboardOpenRef = useRef(false);
  const lastKbHeightRef = useRef(0);
  const panelHeightRef = useRef(0);
  const panelSlidePxRef = useRef(0);
  const panelClosingRef = useRef(false);
  const panelHideForKeyboardRef = useRef(false);
  const panelOpenAnimStartedRef = useRef(0);
  const keyboardSwitchRef = useRef(false);

  const stopPanelAnim = useCallback(() => {
    frameAnimCancelRef.current?.();
    frameAnimCancelRef.current = null;
  }, []);

  const targetLift = useCallback(
    (px: number) => (px > 0 ? Math.max(0, px + liftAdjustRef.current) : 0),
    [],
  );

  const setLiftImmediate = useCallback(
    (px: number) => {
      lift.setValue(-targetLift(px));
    },
    [lift, targetLift],
  );

  const resolvePanelHeight = useCallback(() => {
    const fromSession = lastKbHeightRef.current || sessionKeyboardHeightPx;
    return fromSession > 0 ? fromSession : fallbackPanelHeight();
  }, []);

  const syncKeyboardInset = useCallback(
    (px: number) => {
      if (px <= 0) return;
      lastKbHeightRef.current = px;
      sessionKeyboardHeightPx = px;
      keyboardOpenRef.current = true;
      setKeyboardOpen(true);
      setBottomInset(px);
      setLiftImmediate(px);
      if (panelHideForKeyboardRef.current) {
        panelHideForKeyboardRef.current = false;
        keyboardSwitchRef.current = false;
      }
    },
    [setLiftImmediate],
  );

  const applyVisiblePanelHeight = useCallback(
    (visiblePx: number) => {
      const px = Math.max(0, visiblePx);
      setBottomInset(px);
      setLiftImmediate(px);
    },
    [setLiftImmediate],
  );

  const runPanelFrameAnim = useCallback(
    (
      from: number,
      to: number,
      opts: { syncLift: boolean; onEnd?: () => void },
    ) => {
      stopPanelAnim();
      let cancelled = false;
      const startTime = Date.now();
      const height = panelHeightRef.current;

      frameAnimCancelRef.current = () => {
        cancelled = true;
      };

      const tick = () => {
        if (cancelled) return;
        const t = Math.min(1, (Date.now() - startTime) / PANEL_ANIM_MS);
        const eased = Easing.out(Easing.cubic)(t);
        const slideY = from + (to - from) * eased;
        panelSlidePxRef.current = slideY;
        panelSlide.setValue(slideY);

        if (opts.syncLift && height > 0) {
          applyVisiblePanelHeight(height - slideY);
        }

        if (t < 1) {
          requestAnimationFrame(tick);
          return;
        }

        frameAnimCancelRef.current = null;
        opts.onEnd?.();
      };

      requestAnimationFrame(tick);
    },
    [applyVisiblePanelHeight, panelSlide, stopPanelAnim],
  );

  const clearEmojiPanelState = useCallback(() => {
    emojiOpenRef.current = false;
    setEmojiOpen(false);
    setEmojiPanelMounted(false);
    setEmojiContentReady(false);
    panelHeightRef.current = 0;
    setPanelHeight(0);
    panelClosingRef.current = false;
  }, []);

  const slidePanelUp = useCallback(
    (height: number, onEnd?: () => void) => {
      panelSlidePxRef.current = height;
      panelSlide.setValue(height);
      runPanelFrameAnim(height, 0, { syncLift: false, onEnd });
    },
    [panelSlide, runPanelFrameAnim],
  );

  const slidePanelDown = useCallback(
    (syncLift: boolean, onEnd?: () => void) => {
      if (panelClosingRef.current) return false;
      panelClosingRef.current = true;
      const height = panelHeightRef.current || resolvePanelHeight();
      runPanelFrameAnim(panelSlidePxRef.current, height, {
        syncLift,
        onEnd: () => {
          panelClosingRef.current = false;
          onEnd?.();
        },
      });
      return true;
    },
    [resolvePanelHeight, runPanelFrameAnim],
  );

  const beginEmojiToKeyboard = useCallback(
    (focusInput: () => void) => {
      if (!emojiOpenRef.current && !emojiPanelMounted) {
        focusInput();
        return;
      }
      if (keyboardSwitchRef.current) return;

      keyboardSwitchRef.current = true;
      panelHideForKeyboardRef.current = true;
      setEmojiOpen(false);
      setEmojiContentReady(false);

      const started = slidePanelDown(false, () => {
        clearEmojiPanelState();
        keyboardSwitchRef.current = false;
      });
      if (!started) {
        keyboardSwitchRef.current = false;
        panelHideForKeyboardRef.current = false;
      }

      // Один focus после commit emojiOpen=false → showSoftInputOnFocus=true.
      requestAnimationFrame(() => {
        requestAnimationFrame(focusInput);
      });
    },
    [clearEmojiPanelState, emojiPanelMounted, slidePanelDown],
  );

  useEffect(() => {
    const onShow = (event: KeyboardEvent) => {
      const px = keyboardInsetPx(event);
      if (px <= 0) return;
      syncKeyboardInset(px);
      if (emojiOpenRef.current && !panelHideForKeyboardRef.current) {
        panelHideForKeyboardRef.current = true;
        setEmojiOpen(false);
        setEmojiContentReady(false);
        slidePanelDown(false, clearEmojiPanelState);
      }
    };

    const onDidShow = (event: KeyboardEvent) => {
      const px = keyboardInsetPx(event);
      if (px > 0) syncKeyboardInset(px);
      keyboardOpenRef.current = true;
      setKeyboardOpen(true);
    };

    const onHide = () => {
      keyboardOpenRef.current = false;
      setKeyboardOpen(false);
      if (emojiOpenRef.current || panelClosingRef.current || panelHideForKeyboardRef.current) return;
      setBottomInset(0);
      setLiftImmediate(0);
    };

    const onFrame = (event: KeyboardEvent) => {
      const px = keyboardInsetPx(event);

      if (panelHideForKeyboardRef.current) {
        if (px > 0) syncKeyboardInset(px);
        return;
      }

      if (emojiOpenRef.current) {
        if (px > 0) syncKeyboardInset(px);
        return;
      }

      if (panelClosingRef.current) return;

      if (px > 0) syncKeyboardInset(px);
      else setLiftImmediate(px);
    };

    const subs: EmitterSubscription[] = [];
    if (Platform.OS === "ios") {
      subs.push(Keyboard.addListener("keyboardWillShow", onShow));
      subs.push(Keyboard.addListener("keyboardDidShow", onDidShow));
      subs.push(Keyboard.addListener("keyboardWillHide", onHide));
    } else {
      subs.push(Keyboard.addListener("keyboardDidChangeFrame", onFrame));
      subs.push(Keyboard.addListener("keyboardDidShow", onDidShow));
      subs.push(Keyboard.addListener("keyboardDidHide", onHide));
    }

    return () => {
      stopPanelAnim();
      subs.forEach((sub) => sub.remove());
    };
  }, [clearEmojiPanelState, setLiftImmediate, slidePanelDown, stopPanelAnim, syncKeyboardInset]);

  const openEmoji = useCallback(() => {
    const height = resolvePanelHeight();
    panelHeightRef.current = height;
    setPanelHeight(height);
    emojiOpenRef.current = true;
    setEmojiOpen(true);
    setEmojiContentReady(false);
    setEmojiPanelMounted(true);
    panelHideForKeyboardRef.current = false;
    panelClosingRef.current = false;
    setPanelOpenToken((token) => token + 1);

    if (keyboardOpenRef.current) {
      Keyboard.dismiss();
    }
    // lift/bottomInset — в useLayoutEffect до paint, чтобы поле не «проваливалось» на кадр.
  }, [resolvePanelHeight]);

  useLayoutEffect(() => {
    if (panelOpenToken === 0 || !emojiPanelMounted) return;
    if (panelOpenAnimStartedRef.current === panelOpenToken) return;
    panelOpenAnimStartedRef.current = panelOpenToken;

    const height = panelHeightRef.current;
    if (height <= 0) return;

    if (!keyboardOpenRef.current) {
      setBottomInset(height);
      setLiftImmediate(height);
    }

    slidePanelUp(height, () => {
      setEmojiContentReady(true);
    });
  }, [panelOpenToken, emojiPanelMounted, setLiftImmediate, slidePanelUp]);

  const closeEmoji = useCallback(() => {
    if (!emojiOpenRef.current || panelClosingRef.current) return;
    setEmojiContentReady(false);
    slidePanelDown(true, () => {
      clearEmojiPanelState();
      if (!keyboardOpenRef.current) {
        setBottomInset(0);
        setLiftImmediate(0);
      }
    });
  }, [clearEmojiPanelState, setLiftImmediate, slidePanelDown]);

  const showKeyboard = useCallback(
    (focusInput: () => void) => {
      beginEmojiToKeyboard(focusInput);
    },
    [beginEmojiToKeyboard],
  );

  return {
    lift,
    panelSlide,
    emojiPanelMounted,
    emojiContentReady,
    bottomInset,
    panelHeight,
    emojiOpen,
    keyboardOpen,
    openEmoji,
    closeEmoji,
    showKeyboard,
  };
};
