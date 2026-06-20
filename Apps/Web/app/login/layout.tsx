import type { ReactNode } from "react";

/** Fresh HTML on each request — CDN must not serve year-old prerender (grid/CSP). */
export const dynamic = "force-dynamic";

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
