import { Stack, useNavigation, usePathname, useSegments } from "expo-router";
import { useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isTabActive, tabSegmentIndex } from "@/lib/getActiveTabRouteKey";
import {
  floraColors,
  floraNativeStackOptions,
  floraTabBarHiddenStyle,
  floraTabBarStyle,
  sPx,
} from "@/lib/theme";

function isFeedCompose(segments: readonly string[], pathname: string): boolean {
  if (pathname.replace(/\/$/, "") === "/feed/compose") return true;
  if (!isTabActive(segments, "feed")) return false;
  const nested = segments[tabSegmentIndex(segments) + 1];
  return nested === "compose";
}

export default function FeedStackLayout() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, sPx(8));
  const segments = useSegments();
  const pathname = usePathname();
  const inCompose = isFeedCompose(segments, pathname);

  useLayoutEffect(() => {
    navigation.getParent()?.setOptions({
      tabBarStyle: inCompose
        ? floraTabBarHiddenStyle(tabBarBottomInset)
        : floraTabBarStyle(tabBarBottomInset),
    });
  }, [inCompose, navigation, tabBarBottomInset]);

  return (
    <View style={styles.shell}>
      <Stack screenOptions={{ ...floraNativeStackOptions, animation: "none", headerShown: false }}>
        {/*
          Тот же push, что у чата (lib/chatPushTransition.ts, compose*):
          нативный переход выключен, список остаётся живым под transparentModal,
          создание поста заезжает справа. Жест стека выключен: его не умеет
          JS-переход, системный back идёт через beforeRemove.
        */}
        <Stack.Screen
          name="index"
          options={{ animation: "none", freezeOnBlur: true }}
        />
        <Stack.Screen
          name="compose"
          options={{
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
