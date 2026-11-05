import { TabBarIconWithBadge } from "@/components/TabBarIconWithBadge";
import { useTabBadges } from "@/lib/useTabBadges";
import type { ReactNode } from "react";

type BadgeKey = "messagesUnread" | "notificationsUnread";

type Props = {
  badgeKey: BadgeKey;
  children: ReactNode;
};

export function SignalsTabBarIcon({ badgeKey, children }: Props) {
  const badges = useTabBadges();
  return <TabBarIconWithBadge badge={badges[badgeKey]}>{children}</TabBarIconWithBadge>;
}
