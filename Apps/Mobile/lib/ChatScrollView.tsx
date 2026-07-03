import { forwardRef, useCallback, type RefObject } from "react";
import { Platform, type LayoutChangeEvent, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import type Reanimated from "react-native-reanimated";
import type { AnimatedRef, SharedValue } from "react-native-reanimated";

export type ChatScrollViewRef = React.ElementRef<typeof KeyboardChatScrollView>;

export type ChatScrollViewKcsvProps = {
  /** KGA/KCSV offset (не используется при freeze=true, оставлен для контракта). */
  offset: number;
  extraContentPadding: SharedValue<number>;
  freeze: SharedValue<boolean>;
};

type Props = ScrollViewProps &
  ChatScrollViewKcsvProps & {
    chatScrollViewRef?: RefObject<ChatScrollViewRef | null>;
    /** Animated-ref дока (worklet-scrollTo) — регистрируется на том же инстансе. */
    animatedRef?: AnimatedRef<Reanimated.ScrollView>;
    onListLayoutHeight?: (height: number) => void;
    onListContentHeight?: (height: number) => void;
  };

export const ChatScrollView = forwardRef<ChatScrollViewRef, Props>(function ChatScrollView(
  {
    chatScrollViewRef,
    animatedRef,
    onListLayoutHeight,
    onListContentHeight,
    offset,
    extraContentPadding,
    freeze,
    onLayout,
    onContentSizeChange,
    ...scrollProps
  },
  ref,
) {
  const combinedRef = useCallback(
    (instance: ChatScrollViewRef | null) => {
      if (typeof ref === "function") {
        ref(instance);
      } else if (ref) {
        ref.current = instance;
      }
      if (chatScrollViewRef) {
        chatScrollViewRef.current = instance;
      }
      if (animatedRef && instance) {
        animatedRef(instance);
      }
    },
    [animatedRef, chatScrollViewRef, ref],
  );

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onListLayoutHeight?.(e.nativeEvent.layout.height);
      onLayout?.(e);
    },
    [onLayout, onListLayoutHeight],
  );

  const handleContentSizeChange = useCallback(
    (w: number, h: number) => {
      onListContentHeight?.(h);
      onContentSizeChange?.(w, h);
    },
    [onContentSizeChange, onListContentHeight],
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
      keyboardLiftBehavior="whenAtEnd"
      keyboardDismissMode="interactive"
      onLayout={handleLayout}
      onContentSizeChange={handleContentSizeChange}
      {...scrollProps}
    />
  );
});
