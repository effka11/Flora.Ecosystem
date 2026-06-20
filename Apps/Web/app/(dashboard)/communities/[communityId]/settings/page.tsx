"use client";

import { useParams } from "next/navigation";
import { CommunitySettingsView } from "@/app/(dashboard)/communities/settings/CommunitySettingsView";

export default function CommunitySettingsPage() {
  const params = useParams();
  const routeKey = typeof params.communityId === "string" ? params.communityId : "";

  return <CommunitySettingsView routeKey={routeKey} />;
}
