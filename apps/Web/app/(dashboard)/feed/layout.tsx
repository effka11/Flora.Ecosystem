import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Главная");

export default function FeedLayout({ children }: { children: ReactNode }) {
  return children;
}
