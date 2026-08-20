import { FloraTabBarBackground } from "@/components/FloraTabBarBackground";
import { FeedLightboxProvider } from "@/components/feed/FeedLightboxHost";
import { HamburgerMenuProvider } from "@/components/HamburgerMenuProvider";
import { SignalsTabBarIcon } from "@/components/SignalsTabBarIcon";
import { TabBarIconWithBadge } from "@/components/TabBarIconWithBadge";
import {
  TabBarFeedIcon,
  TabBarMessagesIcon,
  TabBarMusicIcon,
  TabBarNotificationsIcon,
  TabBarProfileIcon,
} from "@/components/tabbar/TabBarNavIcons";
import { MusicMiniPlayer } from "@/components/MusicMiniPlayer";
import { useTabRouteTransition } from "@/components/TabRouteTransition";
import { isTabActive, isTabRoot } from "@/lib/getActiveTabRouteKey";
import { isMessagesInThreadPath, messagesTabBarStyleForRoute } from "@/lib/messagesTabBar";
import { useIdleMessagesTabPreload } from "@/lib/messagesTabPreload";
import { useIdleMusicTabPreload } from "@/lib/musicTabPreload";
import { useIdleNotificationsTabPreload } from "@/lib/notificationsTabPreload";
import { useIdleProfileTabPreload } from "@/lib/profileTabPreload";
import { useFloraReduceMotion } from "@/lib/useFloraReduceMotion";
import { floraColors, floraTabBarStyle } from "@/lib/theme";
import { router, Tabs, usePathname, useSegments } from "expo-router";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const reduceMotion = useFloraReduceMotion();
  const pathname = usePathname();
  const segments = useSegments();
  useIdleMessagesTabPreload(segments);
  useIdleNotificationsTabPreload(segments);
  useIdleProfileTabPreload(segments);
  useIdleMusicTabPreload(segments);
  const { screenListeners, overlay } = useTabRouteTransition(reduceMotion, tabBarBottomInset);

  const screenOptions = useMemo(
    () => ({
      animation: "none" as const,
      freezeOnBlur: true,
      headerStyle: { backgroundColor: floraColors.surface },
      headerTintColor: floraColors.text,
      tabBarStyle: floraTabBarStyle(tabBarBottomInset),
      tabBarBackground: () => <FloraTabBarBackground />,
      tabBarShowLabel: false,
      tabBarIconStyle: styles.tabBarIcon,
      sceneStyle: { backgroundColor: floraColors.bg },
      tabBarItemStyle: styles.tabBarItem,
      tabBarActiveTintColor: floraColors.accent,
      tabBarInactiveTintColor: "rgba(250, 250, 250, 0.55)",
    }),
    [tabBarBottomInset],
  );

  return (
    <HamburgerMenuProvider>
      <FeedLightboxProvider>
        <View style={styles.tabsRoot}>
        <Tabs
          detachInactiveScreens={false}
          screenListeners={screenListeners}
          screenOptions={screenOptions}
        >
          <Tabs.Screen
            name="feed"
            listeners={{
              tabPress: (e) => {
                if (!isTabActive(segments, "feed")) {
                  return;
                }
                e.preventDefault();
                if (isTabRoot(segments, "feed")) {
                  return;
                }
                router.replace("/(tabs)/feed");
              },
            }}
            options={{
              title: "Лента",
              headerShown: false,
              tabBarIcon: ({ color, size }) => (
                <TabBarIconWithBadge color={color} size={size}>
                  <TabBarFeedIcon color={color} size={size} />
                </TabBarIconWithBadge>
              ),
            }}
          />
          <Tabs.Screen
            name="music"
            options={{
              title: "Музыка",
              headerShown: false,
              tabBarIcon: ({ color, size }) => (
                <TabBarIconWithBadge color={color} size={size}>
                  <TabBarMusicIcon color={color} size={size} />
                </TabBarIconWithBadge>
              ),
            }}
          />
          <Tabs.Screen
            name="messages"
            listeners={{
              tabPress: (e) => {
                if (!isTabActive(segments, "messages")) {
                  return;
                }
                e.preventDefault();
                if (isTabRoot(segments, "messages") && !isMessagesInThreadPath(pathname)) {
                  return;
                }
                router.replace("/(tabs)/messages");
              },
            }}
            options={({ route }) => ({
              title: "Сообщения",
              headerShown: false,
              tabBarStyle: messagesTabBarStyleForRoute(route, tabBarBottomInset),
              tabBarIcon: ({ color, size }) => (
                <SignalsTabBarIcon badgeKey="messagesUnread" color={color} size={size}>
                  <TabBarMessagesIcon color={color} size={size} />
                </SignalsTabBarIcon>
              ),
            })}
          />
          <Tabs.Screen
            name="notifications/index"
            options={{
              title: "Уведомления",
              headerShown: false,
              tabBarIcon: ({ color, size }) => (
                <SignalsTabBarIcon badgeKey="notificationsUnread" color={color} size={size}>
                  <TabBarNotificationsIcon color={color} size={size} />
                </SignalsTabBarIcon>
              ),
            }}
          />
          <Tabs.Screen
            name="people"
            options={{
              href: null,
              headerShown: false,
            }}
          />
          <Tabs.Screen
            name="communities"
            options={{
              href: null,
              headerShown: false,
            }}
          />
          <Tabs.Screen
            name="github"
            options={{
              href: null,
              headerShown: false,
            }}
          />
          <Tabs.Screen
            name="settings"
            options={{
              href: null,
              headerShown: false,
            }}
          />
          <Tabs.Screen
            name="profile"
            listeners={{
              tabPress: (e) => {
                if (!isTabActive(segments, "profile")) {
                  return;
                }
                e.preventDefault();
                if (isTabRoot(segments, "profile")) {
                  return;
                }
                router.replace("/(tabs)/profile");
              },
            }}
            options={{
              title: "Профиль",
              headerShown: false,
              tabBarIcon: ({ color, size }) => (
                <TabBarIconWithBadge color={color} size={size}>
                  <TabBarProfileIcon color={color} size={size} />
                </TabBarIconWithBadge>
              ),
            }}
          />
        </Tabs>
        <MusicMiniPlayer />
        {overlay}
        </View>
      </FeedLightboxProvider>
    </HamburgerMenuProvider>
  );
}

const styles = StyleSheet.create({
  tabsRoot: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  tabBarItem: {
    paddingVertical: 0,
    justifyContent: "center",
  },
  tabBarIcon: {
    overflow: "visible",
  },
});
