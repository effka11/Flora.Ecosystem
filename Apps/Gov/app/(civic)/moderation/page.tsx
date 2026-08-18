import type { Metadata } from "next";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import { ModerationPanel } from "./ModerationPanel";

const nav = CIVIC_NAV.moderation;

export const metadata: Metadata = civicPageMetadata(nav);

export default function ModerationPage() {
  return <ModerationPanel />;
}
