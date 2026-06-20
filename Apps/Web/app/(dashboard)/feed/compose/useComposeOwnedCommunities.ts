"use client";

import { useCallback, useEffect, useState } from "react";
import { OWNED_COMMUNITIES_CHANGED_EVENT } from "@/app/(dashboard)/communities/ownedCommunitiesEvents";
import { apiListOwnedCommunities, type OwnedCommunityDto } from "@/lib/socialApi";

export function useComposeOwnedCommunities(enabled = true) {
  const [communities, setCommunities] = useState<OwnedCommunityDto[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!enabled) {
      setCommunities([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await apiListOwnedCommunities();
      setCommunities(list);
    } catch {
      setCommunities([]);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!enabled) {
        if (!cancelled) {
          setCommunities([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      try {
        const list = await apiListOwnedCommunities();
        if (!cancelled) setCommunities(list);
      } catch {
        if (!cancelled) setCommunities([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => void reload();
    window.addEventListener(OWNED_COMMUNITIES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OWNED_COMMUNITIES_CHANGED_EVENT, onChanged);
  }, [enabled, reload]);

  return { communities, loading, reload };
}
