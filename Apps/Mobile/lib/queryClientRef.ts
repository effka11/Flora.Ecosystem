import type { QueryClient } from "@tanstack/react-query";

let queryClient: QueryClient | null = null;

export function setQueryClientRef(client: QueryClient): void {
  queryClient = client;
}

export function getQueryClientRef(): QueryClient | null {
  return queryClient;
}

export function clearQueryClientRef(): void {
  queryClient = null;
}
