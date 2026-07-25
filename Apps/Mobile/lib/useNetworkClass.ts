import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { useEffect, useState } from "react";

/**
 * Reachability, not connection quality: the prefetch window is sized from the
 * measured throughput of real `.fri` downloads (`lib/mediaBandwidth.ts`), so a
 * slow link narrows the window by itself and needs no class of its own. The
 * only thing NetInfo still decides is whether to warm a channel at all.
 */
export type NetworkStatus = "online" | "offline";

/** Offline only when NetInfo is sure; an unknown `isConnected` stays online. */
export function classifyNetwork(state: NetInfoState): NetworkStatus {
  return state.isConnected === false || state.type === "none" ? "offline" : "online";
}

/**
 * Optimistic until proven otherwise: the first listener callback lands within
 * a frame or two, and starting offline would cost every cold open its
 * lookahead window, while starting online costs a dead device a few downloads
 * that fail immediately.
 */
export function useNetworkClass(): NetworkStatus {
  const [network, setNetwork] = useState<NetworkStatus>("online");
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setNetwork(classifyNetwork(state));
    });
    return () => unsubscribe();
  }, []);
  return network;
}
