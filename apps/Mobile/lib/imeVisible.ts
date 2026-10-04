import { Dimensions, Keyboard } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";

/**
 * Module-level IME flag so feed layout (`feedBody`, `FeedPostImages`) can
 * freeze width without a Keyboard subscription per row.
 *
 * Subscribe at import: a lazy first call would miss an already-open keyboard
 * (`DidShow` already fired). `WillShow` freezes before the resize animation.
 * Stay visible until `DidHide` so hide-animation frames still freeze.
 */
let visible = false;

function markShown() {
  visible = true;
}

function markHidden() {
  visible = false;
}

function seedFromMetrics() {
  const metrics = (Keyboard as { metrics?: () => { height: number } | undefined }).metrics?.();
  if (metrics != null && metrics.height > 0) visible = true;
}

seedFromMetrics();
KeyboardEvents.addListener("keyboardWillShow", markShown);
KeyboardEvents.addListener("keyboardDidShow", markShown);
KeyboardEvents.addListener("keyboardDidHide", markHidden);

export function isImeVisible(): boolean {
  return visible;
}

/** Width that `adjustResize` does not shrink — first-paint / seed, not IME window. */
export function imeStableWindowWidth(): number {
  return Dimensions.get("screen").width;
}
