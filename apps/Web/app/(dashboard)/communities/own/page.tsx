"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { communityHref } from "@/app/(dashboard)/communities/communitiesSeed";
import { communityListItemToRecord } from "@/app/(dashboard)/communities/communityProfile";
import { CommunityNotFound } from "@/app/(dashboard)/communities/CommunityPageContent";
import { apiListOwnedCommunities } from "@/lib/socialApi";
import styles from "@/app/(dashboard)/profile/profile.module.css";

function CommunityOwnPageContent() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await apiListOwnedCommunities();
        if (cancelled) return;
        const first = list[0];
        if (first) {
          router.replace(communityHref(communityListItemToRecord(first, "owned")));
          return;
        }
      } catch {
        /* not found */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (loading) return <section className={styles.page} />;
  return <CommunityNotFound />;
}

export default function CommunityOwnPage() {
  const { isClient, hasToken } = useProtectedPage();
  if (!isClient || !hasToken) return <div className={styles.page} />;
  return <CommunityOwnPageContent />;
}
