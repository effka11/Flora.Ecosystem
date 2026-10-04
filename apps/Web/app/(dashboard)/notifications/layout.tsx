import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Уведомления");

export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return children;
}
