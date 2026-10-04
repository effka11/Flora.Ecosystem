import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Плейлист");

export default function MusicPlaylistLayout({ children }: { children: ReactNode }) {
  return children;
}
