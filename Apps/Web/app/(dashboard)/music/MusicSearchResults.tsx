"use client";

import { useEffect, useState } from "react";
import { MusicTrackArtistLine } from "@/app/(dashboard)/music/MusicTrackArtistLine";
import { TrackDefaultCoverArt } from "@/app/(dashboard)/music/TrackDefaultCoverArt";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { normalizeMusicSearchQuery } from "@/app/(dashboard)/music/musicSearch";
import { mapMusicTrackDtoToItem } from "@/app/(dashboard)/music/musicTrackMappers";
import { formatTrackDuration, type MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import { apiSearchMusicTracks } from "@/lib/musicApi";
import styles from "./music.module.css";

type MusicSearchResultsProps = {
  query: string;
};

export function MusicSearchResults({ query }: MusicSearchResultsProps) {
  const [tracks, setTracks] = useState<MusicTrackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!normalizeMusicSearchQuery(query)) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setLoading(true);
        try {
          const rows = await apiSearchMusicTracks(q, 40, 0);
          if (cancelled) return;
          setTracks(rows.map(mapMusicTrackDtoToItem));
          setLoadError(null);
        } catch (e) {
          if (cancelled) return;
          setLoadError(e instanceof Error ? e.message : "Не удалось выполнить поиск");
          setTracks([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  if (loadError) {
    return (
      <div className={styles.musicSearchResults}>
        <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`} role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  if (loading && tracks.length === 0) {
    return (
      <div className={styles.musicSearchResults}>
        <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`}>Поиск треков…</p>
      </div>
    );
  }

  if (tracks.length === 0) {
    return (
      <div className={styles.musicSearchResults}>
        <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`}>
          Ничего не найдено. Измените запрос в поиске.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.musicSearchResults}>
      <section className={styles.musicSearchSection} aria-label="Треки">
        <h3 className={styles.musicSearchSectionTitle}>Треки</h3>
        <ul className={styles.myMusicTracksList}>
          {tracks.map((track) => (
            <li key={track.id} className={styles.myMusicTrackRow}>
              <span className={styles.myMusicTrackCover}>
                <TrackDefaultCoverArt
                  coverColor={track.coverColor}
                  trackKindId={track.trackKindId}
                />
              </span>
              <div className={styles.myMusicTrackBody}>
                <span className={`${styles.myMusicTrackTitle} flora-type-15`}>{track.title}</span>
                <MusicTrackArtistLine artist={track.artist} artistCredits={track.artistCredits} />
              </div>
              <span className={`${styles.myMusicTrackDuration} flora-type-15`}>
                {formatTrackDuration(track.durationSeconds)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
