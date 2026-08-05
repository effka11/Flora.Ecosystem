import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Сообщество");

export default function CommunityLayout({ children }: { children: ReactNode }) {
  return children;
}
