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
      <Stack screenOptions={floraNativeStackOptions}>
        <Stack.Screen name="index" options={{ headerShown: false, animation: "none" }} />
        <Stack.Screen
          name="[conversationUuid]"
          options={{
            headerShown: false,
            animation: "fade",
            animationDuration: 180,
            gestureEnabled: true,
            fullScreenGestureEnabled: true,
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
