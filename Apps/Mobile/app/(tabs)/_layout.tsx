import { SignalsTabBarIcon } from "@/components/SignalsTabBarIcon";
import { TabBarIconWithBadge } from "@/components/TabBarIconWithBadge";
import { MusicMiniPlayer } from "@/components/MusicMiniPlayer";
import { messagesTabBarStyleForRoute } from "@/lib/messagesTabBar";
import { floraColors, floraTabBarStyle } from "@/lib/theme";
import { router, Tabs } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, 8);

  return (
    <View style={styles.tabsRoot}>
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: floraColors.surface },
          headerTintColor: floraColors.text,
          tabBarStyle: floraTabBarStyle(tabBarBottomInset),
          tabBarIconStyle: styles.tabBarIcon,
          sceneStyle: { backgroundColor: floraColors.bg },
          tabBarItemStyle: styles.tabBarItem,
          tabBarLabelStyle: styles.tabBarLabel,
          tabBarActiveTintColor: floraColors.accent,
          tabBarInactiveTintColor: floraColors.textMuted,
        }}
      >
        <Tabs.Screen
          name="feed/index"
          options={{
            title: "Лента",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <TabBarIconWithBadge name="newspaper-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="music"
          options={{
            title: "Музыка",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <TabBarIconWithBadge name="musical-notes-outline" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="messages"
          listeners={{
            tabPress: (e) => {
              e.preventDefault();
              router.replace("/(tabs)/messages");
            },
          }}
          options={({ route }) => ({
            title: "Сообщения",
            headerShown: false,
            tabBarStyle: messagesTabBarStyleForRoute(route, tabBarBottomInset),
            tabBarIcon: ({ color, size }) => (
              <SignalsTabBarIcon
                name="chatbubbles-outline"
                badgeKey="messagesUnread"
                color={color}
                size={size}
              />
            ),
          })}
        />
        <Tabs.Screen
          name="notifications/index"
          options={{
            title: "Уведомления",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <SignalsTabBarIcon
                name="notifications-outline"
                badgeKey="notificationsUnread"
                color={color}
                size={size}
              />
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
          name="profile"
          listeners={{
            tabPress: (e) => {
              e.preventDefault();
              router.replace("/(tabs)/profile");
            },
          }}
          options={{
            title: "Профиль",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <TabBarIconWithBadge name="person-outline" color={color} size={size} />
            ),
          }}
        />
      </Tabs>
      <MusicMiniPlayer />
    </View>
  );
}

const styles = StyleSheet.create({
  tabsRoot: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  tabBarItem: {
    paddingVertical: 0,
  },
  tabBarIcon: {
    overflow: "visible",
  },
  tabBarLabel: {
    fontSize: 10,
    marginTop: 2,
  },
});
