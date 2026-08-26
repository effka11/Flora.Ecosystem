import { Stack, useNavigation, usePathname, useSegments } from "expo-router";
import { useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { applyMessagesTabBarHidden, isMessagesInThread, isMessagesInThreadPath } from "@/lib/messagesTabBar";
import { floraColors, floraNativeStackOptions } from "@/lib/theme";

export default function MessagesLayout() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const segments = useSegments();
  const pathname = usePathname();
  const inThread = isMessagesInThread(segments) || isMessagesInThreadPath(pathname);

  useLayoutEffect(() => {
    applyMessagesTabBarHidden(navigation, tabBarBottomInset, inThread);
  }, [inThread, navigation, tabBarBottomInset]);

  return (
    <View style={styles.shell}>
      <Stack screenOptions={{ ...floraNativeStackOptions, animation: "none" }}>
        {/* freezeOnBlur параллаксу не мешает: на Fabric native-stack не
            замораживает экран прямо под фокусным (!isBelowFocused в
            NativeStackView) — под прозрачным тредом список остаётся живым
            и рендерит параллакс; freeze сработал бы только глубже стека. */}
        <Stack.Screen
          name="index"
          options={{ headerShown: false, animation: "none", freezeOnBlur: true }}
        />
        {/*
          Телеграмный push на языке Flora (см. lib/chatPushTransition.ts):
          нативный переход выключен, хореографию ведёт Reanimated с кривой
          ENERGETIC_OPEN. transparentModal держит список видимым и живым под
          экраном треда — чат заезжает справа непрозрачным слоем, список
          остаётся на месте с параллаксом и затемнением; назад через
          beforeRemove играет то же зеркально. Нативный жест выключен: он не
          умеет играть JS-переход, системный back Android идёт через
          beforeRemove.
        */}
        <Stack.Screen
          name="[conversationUuid]"
          options={{
            headerShown: false,
            presentation: "transparentModal",
            animation: "none",
            contentStyle: { backgroundColor: "transparent" },
            gestureEnabled: false,
          }}
        />
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
});
