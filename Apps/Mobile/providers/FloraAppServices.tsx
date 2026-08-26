import {
  apiGetConversations,
  apiGetProfilePosts,
  apiListGroups,
  apiListNotifications,
} from "@flora/client-core/api";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { MessageTextMeasureWarmHost } from "@/components/messages/MessageTextMeasureWarmHost";
import { useChatListOverlayStore } from "@/lib/chatListOverlayStore";
import { startChatThreadsPrefetch } from "@/lib/chatThreadsPrefetch";
import {
  fetchCommunitiesOwnedQuery,
  fetchCommunitiesRecommendedQuery,
  fetchCommunitiesSubscriptionsQuery,
  communitiesIndexUsername,
  communitiesSubscriptionsQueryKey,
  COMMUNITIES_OWNED_QUERY_KEY,
  COMMUNITIES_RECOMMENDED_QUERY_KEY,
} from "@/lib/communities/communitiesIndexQueries";
import {
  fetchMusicLibraryQuery,
  fetchMusicPlaylistsQuery,
  MUSIC_LIBRARY_QUERY_KEY,
  MUSIC_PLAYLISTS_QUERY_KEY,
} from "@/lib/music/musicIndexQueries";
import {
  fetchPeopleFollowersQuery,
  fetchPeopleFollowingQuery,
  fetchPeopleRecommendedQuery,
  peopleFollowersQueryKey,
  peopleFollowingQueryKey,
  peopleIndexUsername,
  PEOPLE_RECOMMENDED_QUERY_KEY,
} from "@/lib/people/peopleIndexQueries";
import { clearQueryClientRef, setQueryClientRef } from "@/lib/queryClientRef";
import { useMobileRealtime } from "@/lib/useMobileRealtime";
import { useFscpStore } from "@/stores/fscpStore";
import { useSessionStore } from "@/stores/sessionStore";

export function FloraAppServices({ enabled }: { enabled: boolean }) {
  useMobileRealtime(enabled);

  const username = useSessionStore((s) => s.me?.username ?? "");

  useQuery({
    queryKey: ["conversations"],
    queryFn: () => apiGetConversations(),
    enabled,
  });
  useQuery({
    queryKey: ["groups"],
    queryFn: () => apiListGroups(),
    enabled,
  });
  useQuery({
    queryKey: ["notifications", "all", ""],
    queryFn: () => apiListNotifications({ category: "all", take: 100 }),
    enabled,
  });
  useQuery({
    queryKey: ["profile-posts", username],
    queryFn: () => apiGetProfilePosts(username, { skip: 0, take: 30 }),
    enabled: enabled && username.length > 0,
  });
  useQuery({
    queryKey: MUSIC_LIBRARY_QUERY_KEY,
    queryFn: fetchMusicLibraryQuery,
    enabled,
  });
  useQuery({
    queryKey: MUSIC_PLAYLISTS_QUERY_KEY,
    queryFn: fetchMusicPlaylistsQuery,
    enabled,
  });
  useQuery({
    queryKey: PEOPLE_RECOMMENDED_QUERY_KEY,
    queryFn: fetchPeopleRecommendedQuery,
    enabled,
  });
  useQuery({
    queryKey: peopleFollowersQueryKey(username),
    queryFn: () => fetchPeopleFollowersQuery(username),
    enabled: enabled && peopleIndexUsername(username).length > 0,
  });
  useQuery({
    queryKey: peopleFollowingQueryKey(username),
    queryFn: () => fetchPeopleFollowingQuery(username),
    enabled: enabled && peopleIndexUsername(username).length > 0,
  });
  useQuery({
    queryKey: COMMUNITIES_RECOMMENDED_QUERY_KEY,
    queryFn: fetchCommunitiesRecommendedQuery,
    enabled,
  });
  useQuery({
    queryKey: COMMUNITIES_OWNED_QUERY_KEY,
    queryFn: fetchCommunitiesOwnedQuery,
    enabled,
  });
  useQuery({
    queryKey: communitiesSubscriptionsQueryKey(username),
    queryFn: () => fetchCommunitiesSubscriptionsQuery(username),
    enabled: enabled && communitiesIndexUsername(username).length > 0,
  });

  const userUuid = useSessionStore((s) => s.me?.userUuid ?? null);
  const fscpStatus = useFscpStore((s) => s.status);
  const fscpMaterial = useFscpStore((s) => s.material);
  const fscpCanDecrypt = useFscpStore((s) => s.canDecrypt);
  const queryClient = useQueryClient();

  // Тихий прогрев топ-тредов и превью; рестарт на смену fscp-статуса —
  // разблокировка ключей включает decrypt-прогрев.
  useEffect(() => {
    if (!enabled) return;
    return startChatThreadsPrefetch(queryClient);
  }, [enabled, fscpStatus, queryClient]);

  useEffect(() => {
    useChatListOverlayStore.getState().hydrate(enabled ? userUuid : null);
  }, [enabled, userUuid]);

  useEffect(() => {
    const setFscpKeys = useChatListOverlayStore.getState().setFscpKeys;
    if (enabled && fscpMaterial && fscpCanDecrypt()) {
      setFscpKeys({
        agreementPrivateKey: fscpMaterial.agreementPrivateKey,
        signingPrivateKey: fscpMaterial.signingPrivateKey,
      });
    } else {
      setFscpKeys(null);
    }
  }, [enabled, fscpCanDecrypt, fscpMaterial, fscpStatus]);

  // Исполнитель offscreen-замеров раскладки пузырей: невидим, нулевого
  // размера; живёт здесь, чтобы греть замеры и с других вкладок.
  return enabled ? <MessageTextMeasureWarmHost /> : null;
}

export function QueryClientRefBridge({ client }: { client: QueryClient }) {
  useEffect(() => {
    setQueryClientRef(client);
    return () => clearQueryClientRef();
  }, [client]);

  return null;
}
