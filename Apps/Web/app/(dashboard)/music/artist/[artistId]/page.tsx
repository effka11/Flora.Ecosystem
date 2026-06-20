"use client";

import { useParams } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { MusicArtistView } from "@/app/(dashboard)/music/MusicArtistView";
import styles from "@/app/(dashboard)/music/music.module.css";

export default function MusicArtistPage() {
  const { isClient, hasToken } = useProtectedPage();
  const params = useParams();
  const artistId = typeof params.artistId === "string" ? params.artistId : "";

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return <MusicArtistView artistId={artistId} />;
}
