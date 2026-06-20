"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { communityHref, getCommunityById, isOwnedCommunityId } from "@/app/(dashboard)/communities/communitiesSeed";
import { isDevLocalOfflineSession } from "@/lib/auth";
import { communityProfileToRecord, isCommunityUuid } from "@/app/(dashboard)/communities/communityProfile";
import { CommunityNotFound, CommunityPageContent } from "@/app/(dashboard)/communities/CommunityPageContent";
import { apiGetCommunityBySlug, apiListOwnedCommunities } from "@/lib/socialApi";
import type { CommunityRecord } from "@/app/(dashboard)/communities/communitiesSeed";
import styles from "@/app/(dashboard)/profile/profile.module.css";

async function resolveCommunitySlug(routeKey: string): Promise<string> {
  const trimmed = routeKey.trim();
  if (!isCommunityUuid(trimmed)) return trimmed;

  const owned = await apiListOwnedCommunities();
  const match = owned.find((c) => c.communityId.toLowerCase() === trimmed.toLowerCase());
  if (!match?.slug) throw new Error("Сообщество не найдено.");
  return match.slug;
}

export function CommunityProfileView({ routeKey }: { routeKey: string }) {
  const router = useRouter();
  const [community, setCommunity] = useState<CommunityRecord | null>(null);
  const [isOwn, setIsOwn] = useState(false);
  const [isMember, setIsMember] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOwnedCommunityId(routeKey)) {
      router.replace("/communities/own");
    }
  }, [routeKey, router]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setCommunity(null);
      setIsMember(false);

      try {
        const slug = await resolveCommunitySlug(routeKey);
        if (cancelled) return;

        const profile = await apiGetCommunityBySlug(slug);
        if (cancelled) return;

        if (isCommunityUuid(routeKey)) {
          router.replace(communityHref({ id: profile.communityId, slug: profile.slug }));
        }

        setCommunity(communityProfileToRecord(profile));
        setIsOwn(profile.role === "Owner");
        setIsMember(profile.role === "Member");
      } catch {
        if (!cancelled && isDevLocalOfflineSession()) {
          const seed = getCommunityById(routeKey);
          if (seed) {
            setCommunity(seed);
            setIsOwn(isOwnedCommunityId(seed.id));
            setIsMember(false);
            return;
          }
        }
        if (!cancelled) setCommunity(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeKey, router]);

  if (isOwnedCommunityId(routeKey)) {
    return <section className={styles.page} />;
  }

  if (loading) {
    return <section className={styles.page} />;
  }

  if (!community) {
    return <CommunityNotFound />;
  }

  return (
    <CommunityPageContent
      community={community}
      isOwn={isOwn}
      initialIsFollowing={isMember}
      communityPageHref={communityHref(community)}
    />
  );
}
