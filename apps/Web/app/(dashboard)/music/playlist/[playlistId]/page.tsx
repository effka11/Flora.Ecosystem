"use client";

import { useParams } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { MusicPlaylistView } from "@/app/(dashboard)/music/MusicPlaylistView";
import styles from "@/app/(dashboard)/music/music.module.css";

export default function MusicPlaylistPage() {
  const { isClient, hasToken } = useProtectedPage();
  const params = useParams();
  const playlistId = typeof params.playlistId === "string" ? params.playlistId : "";

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return <MusicPlaylistView playlistId={playlistId} />;
}
