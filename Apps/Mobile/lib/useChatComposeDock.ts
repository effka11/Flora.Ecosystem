import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, Dimensions, Easing, Keyboard, Platform, type ViewStyle } from "react-native";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import {
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type AnimatedStyle,
} from "react-native-reanimated";

/** Запасная высота панели, пока реальная высота клавиатуры ещё не измерена. */
function fallbackPanelHeight(): number {
  const windowHeight = Dimensions.get("window").height;
  return Math.round(Math.min(Math.max(windowHeight * 0.4, 260), 340));
}

/** Последняя измеренная высота IME в сессии — точнее fallback при первом открытии эмодзi. */
let sessionKeyboardHeightPx = 0;

/** Длительность выезда панели — близко к системной клавиатуре. */
const PANEL_ANIM_MS = Platform.OS === "ios" ? 250 : 200;

const KB_HEIGHT_SYNC_EPSILON_PX = 2;

export type ChatComposeDock = {
  liftStyle: AnimatedStyle<ViewStyle>;
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
 * Док поля ввода: lift через Reanimated + keyboard-controller;
 * панель эмодзi — panelSlide; эмодзi → клавиатура через panelHideForKeyboardRef.
 */
export function useChatComposeDock(liftAdjustPx = 0): ChatComposeDock {
  const panelSlide = useRef(new Animated.Value(0)).current;
  const [bottomInset, setBottomInset] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiPanelMounted, setEmojiPanelMounted] = useState(false);
  const [emojiContentReady, setEmojiContentReady] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [panelOpenToken, setPanelOpenToken] = useState(0);

  const keyboardInsetPx = useSharedValue(0);
  const emojiPanelInsetPx = useSharedValue(0);
  const liftAdjustPxSv = useSharedValue(liftAdjustPx);
  const emojiOpenSv = useSharedValue(false);
  const panelClosingSv = useSharedValue(false);
  const panelHideForKbSv = useSharedValue(false);
  const lastSyncedKbHeightSv = useSharedValue(0);

  const blockKeyboardInsetSv = useDerivedValue(
    () => emojiOpenSv.value && !panelHideForKbSv.value,
  );

  const effectiveInsetPx = useDerivedValue(() =>
    Math.max(keyboardInsetPx.value, emojiPanelInsetPx.value),
  );

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

  const emojiPanelInsetPxRef = useRef(emojiPanelInsetPx);
  emojiPanelInsetPxRef.current = emojiPanelInsetPx;
  const lastSyncedKbHeightSvRef = useRef(lastSyncedKbHeightSv);
  lastSyncedKbHeightSvRef.current = lastSyncedKbHeightSv;
  const keyboardInsetPxRef = useRef(keyboardInsetPx);
  keyboardInsetPxRef.current = keyboardInsetPx;

  useEffect(() => {
    liftAdjustPxSv.value = liftAdjustPx;
  }, [liftAdjustPx, liftAdjustPxSv]);

  const syncGuardRefsToSv = useCallback(() => {
    emojiOpenSv.value = emojiOpenRef.current;
    panelClosingSv.value = panelClosingRef.current;
    panelHideForKbSv.value = panelHideForKeyboardRef.current;
  }, [emojiOpenSv, panelClosingSv, panelHideForKbSv]);

  const stopPanelAnim = useCallback(() => {
    frameAnimCancelRef.current?.();
    frameAnimCancelRef.current = null;
  }, []);

  const resolvePanelHeight = useCallback(() => {
    const fromSession = lastKbHeightRef.current || sessionKeyboardHeightPx;
    return fromSession > 0 ? fromSession : fallbackPanelHeight();
  }, []);

  const clearEmojiPanelState = useCallback(
    (opts?: { keepEmojiInset?: boolean }) => {
      emojiOpenRef.current = false;
      setEmojiOpen(false);
      setEmojiPanelMounted(false);
      setEmojiContentReady(false);
      panelHeightRef.current = 0;
      setPanelHeight(0);
      panelClosingRef.current = false;

      const keepInset =
        opts?.keepEmojiInset ??
        (panelHideForKeyboardRef.current || keyboardSwitchRef.current);
      if (!keepInset) {
        emojiPanelInsetPxRef.current.value = 0;
      }

      syncGuardRefsToSv();
    },
    [syncGuardRefsToSv],
  );

  const slidePanelDownRef = useRef<
    (syncLift: boolean, onEnd?: () => void) => boolean
  >(() => false);

  const syncKeyboardFromHandler = useCallback(
    (px: number) => {
      if (px <= 0) return;

      const wasOpen = keyboardOpenRef.current;
      const wasPanelHideForKb = panelHideForKeyboardRef.current;

      lastKbHeightRef.current = px;
      sessionKeyboardHeightPx = px;
      keyboardOpenRef.current = true;
      if (!wasOpen) setKeyboardOpen(true);

      if (
        Platform.OS === "ios" &&
        emojiOpenRef.current &&
        !wasPanelHideForKb &&
        !keyboardSwitchRef.current
      ) {
        panelHideForKeyboardRef.current = true;
        syncGuardRefsToSv();
        slidePanelDownRef.current(false, () => {
          emojiPanelInsetPxRef.current.value = 0;
          panelHideForKeyboardRef.current = false;
          syncGuardRefsToSv();
          clearEmojiPanelState();
        });
        if (__DEV__) console.debug("[chat-compose-dock] kb height", px);
        return;
      }

      if (wasPanelHideForKb) {
        panelHideForKeyboardRef.current = false;
        keyboardSwitchRef.current = false;
        emojiPanelInsetPxRef.current.value = 0;
        syncGuardRefsToSv();
      }

      if (__DEV__) console.debug("[chat-compose-dock] kb height", px);
    },
    [clearEmojiPanelState, syncGuardRefsToSv],
  );

  const syncKeyboardClosed = useCallback(() => {
    keyboardOpenRef.current = false;
    setKeyboardOpen(false);
    keyboardInsetPxRef.current.value = 0;
    lastSyncedKbHeightSvRef.current.value = 0;
  }, []);

  const syncKeyboardDismissed = useCallback(() => {
    keyboardOpenRef.current = false;
    setKeyboardOpen(false);
  }, []);

  useKeyboardHandler(
    {
      onMove: (event) => {
        "worklet";
        if (blockKeyboardInsetSv.value) return;
        if (event.height > 0) {
          keyboardInsetPx.value = event.height;
          const delta = Math.abs(event.height - lastSyncedKbHeightSv.value);
          if (delta >= KB_HEIGHT_SYNC_EPSILON_PX) {
            lastSyncedKbHeightSv.value = event.height;
            runOnJS(syncKeyboardFromHandler)(event.height);
          }
        }
      },
      onEnd: (event) => {
        "worklet";
        if (event.height > 0) {
          if (!blockKeyboardInsetSv.value) {
            keyboardInsetPx.value = event.height;
            lastSyncedKbHeightSv.value = event.height;
            runOnJS(syncKeyboardFromHandler)(event.height);
          }
          return;
        }
        if (emojiOpenSv.value || panelClosingSv.value || panelHideForKbSv.value) {
          runOnJS(syncKeyboardDismissed)();
          return;
        }
        keyboardInsetPx.value = 0;
        runOnJS(syncKeyboardClosed)();
      },
    },
    [syncKeyboardClosed, syncKeyboardDismissed, syncKeyboardFromHandler],
  );

  useAnimatedReaction(
    () => effectiveInsetPx.value,
    (value, prev) => {
      if (value !== prev) {
        runOnJS(setBottomInset)(value);
      }
    },
    [],
  );

  const liftStyle = useAnimatedStyle(() => {
    const inset = effectiveInsetPx.value;
    // Порт targetLift(px): composeLiftAdjust только при поднятом dock (KB/emoji), не в idle.
    const lifted = inset > 0 ? inset + liftAdjustPxSv.value : 0;
    return {
      transform: [{ translateY: -lifted }],
    };
  });

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
      const emojiSv = emojiPanelInsetPxRef.current;

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
          emojiSv.value = Math.max(0, height - slideY);
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
    [panelSlide, stopPanelAnim],
  );

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
      syncGuardRefsToSv();
      const height = panelHeightRef.current || resolvePanelHeight();
      runPanelFrameAnim(panelSlidePxRef.current, height, {
        syncLift,
        onEnd: () => {
          panelClosingRef.current = false;
          syncGuardRefsToSv();
          onEnd?.();
        },
      });
      return true;
    },
    [resolvePanelHeight, runPanelFrameAnim, syncGuardRefsToSv],
  );

  slidePanelDownRef.current = slidePanelDown;

  const beginEmojiToKeyboard = useCallback(
    (focusInput: () => void) => {
      if (!emojiOpenRef.current && !emojiPanelMounted) {
        focusInput();
        return;
      }
      if (keyboardSwitchRef.current) return;

      keyboardSwitchRef.current = true;
      panelHideForKeyboardRef.current = true;
      syncGuardRefsToSv();
      setEmojiOpen(false);
      setEmojiContentReady(false);

      const started = slidePanelDown(false, () => {
        clearEmojiPanelState({ keepEmojiInset: true });
        keyboardSwitchRef.current = false;
        syncGuardRefsToSv();
      });
      if (!started) {
        keyboardSwitchRef.current = false;
        panelHideForKeyboardRef.current = false;
        syncGuardRefsToSv();
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(focusInput);
      });
    },
    [clearEmojiPanelState, emojiPanelMounted, slidePanelDown, syncGuardRefsToSv],
  );

  useEffect(() => {
    return () => {
      stopPanelAnim();
      keyboardInsetPx.value = 0;
      emojiPanelInsetPx.value = 0;
      lastSyncedKbHeightSv.value = 0;
      emojiOpenSv.value = false;
      panelClosingSv.value = false;
      panelHideForKbSv.value = false;
    };
  }, [
    emojiOpenSv,
    emojiPanelInsetPx,
    keyboardInsetPx,
    lastSyncedKbHeightSv,
    panelClosingSv,
    panelHideForKbSv,
    stopPanelAnim,
  ]);

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
    syncGuardRefsToSv();

    runOnUI((panelH: number) => {
      "worklet";
      keyboardInsetPx.value = 0;
      emojiPanelInsetPx.value = panelH;
      lastSyncedKbHeightSv.value = 0;
    })(height);

    setPanelOpenToken((token) => token + 1);

    if (keyboardOpenRef.current) {
      Keyboard.dismiss();
    }
  }, [resolvePanelHeight, syncGuardRefsToSv]);

  useLayoutEffect(() => {
    if (panelOpenToken === 0 || !emojiPanelMounted) return;
    if (panelOpenAnimStartedRef.current === panelOpenToken) return;
    panelOpenAnimStartedRef.current = panelOpenToken;

    const height = panelHeightRef.current;
    if (height <= 0) return;

    slidePanelUp(height, () => {
      setEmojiContentReady(true);
    });
  }, [panelOpenToken, emojiPanelMounted, slidePanelUp]);

  const closeEmoji = useCallback(() => {
    if (!emojiOpenRef.current || panelClosingRef.current) return;
    setEmojiContentReady(false);
    slidePanelDown(true, () => {
      clearEmojiPanelState();
    });
  }, [clearEmojiPanelState, slidePanelDown]);

  const showKeyboard = useCallback(
    (focusInput: () => void) => {
      beginEmojiToKeyboard(focusInput);
    },
    [beginEmojiToKeyboard],
  );

  return {
    liftStyle,
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
}
