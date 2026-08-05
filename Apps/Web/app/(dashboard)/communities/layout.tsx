import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Сообщества");

export default function CommunitiesLayout({ children }: { children: ReactNode }) {
  return children;
}
