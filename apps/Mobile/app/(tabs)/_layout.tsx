import { renderChatPushTabBar } from "@/components/ChatPushTabBar";
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
import { useFloraTheme } from "@/lib/FloraThemeProvider";
import { isTabActive, isTabRoot } from "@/lib/getActiveTabRouteKey";
import { isMessagesInThreadPath, messagesTabBarStyleForRoute } from "@/lib/messagesTabBar";
import { useIdleCommunitiesTabPreload } from "@/lib/communitiesTabPreload";
import { useIdleContributeTabPreload } from "@/lib/contributeTabPreload";
import { useIdleMessagesTabPreload } from "@/lib/messagesTabPreload";
import { useIdleMusicTabPreload } from "@/lib/musicTabPreload";
import { useIdleNotificationsTabPreload } from "@/lib/notificationsTabPreload";
import { useIdlePeopleTabPreload } from "@/lib/peopleTabPreload";
import { useIdleProfileTabPreload } from "@/lib/profileTabPreload";
import { useIdleSettingsTabPreload } from "@/lib/settingsTabPreload";
import { useFloraReduceMotion } from "@/lib/useFloraReduceMotion";
import { floraColors, floraTabBarStyle } from "@/lib/theme";
import { router, Tabs, usePathname, useSegments } from "expo-router";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Фон под навигатором. Живёт отдельно от `TabsLayout`: смена темы не должна
 * перерисовывать `<Tabs>` со всеми дескрипторами экранов.
 */
function TabsThemedBackdrop() {
  useFloraTheme();
  return (
    <View
      pointerEvents="none"
      style={[styles.backdrop, { backgroundColor: floraColors.bg }]}
    />
  );
}

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
  useIdlePeopleTabPreload(segments);
  useIdleCommunitiesTabPreload(segments);
  useIdleSettingsTabPreload(segments);
  useIdleContributeTabPreload(segments);
  const { screenListeners, overlay } = useTabRouteTransition(reduceMotion, tabBarBottomInset);

  const screenOptions = useMemo(
    () => ({
      animation: "none" as const,
      freezeOnBlur: true,
      tabBarStyle: floraTabBarStyle(tabBarBottomInset),
      tabBarBackground: () => <FloraTabBarBackground />,
      tabBarShowLabel: false,
      tabBarIconStyle: styles.tabBarIcon,
      /** Прозрачная сцена: фон даёт `TabsThemedBackdrop`, экраны красят свои корни. */
      sceneStyle: { backgroundColor: "transparent" as const },
      tabBarItemStyle: styles.tabBarItem,
    }),
    [tabBarBottomInset],
  );

  return (
    <HamburgerMenuProvider>
      <FeedLightboxProvider>
        <View style={styles.tabsRoot}>
        <TabsThemedBackdrop />
        <Tabs
          detachInactiveScreens={false}
          screenListeners={screenListeners}
          screenOptions={screenOptions}
          tabBar={renderChatPushTabBar}
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
              tabBarIcon: ({ size, focused }) => (
                <TabBarIconWithBadge>
                  <TabBarFeedIcon focused={focused} size={size} />
                </TabBarIconWithBadge>
              ),
            }}
          />
          <Tabs.Screen
            name="music"
            options={{
              title: "Музыка",
              headerShown: false,
              tabBarIcon: ({ size, focused }) => (
                <TabBarIconWithBadge>
                  <TabBarMusicIcon focused={focused} size={size} />
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
              tabBarIcon: ({ size, focused }) => (
                <SignalsTabBarIcon badgeKey="messagesUnread">
                  <TabBarMessagesIcon focused={focused} size={size} />
                </SignalsTabBarIcon>
              ),
            })}
          />
          <Tabs.Screen
            name="notifications/index"
            options={{
              title: "Уведомления",
              headerShown: false,
              tabBarIcon: ({ size, focused }) => (
                <SignalsTabBarIcon badgeKey="notificationsUnread">
                  <TabBarNotificationsIcon focused={focused} size={size} />
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
            name="contribute"
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
              tabBarIcon: ({ size, focused }) => (
                <TabBarIconWithBadge>
                  <TabBarProfileIcon focused={focused} size={size} />
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
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  tabBarItem: {
    paddingVertical: 0,
    justifyContent: "center",
  },
  tabBarIcon: {
    overflow: "visible",
  },
});
