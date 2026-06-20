"use client";

import { useParams } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { CommunityProfileView } from "@/app/(dashboard)/communities/CommunityProfileView";
import styles from "@/app/(dashboard)/profile/profile.module.css";

export default function CommunityProfilePage() {
  const { isClient, hasToken } = useProtectedPage();
  const params = useParams();
  const routeKey = typeof params.communityId === "string" ? params.communityId : "";

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return <CommunityProfileView routeKey={routeKey} />;
}
