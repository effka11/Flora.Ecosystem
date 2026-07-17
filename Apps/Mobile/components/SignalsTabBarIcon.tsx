import { TabBarIconWithBadge } from "@/components/TabBarIconWithBadge";
import { useTabBadges } from "@/lib/useTabBadges";
import type { ReactNode } from "react";
import type { ColorValue } from "react-native";

type BadgeKey = "messagesUnread" | "notificationsUnread";

type Props = {
  badgeKey: BadgeKey;
  color: ColorValue;
  size: number;
  children: ReactNode;
};

export function SignalsTabBarIcon({ badgeKey, color, size, children }: Props) {
  const badges = useTabBadges();
  return (
    <TabBarIconWithBadge color={color} size={size} badge={badges[badgeKey]}>
      {children}
    </TabBarIconWithBadge>
  );
}
