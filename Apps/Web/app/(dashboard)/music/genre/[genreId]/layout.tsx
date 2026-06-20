"use client";

import { useMemo } from "react";
import { useParams, usePathname } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { MusicGenreView } from "@/app/(dashboard)/music/MusicGenreView";
import styles from "@/app/(dashboard)/music/music.module.css";

function resolveSubgenreId(pathname: string, genreId: string): string | undefined {
  const base = `/music/genre/${encodeURIComponent(genreId)}`;
  if (pathname === base || pathname === `${base}/`) return undefined;
  if (!pathname.startsWith(`${base}/`)) return undefined;

  const tail = pathname.slice(base.length + 1);
  const segment = tail.split("/")[0]?.trim();
  return segment || undefined;
}

export default function MusicGenreLayout({ children }: { children: React.ReactNode }) {
  const { isClient, hasToken } = useProtectedPage();
  const params = useParams();
  const pathname = usePathname();
  const genreId = typeof params.genreId === "string" ? params.genreId : "";
  const subgenreId = useMemo(() => resolveSubgenreId(pathname, genreId), [pathname, genreId]);

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return (
    <>
      <MusicGenreView genreId={genreId} subgenreId={subgenreId} />
      {children}
    </>
  );
}
