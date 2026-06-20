"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MusicTrackArtistLine } from "@/app/(dashboard)/music/MusicTrackArtistLine";
import { TrackDefaultCoverArt } from "@/app/(dashboard)/music/TrackDefaultCoverArt";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import { MUSIC_GENRES } from "@/app/(dashboard)/music/musicGenres";
import type { PlaylistItem } from "@/app/(dashboard)/music/musicPlaylists";
import { formatTrackDuration, type MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import {
  filterMusicGenres,
  filterMusicPlaylists,
  filterMusicTracks,
} from "@/app/(dashboard)/music/musicSearch";
import { loadMusicLibrarySnapshot, peekMusicLibrarySnapshot } from "@/lib/musicLibraryPreload";
import styles from "./music.module.css";

type MusicSearchResultsProps = {
  query: string;
};

export function MusicSearchResults({ query }: MusicSearchResultsProps) {
  const router = useRouter();
  const [playlists, setPlaylists] = useState<PlaylistItem[]>(() => peekMusicLibrarySnapshot()?.playlists ?? []);
  const [tracks, setTracks] = useState<MusicTrackItem[]>(() => peekMusicLibrarySnapshot()?.tracks ?? []);

  useEffect(() => {
    let cancelled = false;
    const hadCachedSnapshot = peekMusicLibrarySnapshot() != null;
    void (async () => {
      try {
        const snapshot = await loadMusicLibrarySnapshot();
        if (cancelled) return;
        setTracks(snapshot.tracks);
        setPlaylists(snapshot.playlists);
      } catch {
        if (!cancelled && !hadCachedSnapshot) {
          setTracks([]);
          setPlaylists([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const genres = useMemo(() => filterMusicGenres(MUSIC_GENRES, query), [query]);
  const filteredPlaylists = useMemo(() => filterMusicPlaylists(playlists, query), [playlists, query]);
  const filteredTracks = useMemo(() => filterMusicTracks(tracks, query), [tracks, query]);

  const isEmpty = genres.length === 0 && filteredPlaylists.length === 0 && filteredTracks.length === 0;

  if (isEmpty) {
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
      {genres.length > 0 ? (
        <section className={styles.musicSearchSection} aria-label="Жанры">
          <h3 className={styles.musicSearchSectionTitle}>Жанры</h3>
          <ul className={styles.musicSearchChipList}>
            {genres.map((genre) => (
              <li key={genre.id}>
                <Link
                  href={`/music/genre/${encodeURIComponent(genre.id)}`}
                  className={styles.musicSearchChip}
                >
                  {genre.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {filteredPlaylists.length > 0 ? (
        <section className={styles.musicSearchSection} aria-label="Плейлисты">
          <h3 className={styles.musicSearchSectionTitle}>Плейлисты</h3>
          <ul className={styles.musicSearchSimpleList}>
            {filteredPlaylists.map((playlist) => (
              <li key={playlist.id} className={styles.musicSearchSimpleRow}>
                <button
                  type="button"
                  className={styles.musicSearchPlaylistBtn}
                  onClick={() =>
                    router.push(`/music/playlist/${encodeURIComponent(playlist.id)}`, { scroll: false })
                  }
                >
                  <span className={styles.musicSearchSimpleTitle}>{playlist.title}</span>
                  <span className={styles.musicSearchSimpleMeta}>{playlist.trackCount} треков</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {filteredTracks.length > 0 ? (
        <section className={styles.musicSearchSection} aria-label="Треки">
          <h3 className={styles.musicSearchSectionTitle}>Треки</h3>
          <ul className={styles.myMusicTracksList}>
            {filteredTracks.map((track) => (
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
      ) : null}
    </div>
  );
}
