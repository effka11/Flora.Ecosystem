import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { clearQueryClientRef, setQueryClientRef } from "@/lib/queryClientRef";
import { useMobileRealtime } from "@/lib/useMobileRealtime";

export function FloraAppServices({ enabled }: { enabled: boolean }) {
  useMobileRealtime(enabled);
  return null;
}

export function QueryClientRefBridge({ client }: { client: QueryClient }) {
  useEffect(() => {
    setQueryClientRef(client);
    return () => clearQueryClientRef();
  }, [client]);

  return null;
}
