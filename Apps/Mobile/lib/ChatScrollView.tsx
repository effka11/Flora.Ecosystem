import { forwardRef, useCallback } from "react";
import { Platform, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import type Reanimated from "react-native-reanimated";
import type { AnimatedRef, SharedValue } from "react-native-reanimated";

export type ChatScrollViewRef = React.ElementRef<typeof KeyboardChatScrollView>;

export type ChatScrollViewKcsvProps = {
  /** KGA/KCSV offset (не используется при freeze=true, оставлен для контракта). */
  offset: number;
  extraContentPadding: SharedValue<number>;
  freeze: SharedValue<boolean>;
  /**
   * Лента перевёрнута. Переворот визуальный (`scaleY: -1`), а этот флаг —
   * математика KCSV: зазор дока уходит в `contentInset.top`, а «конец» контента
   * определяется офсетом у нуля, а не суммой высот.
   */
  inverted?: boolean;
};

type Props = ScrollViewProps &
  ChatScrollViewKcsvProps & {
    /**
     * Animated-ref дока (worklet-scrollTo) — регистрируется на том же инстансе.
     * Второй ручки скролла тут намеренно нет: офсет пишет только док.
     */
    animatedRef?: AnimatedRef<Reanimated.ScrollView>;
  };

export const ChatScrollView = forwardRef<ChatScrollViewRef, Props>(function ChatScrollView(
  { animatedRef, offset, extraContentPadding, freeze, inverted, ...scrollProps },
  ref,
) {
  const combinedRef = useCallback(
    (instance: ChatScrollViewRef | null) => {
      if (typeof ref === "function") {
        ref(instance);
      } else if (ref) {
        ref.current = instance;
      }
      if (animatedRef && instance) {
        animatedRef(instance);
      }
    },
    [animatedRef, ref],
  );

  return (
    <KeyboardChatScrollView
      ref={combinedRef}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      applyWorkaroundForContentInsetHitTestBug={Platform.OS === "ios"}
      offset={offset}
      extraContentPadding={extraContentPadding}
      freeze={freeze}
      inverted={inverted}
      keyboardLiftBehavior="whenAtEnd"
      keyboardDismissMode="interactive"
      {...scrollProps}
    />
  );
});
