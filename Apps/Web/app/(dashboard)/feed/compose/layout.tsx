import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Создать пост");

export default function ComposeLayout({ children }: { children: ReactNode }) {
  return children;
}
