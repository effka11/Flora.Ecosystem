"use client";

import Link from "next/link";
import { Fragment } from "react";
import type { TrackArtistCredit, TrackArtistJoiner } from "@/lib/musicApi";
import styles from "./music.module.css";

function joinerLabel(joiner: TrackArtistJoiner): string {
  switch (joiner) {
    case "And":
      return " & ";
    case "Ft":
      return " ft. ";
    case "Vs":
      return " vs. ";
    case "Prod":
      return " prod. ";
    case "Mix":
      return " mix. ";
    case "Remix":
      return " remix ";
    case "Edit":
      return " edit. ";
    case "Pres":
      return " pres. ";
    default:
      return "";
  }
}

type MusicTrackArtistLineProps = {
  artist: string;
  artistCredits?: TrackArtistCredit[];
  className?: string;
};

export function MusicTrackArtistLine({ artist, artistCredits, className }: MusicTrackArtistLineProps) {
  const rootClass = className ?? `${styles.myMusicTrackArtist} flora-type-15`;

  if (!artistCredits || artistCredits.length === 0) {
    return <span className={rootClass}>{artist}</span>;
  }

  return (
    <span className={rootClass}>
      {artistCredits.map((credit, index) => (
        <Fragment key={`${credit.artistUuid}-${index}`}>
          {index > 0 ? <span className={styles.trackArtistJoiner}>{joinerLabel(credit.joinerBefore)}</span> : null}
          <Link
            href={`/music/artist/${encodeURIComponent(credit.artistUuid)}`}
            className={styles.trackArtistLink}
            onClick={(event) => event.stopPropagation()}
          >
            {credit.displayName}
          </Link>
        </Fragment>
      ))}
    </span>
  );
}
