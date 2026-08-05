import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Сообщения");

export default function MessagesLayout({ children }: { children: ReactNode }) {
  return children;
}
