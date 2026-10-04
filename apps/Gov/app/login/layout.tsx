import type { Metadata } from "next";
import type { ReactNode } from "react";
import { formatGovDocumentTitle } from "@/lib/floraDocumentTitle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: formatGovDocumentTitle("Вход") },
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
