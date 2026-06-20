"use client";

import { useEffect, useState } from "react";
import type { PostVideoDto } from "@/lib/socialApi";
import { apiGetPostVideoStatus, postVideoPosterUrl, postVideoUrl } from "@/lib/socialApi";
import { FloraVideoPlayer } from "./FloraVideoPlayer";
import styles from "./FeedPostVideo.module.css";

const STATUS_POLL_INTERVAL_MS = 4000;

type FeedPostVideoProps = {
  postUuid: string;
  video: PostVideoDto;
  className?: string;
};

/** Видео поста: плеер для готового, плашка статуса на время транскодирования. */
export function FeedPostVideo({ postUuid, video, className }: FeedPostVideoProps) {
  const [current, setCurrent] = useState(video);

  useEffect(() => setCurrent(video), [video]);

  // Поллинг статуса, пока сервер транскодирует.
  useEffect(() => {
    if (current.status !== "processing") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void apiGetPostVideoStatus(postUuid)
        .then((next) => {
          if (!cancelled && next) setCurrent(next);
        })
        .catch(() => {});
    }, STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [current.status, postUuid]);

  const wrapClass = className ? `${styles.wrap} ${className}` : styles.wrap;

  if (current.status === "ready") {
    return (
      <div className={wrapClass}>
        <FloraVideoPlayer
          src={postVideoUrl(current.videoUuid)}
          poster={postVideoPosterUrl(current.videoUuid)}
          width={current.width}
          height={current.height}
        />
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      <div
        className={styles.placeholder}
        style={
          current.width > 0 && current.height > 0
            ? { aspectRatio: `${current.width} / ${current.height}` }
            : undefined
        }
      >
        {current.status === "processing" ? (
          <>
            <span className={styles.spinner} aria-hidden />
            <span className={styles.placeholderText}>Видео обрабатывается…</span>
          </>
        ) : (
          <span className={styles.placeholderText}>Не удалось обработать видео.</span>
        )}
      </div>
    </div>
  );
}
