import type { ReactNode } from "react";
import { MusicRoutePanelLayout } from "@/app/(dashboard)/music/MusicRoutePanelLayout";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Музыка");

export default function MusicLayout({ children }: { children: ReactNode }) {
  return <MusicRoutePanelLayout>{children}</MusicRoutePanelLayout>;
}
