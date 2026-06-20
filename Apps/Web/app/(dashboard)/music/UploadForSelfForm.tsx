"use client";

import { useCallback, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ApiRequestError } from "@/lib/auth";
import { invalidateMusicCaches } from "@/lib/dashboardPreload";
import { apiUploadMusicTrackSelf } from "@/lib/musicApi";
import { probeAudioDurationMs } from "@/lib/probeAudioDurationMs";
import {
  MUSIC_DEFAULT_COVER_ID,
  MUSIC_DEFAULT_COVERS
} from "@/app/(dashboard)/music/musicDefaultCovers";
import { MusicTrackKindIcon } from "@/app/(dashboard)/music/MusicTrackKindIcon";
import {
  MUSIC_DEFAULT_TRACK_KIND_ID,
  MUSIC_TRACK_KINDS,
  type MusicTrackKindId
} from "@/app/(dashboard)/music/musicTrackKinds";
import {
  formatFileSizeRu,
  formatAudioFileLabel,
  MUSIC_AUDIO_ACCEPT,
  validateMusicUploadFile,
} from "@/app/(dashboard)/music/uploadAudioValidation";
import styles from "./addTrackUpload.module.css";

type UploadForSelfFormProps = {
  onUploaded?: () => void;
};

export function UploadForSelfForm({ onUploaded }: UploadForSelfFormProps) {
  const titleId = useId();
  const artistId = useId();
  const tagsId = useId();
  const coverLegendId = useId();
  const dropZoneId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [tags, setTags] = useState("");
  const [coverColorId, setCoverColorId] = useState(MUSIC_DEFAULT_COVER_ID);
  const [trackKindId, setTrackKindId] = useState<MusicTrackKindId>(MUSIC_DEFAULT_TRACK_KIND_ID);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  const selectedCover =
    MUSIC_DEFAULT_COVERS.find((c) => c.id === coverColorId) ?? MUSIC_DEFAULT_COVERS[0]!;
  const selectedKind =
    MUSIC_TRACK_KINDS.find((k) => k.id === trackKindId) ?? MUSIC_TRACK_KINDS[0]!;

  const applyFile = useCallback((file: File | null) => {
    if (!file) {
      setAudioFile(null);
      setFileError(null);
      return;
    }
    const error = validateMusicUploadFile(file);
    if (error) {
      setAudioFile(null);
      setFileError(error);
      return;
    }
    setAudioFile(file);
    setFileError(null);
  }, []);

  const handleFileList = useCallback(
    (list: FileList | null) => {
      const file = list?.[0] ?? null;
      applyFile(file);
    },
    [applyFile],
  );

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    handleFileList(event.dataTransfer.files);
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUploadError(null);
    setUploadSuccess(false);

    if (!audioFile) {
      setUploadError("Выберите аудиофайл.");
      return;
    }
    if (!artist.trim()) {
      setUploadError("Укажите исполнителя.");
      return;
    }

    const fileErrorMsg = validateMusicUploadFile(audioFile);
    if (fileErrorMsg) {
      setUploadError(fileErrorMsg);
      return;
    }

    setUploading(true);
    try {
      const durationMs = await probeAudioDurationMs(audioFile);
      await apiUploadMusicTrackSelf({
        file: audioFile,
        title,
        artist: artist.trim(),
        tags,
        coverColorId,
        trackKindId,
        durationMs,
      });
      invalidateMusicCaches();
      setUploadSuccess(true);
      setAudioFile(null);
      setTitle("");
      setArtist("");
      setTags("");
      setCoverColorId(MUSIC_DEFAULT_COVER_ID);
      setTrackKindId(MUSIC_DEFAULT_TRACK_KIND_ID);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onUploaded?.();
    } catch (error) {
      setUploadError(
        error instanceof ApiRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Не удалось загрузить трек.",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={styles.addTrackScroll}>
      <form
        className={styles.addTrackForm}
        onSubmit={handleSubmit}
        aria-label="Загрузить трек для себя"
      >
        <div className={styles.addTrackFormGrid}>
          <div className={styles.addTrackFormMain}>
            <div className={styles.addTrackField}>
              <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={titleId}>
                Название
              </label>
              <div className={styles.addTrackInputBox}>
                <input
                  id={titleId}
                  type="text"
                  className={styles.addTrackInput}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Без названия"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className={styles.addTrackField}>
              <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={artistId}>
                Исполнитель
              </label>
              <div className={styles.addTrackInputBox}>
                <input
                  id={artistId}
                  type="text"
                  className={styles.addTrackInput}
                  value={artist}
                  onChange={(event) => setArtist(event.target.value)}
                  placeholder="Вы"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className={styles.addTrackField}>
              <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={tagsId}>
                Теги
              </label>
              <div className={styles.addTrackInputBox}>
                <input
                  id={tagsId}
                  type="text"
                  className={styles.addTrackInput}
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="Песня, запись, демо..."
                  autoComplete="off"
                />
              </div>
              <p className={`${styles.addTrackHint} flora-type-15`}>Через запятую — помогут найти трек в библиотеке.</p>
            </div>

          </div>

          <aside className={styles.addTrackFormAside}>
            <div className={styles.addTrackCoverPanel}>
              <p className={`${styles.addTrackLabel} flora-type-15`} id={coverLegendId}>
                Обложка
              </p>
              <div className={styles.addTrackCoverPreviewRow}>
                <div
                  className={styles.addTrackCoverPreview}
                  style={{ background: selectedCover.color }}
                  role="img"
                  aria-label={`Обложка, тип: ${selectedKind.label}`}
                >
                  <MusicTrackKindIcon
                    kind={trackKindId}
                    className={styles.addTrackCoverPreviewKindIcon}
                  />
                </div>
                <div className={styles.addTrackCoverSymbolPalette} role="radiogroup" aria-label="Тип записи">
                  <div className={styles.addTrackCoverSymbolSwatches}>
                    {MUSIC_TRACK_KINDS.map((kind) => (
                      <button
                        key={kind.id}
                        type="button"
                        role="radio"
                        className={styles.addTrackCoverSymbolSwatch}
                        data-selected={trackKindId === kind.id ? "" : undefined}
                        aria-label={kind.label}
                        aria-checked={trackKindId === kind.id}
                        onClick={() => setTrackKindId(kind.id)}
                      >
                        <MusicTrackKindIcon
                          kind={kind.id}
                          className={styles.addTrackCoverKindSwatchIcon}
                          size={20}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={styles.addTrackCoverSwatches} role="group" aria-labelledby={coverLegendId}>
                {MUSIC_DEFAULT_COVERS.map((cover) => (
                  <button
                    key={cover.id}
                    type="button"
                    className={styles.addTrackCoverSwatch}
                    style={{ background: cover.color }}
                    data-selected={coverColorId === cover.id ? "" : undefined}
                    aria-label={`Цвет ${cover.id}`}
                    aria-pressed={coverColorId === cover.id}
                    onClick={() => setCoverColorId(cover.id)}
                  />
                ))}
              </div>
            </div>
          </aside>
        </div>

        <div className={styles.addTrackDropSection}>
          <div
            id={dropZoneId}
            className={styles.addTrackDropZone}
            data-drag-over={isDragOver ? "" : undefined}
            data-has-file={audioFile ? "" : undefined}
            data-error={fileError ? "" : undefined}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={audioFile ? undefined : openFilePicker}
            onKeyDown={(event) => {
              if (audioFile) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openFilePicker();
              }
            }}
            role={audioFile ? undefined : "button"}
            tabIndex={audioFile ? undefined : 0}
            aria-label={audioFile ? undefined : "Перетащите аудио сюда или выберите файл"}
          >
            <input
              ref={fileInputRef}
              className={styles.addTrackFileInput}
              type="file"
              accept={MUSIC_AUDIO_ACCEPT}
              aria-hidden
              onChange={(event) => handleFileList(event.target.files)}
            />

            {audioFile ? (
              <>
                <p className={`${styles.addTrackDropFileName} flora-type-15`}>{audioFile.name}</p>
                <p className={`${styles.addTrackDropHint} flora-type-15`}>
                  {formatFileSizeRu(audioFile.size)} · {formatAudioFileLabel(audioFile)}
                </p>
                <button
                  type="button"
                  className={`${styles.addTrackReplaceBtn} flora-type-15`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openFilePicker();
                  }}
                >
                  Заменить файл
                </button>
                <button
                  type="submit"
                  className={`${styles.addTrackSubmitBtn} ${styles.addTrackSubmitBtnInZone} flora-type-15`}
                  disabled={uploading}
                >
                  {uploading ? "Загрузка…" : "Загрузить"}
                </button>
              </>
            ) : (
              <>
                <div className={styles.addTrackDropIcon} aria-hidden>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 16V4m0 0 4 4m-4-4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
                  </svg>
                </div>
                <p className={`${styles.addTrackDropTitle} flora-type-16`}>Перетащите аудио сюда</p>
                <p className={`${styles.addTrackDropHint} flora-type-15`}>
                  или нажмите «Выбрать файл». MP3, M4A, FLAC, WAV и др., до 70 МБ. Тяжёлые форматы
                  сжимаются на сервере; лёгкие MP3 могут остаться без изменений.
                </p>
                <button
                  type="button"
                  className={`${styles.addTrackChooseBtn} flora-type-15`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openFilePicker();
                  }}
                >
                  Выбрать файл
                </button>
              </>
            )}
          </div>
          {fileError ? (
            <p className={`${styles.addTrackDropError} flora-type-15`} role="alert">
              {fileError}
            </p>
          ) : null}
        </div>

        {uploadError ? (
          <p className={`${styles.addTrackDropError} flora-type-15`} role="alert">
            {uploadError}
          </p>
        ) : null}
        {uploadSuccess ? (
          <p className={`${styles.addTrackUploadSuccess} flora-type-15`} role="status">
            Трек загружен в «Мою музыку».
          </p>
        ) : null}
      </form>
    </div>
  );
}
