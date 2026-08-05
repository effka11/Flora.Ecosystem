import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Настройки сообщества");

export default function CommunitySettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
