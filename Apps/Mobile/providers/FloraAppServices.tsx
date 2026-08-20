import {
  apiGetConversations,
  apiGetProfilePosts,
  apiListGroups,
  apiListNotifications,
} from "@flora/client-core/api";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useChatListOverlayStore } from "@/lib/chatListOverlayStore";
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

  const userUuid = useSessionStore((s) => s.me?.userUuid ?? null);
  const fscpStatus = useFscpStore((s) => s.status);
  const fscpMaterial = useFscpStore((s) => s.material);
  const fscpCanDecrypt = useFscpStore((s) => s.canDecrypt);

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

  return null;
}

export function QueryClientRefBridge({ client }: { client: QueryClient }) {
  useEffect(() => {
    setQueryClientRef(client);
    return () => clearQueryClientRef();
  }, [client]);

  return null;
}
