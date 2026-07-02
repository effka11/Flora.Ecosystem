import { forwardRef, useCallback, type RefObject } from "react";
import { Platform, type ScrollViewProps } from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import type { SharedValue } from "react-native-reanimated";

export type ChatScrollViewRef = React.ElementRef<typeof KeyboardChatScrollView>;

type KeyboardLiftBehavior = "always" | "whenAtEnd" | "persistent" | "never";

export type ChatScrollViewKcsvProps = {
  offset: number;
  extraContentPadding: SharedValue<number>;
  freeze: SharedValue<boolean>;
  keyboardLiftBehavior?: KeyboardLiftBehavior;
};

type Props = ScrollViewProps &
  ChatScrollViewKcsvProps & {
    chatScrollViewRef?: RefObject<ChatScrollViewRef | null>;
  };

export const ChatScrollView = forwardRef<ChatScrollViewRef, Props>(function ChatScrollView(
  {
    chatScrollViewRef,
    offset,
    extraContentPadding,
    freeze,
    keyboardLiftBehavior = "whenAtEnd",
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
    },
    [chatScrollViewRef, ref],
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
      keyboardLiftBehavior={keyboardLiftBehavior}
      {...scrollProps}
    />
  );
});
