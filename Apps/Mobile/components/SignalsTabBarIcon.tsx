import { TabBarIconWithBadge } from "@/components/TabBarIconWithBadge";
import { useTabBadges } from "@/lib/useTabBadges";
import { Ionicons } from "@expo/vector-icons";
import type { ColorValue } from "react-native";

type BadgeKey = "messagesUnread" | "notificationsUnread";

type Props = {
  name: keyof typeof Ionicons.glyphMap;
  badgeKey: BadgeKey;
  color: ColorValue;
  size: number;
};

export function SignalsTabBarIcon({ name, badgeKey, color, size }: Props) {
  const badges = useTabBadges();
  return (
    <TabBarIconWithBadge
      name={name}
      color={color}
      size={size}
      badge={badges[badgeKey]}
    />
  );
}
