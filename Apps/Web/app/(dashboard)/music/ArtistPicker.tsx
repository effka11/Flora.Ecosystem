"use client";

import { useEffect, useId, useMemo, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import {
  apiCreateMusicArtist,
  apiSearchMusicArtists,
  type MusicArtistSummaryDto,
  type TrackArtistCreditInput,
  type TrackArtistJoiner,
} from "@/lib/musicApi";
import {
  MUSIC_COVER_ACCEPT,
  validateMusicCoverFile,
} from "@/app/(dashboard)/music/uploadAudioValidation";
import styles from "./addTrackUpload.module.css";

export const TRACK_ARTIST_JOINERS = [
  "None",
  "And",
  "Ft",
  "Vs",
  "Prod",
  "Mix",
  "Remix",
  "Edit",
  "Pres",
] as const satisfies readonly TrackArtistJoiner[];

const JOINER_OPTIONS = [
  { value: "And", label: "&" },
  { value: "Ft", label: "ft." },
  { value: "Vs", label: "vs." },
  { value: "Prod", label: "prod." },
  { value: "Mix", label: "mix." },
  { value: "Remix", label: "remix" },
  { value: "Edit", label: "edit." },
  { value: "Pres", label: "pres." },
] as const satisfies ReadonlyArray<{ value: Exclude<TrackArtistJoiner, "None">; label: string }>;

type ArtistPickerProps = {
  value: TrackArtistCreditInput[];
  onChange: (value: TrackArtistCreditInput[]) => void;
  allowMultiple?: boolean;
};

function normalizeCredits(
  credits: TrackArtistCreditInput[],
  allowMultiple: boolean,
): TrackArtistCreditInput[] {
  const next: TrackArtistCreditInput[] = [];

  for (const credit of credits) {
    const artistUuid = credit.artistUuid.trim();
    if (!artistUuid) continue;
    if (!allowMultiple && next.some((item) => item.artistUuid === artistUuid)) continue;
    next.push({
      artistUuid,
      joinerBefore: next.length === 0 ? "None" : credit.joinerBefore === "None" ? "And" : credit.joinerBefore,
    });
    if (!allowMultiple) break;
  }

  return next;
}

function formatArtistTrackCount(count: number): string {
  const n = Math.max(0, Math.floor(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} трек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} трека`;
  return `${n} треков`;
}

export function ArtistPicker({ value, onChange, allowMultiple = false }: ArtistPickerProps) {
  const { me } = useCurrentUser();
  const searchId = useId();
  const createTitleId = useId();
  const createDescriptionId = useId();
  const createNameId = useId();
  const createCoverId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MusicArtistSummaryDto[]>([]);
  const [knownArtists, setKnownArtists] = useState<Record<string, MusicArtistSummaryDto>>({});
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [linkToMyProfile, setLinkToMyProfile] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalReady, setPortalReady] = useState(false);

  const normalizedValue = useMemo(
    () => normalizeCredits(value, allowMultiple),
    [allowMultiple, value],
  );

  useEffect(() => {
    const next = normalizeCredits(value, allowMultiple);
    const same =
      next.length === value.length &&
      next.every((credit, index) => {
        const current = value[index];
        return current?.artistUuid === credit.artistUuid && current.joinerBefore === credit.joinerBefore;
      });
    if (!same) onChange(next);
  }, [allowMultiple, onChange, value]);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const found = await apiSearchMusicArtists(q, 8);
          if (cancelled) return;
          setResults(found);
          setKnownArtists((prev) => {
            const next = { ...prev };
            for (const artist of found) next[artist.artistUuid] = artist;
            return next;
          });
        } catch (searchError) {
          if (!cancelled) {
            setResults([]);
            setError(searchError instanceof Error ? searchError.message : "Не удалось найти артистов.");
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!createModalOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !creating) {
        setCreateModalOpen(false);
        setCreateError(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [createModalOpen, creating]);

  useEffect(() => {
    return () => {
      if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    };
  }, [coverPreviewUrl]);

  const addArtist = (artist: MusicArtistSummaryDto) => {
    setKnownArtists((prev) => ({ ...prev, [artist.artistUuid]: artist }));
    const nextCredit: TrackArtistCreditInput = {
      artistUuid: artist.artistUuid,
      joinerBefore: normalizedValue.length === 0 ? "None" : "And",
    };
    onChange(normalizeCredits(allowMultiple ? [...normalizedValue, nextCredit] : [nextCredit], allowMultiple));
    setQuery("");
    setResults([]);
    setError(null);
  };

  const removeArtist = (index: number) => {
    onChange(normalizeCredits(normalizedValue.filter((_, i) => i !== index), allowMultiple));
  };

  const updateJoiner = (index: number, joinerBefore: TrackArtistJoiner) => {
    onChange(
      normalizeCredits(
        normalizedValue.map((credit, i) => (i === index ? { ...credit, joinerBefore } : credit)),
        allowMultiple,
      ),
    );
  };

  const openCreateModal = () => {
    setCreateName(query.trim());
    setCoverFile(null);
    setCoverPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setLinkToMyProfile(false);
    setCreateError(null);
    setError(null);
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (creating) return;
    setCreateModalOpen(false);
    setCreateError(null);
    setCoverFile(null);
    setCoverPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  };

  const handleCoverChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setCoverFile(null);
      setCoverPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    const coverError = validateMusicCoverFile(file);
    if (coverError) {
      setCoverFile(null);
      setCoverPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setCreateError(coverError);
      event.target.value = "";
      return;
    }

    setCreateError(null);
    setCoverFile(file);
    setCoverPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };

  const submitCreateArtist = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError("Введите имя артиста.");
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const artist = await apiCreateMusicArtist(name, linkToMyProfile, coverFile);
      addArtist(artist);
      setCreateModalOpen(false);
      setCreateName("");
      setCoverFile(null);
      setCoverPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setLinkToMyProfile(false);
    } catch (createError) {
      setCreateError(createError instanceof Error ? createError.message : "Не удалось создать артиста.");
    } finally {
      setCreating(false);
    }
  };

  const handleCreateNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCreateArtist();
    }
  };

  const renderArtistMeta = (artist: MusicArtistSummaryDto) => {
    const hints = [formatArtistTrackCount(artist.tracksCount)];
    if (artist.linkedUserUuid) hints.push("связан с профилем");
    if (me?.userUuid && artist.createdByUserUuid.toLowerCase() === me.userUuid.toLowerCase()) hints.push("ваш");
    return hints.join(" · ");
  };

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setQuery(next);
    setError(null);
    if (next.trim().length === 0) {
      setResults([]);
      setSearching(false);
    } else {
      setSearching(true);
    }
  };

  const createModal =
    createModalOpen && portalReady ? (
      <>
        <div
          className={styles.artistCreateModalBackdrop}
          onClick={closeCreateModal}
          aria-hidden
        />
        <div className={styles.artistCreateModal} role="presentation">
          <div
            className={styles.artistCreateModalDialog}
            role="dialog"
            aria-modal
            aria-labelledby={createTitleId}
            aria-describedby={createDescriptionId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.artistCreateModalHeader}>
              <h2 id={createTitleId} className={styles.artistCreateModalTitle}>
                Создать артиста
              </h2>
              <button
                type="button"
                className={styles.artistCreateModalClose}
                onClick={closeCreateModal}
                disabled={creating}
                aria-label="Закрыть"
              >
                &times;
              </button>
            </div>

            <div className={styles.artistCreateModalBody}>
              <p id={createDescriptionId} className={styles.artistCreateModalText}>
                Артист появится в поиске и будет добавлен к этому треку.
              </p>
              <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={createNameId}>
                Имя артиста
              </label>
              <div className={styles.addTrackInputBox}>
                <input
                  id={createNameId}
                  type="text"
                  className={styles.addTrackInput}
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={handleCreateNameKeyDown}
                  placeholder="Имя артиста"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div className={styles.artistCreateCoverField}>
                <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={createCoverId}>
                  Обложка исполнителя
                </label>
                <div className={styles.artistCreateCoverRow}>
                  <div className={styles.artistCreateCoverPreview} aria-hidden>
                    {coverPreviewUrl ? (
                      <span
                        className={styles.artistCreateCoverImage}
                        style={{ backgroundImage: `url("${coverPreviewUrl}")` }}
                      />
                    ) : (
                      <span>{(createName.trim().slice(0, 1) || "A").toLocaleUpperCase("ru-RU")}</span>
                    )}
                  </div>
                  <div className={styles.artistCreateCoverControls}>
                    <input
                      id={createCoverId}
                      type="file"
                      accept={MUSIC_COVER_ACCEPT}
                      className={styles.artistCreateCoverInput}
                      onChange={handleCoverChange}
                    />
                    <p className={`${styles.artistCreateCoverHint} flora-type-15`}>
                      Квадратное изображение до 5 МБ.
                    </p>
                  </div>
                </div>
              </div>
              <label className={styles.addTrackCheckboxRow}>
                <input
                  type="checkbox"
                  className={styles.addTrackCheckboxInput}
                  checked={linkToMyProfile}
                  onChange={(event) => setLinkToMyProfile(event.target.checked)}
                />
                <span className={`${styles.addTrackCheckboxLabel} flora-type-15`}>
                  Привязать к моему профилю
                </span>
              </label>
              {createError ? (
                <p className={`${styles.addTrackDropError} flora-type-15`} role="alert">
                  {createError}
                </p>
              ) : null}
            </div>

            <div className={styles.artistCreateModalActions}>
              <button
                type="button"
                className={`${styles.artistCreateModalBtnPrimary} flora-type-15`}
                disabled={creating}
                onClick={() => void submitCreateArtist()}
              >
                {creating ? "Создание..." : "Создать"}
              </button>
              <button
                type="button"
                className={`${styles.artistCreateModalBtnCancel} flora-type-15`}
                disabled={creating}
                onClick={closeCreateModal}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      </>
    ) : null;

  return (
    <div className={styles.artistPicker}>
      {normalizedValue.length > 0 ? (
        <div className={styles.artistPickerSelected} aria-label="Выбранные исполнители">
          {normalizedValue.map((credit, index) => {
            const artist = knownArtists[credit.artistUuid];
            return (
              <div key={`${credit.artistUuid}-${index}`} className={styles.artistPickerSelectedRow}>
                {allowMultiple && index > 0 ? (
                  <select
                    className={`${styles.artistPickerJoinerSelect} flora-type-15`}
                    value={credit.joinerBefore === "None" ? "And" : credit.joinerBefore}
                    aria-label={`Связка перед ${artist?.displayName ?? credit.artistUuid}`}
                    onChange={(event) =>
                      updateJoiner(index, event.target.value as TrackArtistJoiner)
                    }
                  >
                    {JOINER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : allowMultiple ? (
                  <span className={`${styles.artistPickerJoinerText} flora-type-15`}>основной</span>
                ) : null}
                <span className={styles.artistPickerSelectedName}>
                  {artist?.displayName ?? credit.artistUuid}
                </span>
                <button
                  type="button"
                  className={styles.artistPickerRemoveBtn}
                  aria-label={`Убрать ${artist?.displayName ?? credit.artistUuid}`}
                  onClick={() => removeArtist(index)}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {allowMultiple || normalizedValue.length === 0 ? (
        <div className={styles.artistPickerSearchBlock}>
          <div className={styles.artistPickerSearchRow}>
            <div className={styles.addTrackInputBox}>
              <input
                id={searchId}
                type="text"
                className={styles.addTrackInput}
                value={query}
                onChange={handleQueryChange}
                placeholder={allowMultiple && normalizedValue.length > 0 ? "Добавить исполнителя" : "Найти исполнителя"}
                autoComplete="off"
              />
            </div>
            <button
              type="button"
              className={styles.artistPickerAddBtn}
              aria-label="Создать исполнителя"
              aria-haspopup="dialog"
              disabled={creating}
              onClick={openCreateModal}
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {query.trim().length > 0 ? (
            <div className={styles.artistPickerResults} role="listbox" aria-labelledby={searchId}>
              {searching ? (
                <p className={`${styles.artistPickerResultHint} flora-type-15`}>Поиск…</p>
              ) : results.length > 0 ? (
                results.map((artist) => {
                  const disabled = !allowMultiple && normalizedValue.some((credit) => credit.artistUuid === artist.artistUuid);
                  return (
                    <button
                      key={artist.artistUuid}
                      type="button"
                      className={styles.artistPickerResultBtn}
                      disabled={disabled}
                      onClick={() => addArtist(artist)}
                    >
                      <span className={`${styles.artistPickerResultName} flora-type-15`}>
                        {artist.displayName}
                      </span>
                      <span className={`${styles.artistPickerResultMeta} flora-type-15`}>
                        {disabled ? "уже выбран" : renderArtistMeta(artist)}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className={`${styles.artistPickerResultHint} flora-type-15`}>Артисты не найдены.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className={`${styles.addTrackDropError} flora-type-15`} role="alert">
          {error}
        </p>
      ) : null}

      {portalReady && createModal ? createPortal(createModal, document.body) : null}
    </div>
  );
}
