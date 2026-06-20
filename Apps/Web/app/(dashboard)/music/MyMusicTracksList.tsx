"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PostMoreMenuRect } from "@/app/_shared/PostMoreMenuRect";
import type { MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import { formatTrackDuration } from "@/app/(dashboard)/music/musicTracks";
import { MusicDeleteTrackModal } from "@/app/(dashboard)/music/MusicDeleteTrackModal";
import { MusicTrackArtistLine } from "@/app/(dashboard)/music/MusicTrackArtistLine";
import { MusicTrackTitleRow } from "@/app/(dashboard)/music/MusicTrackTitleRow";
import { TrackCoverButton } from "@/app/(dashboard)/music/TrackCoverButton";
import { mapMusicTrackItemsToPlayerTracks } from "@/app/(dashboard)/music/player/mapPlayerTrack";
import { useMusicPlayer } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import { invalidateMusicCaches } from "@/lib/dashboardPreload";
import { apiDeleteMusicTrack, apiFetchMusicTrackCoverBlob } from "@/lib/musicApi";
import { floraDurationMs } from "@/lib/floraMotion";
import styles from "./music.module.css";

type MyMusicTracksListProps = {
  tracks: MusicTrackItem[];
  onTracksChange: (tracks: MusicTrackItem[]) => void;
  onPlatformTrackDeleted?: () => void;
  playbackSourceId?: string;
};

const DELETE_MODAL_CLOSE_MS = floraDurationMs(2);
const DEFAULT_PLAYBACK_SOURCE_ID = "my-music";

function IconRemove() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}

function isPlatformPublicationTrack(track: MusicTrackItem): boolean {
  return track.isOwnPlatformUpload === true;
}

export function MyMusicTracksList({
  tracks,
  onTracksChange,
  onPlatformTrackDeleted,
  playbackSourceId = DEFAULT_PLAYBACK_SOURCE_ID,
}: MyMusicTracksListProps) {
  const { playQueue, togglePlay, isTrackActive, isTrackPlaying, busy, stop } = useMusicPlayer();
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<MusicTrackItem | null>(null);
  const [deleteModalClosing, setDeleteModalClosing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const playerTracks = useMemo(() => mapMusicTrackItemsToPlayerTracks(tracks), [tracks]);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    void (async () => {
      const next: Record<string, string> = {};
      for (const track of tracks) {
        if (!track.hasCoverImage) continue;
        try {
          const blob = await apiFetchMusicTrackCoverBlob(track.id);
          const url = URL.createObjectURL(blob);
          createdUrls.push(url);
          next[track.id] = url;
        } catch {
          // UI falls back to hue cover.
        }
      }
      if (!cancelled) setCoverUrls(next);
    })();

    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [tracks]);

  const handlePlayToggle = useCallback(
    (track: MusicTrackItem, index: number) => {
      if (isTrackActive(track.id)) {
        togglePlay();
        return;
      }

      playQueue(playerTracks, index, { sourceId: playbackSourceId });
    },
    [isTrackActive, playQueue, playbackSourceId, playerTracks, togglePlay],
  );

  const closeDeleteModal = useCallback(() => {
    if (deleteBusy) return;
    setDeleteModalClosing(true);
    window.setTimeout(() => {
      setPendingDelete(null);
      setDeleteModalClosing(false);
      setDeleteError(null);
    }, DELETE_MODAL_CLOSE_MS);
  }, [deleteBusy]);

  const openDeleteModal = useCallback((track: MusicTrackItem) => {
    setDeleteError(null);
    setDeleteModalClosing(false);
    setPendingDelete(track);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const track = pendingDelete;
    const isPlatformPublication = isPlatformPublicationTrack(track);

    if (isTrackActive(track.id)) stop();
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDeleteMusicTrack(track.id);
      invalidateMusicCaches();
      onTracksChange(tracks.filter((t) => t.id !== track.id));
      if (isPlatformPublication) onPlatformTrackDeleted?.();
      setPendingDelete(null);
      setDeleteModalClosing(false);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Не удалось удалить трек.");
    } finally {
      setDeleteBusy(false);
    }
  }, [isTrackActive, onPlatformTrackDeleted, onTracksChange, pendingDelete, stop, tracks]);

  if (tracks.length === 0) return null;

  const isPlatformPublication = pendingDelete ? isPlatformPublicationTrack(pendingDelete) : false;

  return (
    <>
      <section className={styles.myMusicTracksSection} aria-label="Треки">
        <ul className={styles.myMusicTracksList}>
          {tracks.map((track, index) => {
            const isPlaying = isTrackPlaying(track.id);
            const isLoading = busy && isTrackActive(track.id) && !isPlaying;
            const removeLabel = isPlatformPublicationTrack(track)
              ? `Удалить «${track.title}» с площадки`
              : `Удалить «${track.title}»`;

            return (
              <li key={track.id} className={styles.myMusicTrackRow} data-playing={isPlaying ? "" : undefined}>
                <TrackCoverButton
                  coverColor={track.coverColor}
                  trackKindId={track.trackKindId}
                  coverUrl={coverUrls[track.id] ?? null}
                  title={track.title}
                  isPlaying={isPlaying}
                  isLoading={isLoading}
                  onClick={() => handlePlayToggle(track, index)}
                />
                <div className={styles.myMusicTrackBody}>
                  <MusicTrackTitleRow
                    title={track.title}
                    showOwnPlatformBadge={track.isOwnPlatformUpload === true}
                  />
                  <MusicTrackArtistLine artist={track.artist} artistCredits={track.artistCredits} />
                </div>
                <span className={`${styles.myMusicTrackDuration} flora-type-15`} aria-label="Длительность">
                  {formatTrackDuration(track.durationSeconds)}
                </span>
                <button
                  type="button"
                  className={`${styles.myMusicTrackActionBtn} ${styles.myMusicTrackRemoveBtn}`}
                  aria-label={removeLabel}
                  onClick={() => openDeleteModal(track)}
                >
                  <IconRemove />
                </button>
                <PostMoreMenuRect
                  variant="track"
                  wrapClassName={styles.myMusicTrackMoreWrap}
                  buttonClassName={styles.myMusicTrackMoreBtn}
                  accessibility={{
                    dialog: `Меню «${track.title}»`,
                    triggerOpen: `Действия с «${track.title}»`,
                    triggerClose: `Закрыть меню «${track.title}»`,
                  }}
                />
              </li>
            );
          })}
        </ul>
      </section>

      <MusicDeleteTrackModal
        open={pendingDelete != null}
        closing={deleteModalClosing}
        busy={deleteBusy}
        error={deleteError}
        trackTitle={pendingDelete?.title ?? ""}
        removesFromPlatform={isPlatformPublication}
        onClose={closeDeleteModal}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
