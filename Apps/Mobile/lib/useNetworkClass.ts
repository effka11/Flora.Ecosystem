import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { useEffect, useState } from "react";
import type { NetworkClass } from "@/lib/frcMediaMode";

/**
 * Classify a NetInfo state for background-prefetch budgeting. Offline and truly
 * unknown states are conservative (`unknown` → no background prewarm); metered
 * (cellular / expensive) gets the minimal budget; Wi‑Fi/ethernet the full one.
 */
export function classifyNetwork(state: NetInfoState): NetworkClass {
  if (state.isConnected === false || state.type === "none") return "unknown";
  if (state.type === "wifi" || state.type === "ethernet") return "wifi";
  if (state.type === "cellular") return "metered";
  if (state.details && "isConnectionExpensive" in state.details) {
    return state.details.isConnectionExpensive ? "metered" : "wifi";
  }
  return "unknown";
}

export function useNetworkClass(): NetworkClass {
  const [network, setNetwork] = useState<NetworkClass>("unknown");
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setNetwork(classifyNetwork(state));
    });
    return () => unsubscribe();
  }, []);
  return network;
}
