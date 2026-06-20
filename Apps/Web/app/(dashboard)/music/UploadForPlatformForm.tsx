"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { ApiRequestError } from "@/lib/auth";
import { invalidateMusicCaches } from "@/lib/dashboardPreload";
import { apiUploadMusicTrackPlatform, type TrackArtistCreditInput } from "@/lib/musicApi";
import { probeAudioDurationMs } from "@/lib/probeAudioDurationMs";
import {
  formatAudioFileLabel,
  formatFileSizeRu,
  MUSIC_AUDIO_ACCEPT,
  validateMusicUploadFile,
} from "@/app/(dashboard)/music/uploadAudioValidation";
import styles from "./addTrackUpload.module.css";
import { AddTrackGenreSelect } from "./AddTrackGenreSelect";
import { AddTrackSimpleSelect } from "./AddTrackSimpleSelect";
import Link from "next/link";
import { ArtistPicker } from "@/app/(dashboard)/music/ArtistPicker";

const LICENSE_OPTIONS = [
  { id: "all_rights_reserved", label: "All Rights Reserved" },
  { id: "cc_by", label: "CC BY" },
  { id: "cc_by_nc", label: "CC BY-NC" },
  { id: "cc_by_nd", label: "CC BY-ND" },
  { id: "cc_by_nc_nd", label: "CC BY-NC-ND" },
  { id: "cc0", label: "CC0" },
];

type UploadForPlatformFormProps = {
  onUploaded?: () => void;
};

export function UploadForPlatformForm({ onUploaded }: UploadForPlatformFormProps) {
  const titleId = useId();
  const licenseId = useId();
  const genreId = useId();
  const dropZoneId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [artistCredits, setArtistCredits] = useState<TrackArtistCreditInput[]>([]);
  const [license, setLicense] = useState(LICENSE_OPTIONS[0]!.id);
  const [genre, setGenre] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [agreedChecked, setAgreedChecked] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);

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

  const openCoverPicker = () => {
    coverInputRef.current?.click();
  };

  const handleCoverChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setCoverFile(file);
      setCoverImage((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUploadError(null);
    setUploadSuccess(false);

    if (!audioFile) {
      setUploadError("Выберите аудиофайл.");
      return;
    }
    if (artistCredits.length === 0) {
      setUploadError("Выберите исполнителя.");
      return;
    }
    if (!genre.trim()) {
      setUploadError("Выберите жанр.");
      return;
    }
    if (!agreedChecked) {
      setUploadError("Примите условия пользовательского соглашения.");
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
      await apiUploadMusicTrackPlatform({
        file: audioFile,
        title,
        artistCredits,
        genreId: genre,
        licenseId: license,
        termsAccepted: agreedChecked,
        durationMs,
        cover: coverFile,
      });
      invalidateMusicCaches();
      setUploadSuccess(true);
      setAudioFile(null);
      setTitle("");
      setArtistCredits([]);
      setGenre("");
      setLicense(LICENSE_OPTIONS[0]!.id);
      setAgreedChecked(false);
      setCoverFile(null);
      setCoverImage((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (coverInputRef.current) coverInputRef.current.value = "";
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
        className={`${styles.addTrackForm} ${styles.addTrackFormPlatform}`}
        onSubmit={handleSubmit}
        aria-label="Загрузить трек на площадку"
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
              <p className={`${styles.addTrackLabel} flora-type-15`}>
                Исполнитель
              </p>
              <ArtistPicker
                value={artistCredits}
                onChange={setArtistCredits}
                allowMultiple
              />
            </div>

            <div className={styles.addTrackFieldRow}>
              <div className={`${styles.addTrackField} ${styles.addTrackFieldGenre}`}>
                <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={genreId}>
                  Жанр
                </label>
                <div className={styles.addTrackInputBox}>
                  <AddTrackGenreSelect
                    id={genreId}
                    value={genre}
                    onChange={setGenre}
                  />
                  <svg
                    className={styles.addTrackSelectIcon}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </div>

              <div className={`${styles.addTrackField} ${styles.addTrackFieldLicense}`}>
                <div className={styles.addTrackLabelRow}>
                  <label className={`${styles.addTrackLabel} flora-type-15`} htmlFor={licenseId}>
                    Тип лицензии
                  </label>
                  <div className={styles.addTrackLabelInfoGroup}>
                    <button
                      type="button"
                      className={styles.addTrackLabelInfoBtn}
                      aria-label="Информация о лицензиях"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    </button>
                    {license === "all_rights_reserved" && (
                      <div className={styles.addTrackLabelWarningWrap}>
                        <button
                          type="button"
                          className={styles.addTrackLabelWarningBtn}
                          aria-label="Предупреждение о лицензии All Rights Reserved"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                        </button>
                        <div className={styles.addTrackLabelInfoTooltip} role="tooltip">
                          Загрузка чужой музыки под видом своей запрещена. Вы несёте ответственность за права на загружаемый материал.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className={styles.addTrackInputBox}>
                  <AddTrackSimpleSelect
                    id={licenseId}
                    value={license}
                    onChange={setLicense}
                    options={LICENSE_OPTIONS}
                  />
                  <svg className={styles.addTrackSelectIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
              </div>
            </div>

            <div className={styles.addTrackCheckboxes}>
              <label className={styles.addTrackCheckboxRow}>
                <input
                  type="checkbox"
                  className={styles.addTrackCheckboxInput}
                  checked={agreedChecked}
                  onChange={(e) => setAgreedChecked(e.target.checked)}
                />
                <span className={`${styles.addTrackCheckboxLabel} ${styles.addTrackCheckboxLabelTwoLines} flora-type-15`}>
                  <span className={styles.addTrackCheckboxLabelLine}>
                    Подтверждаю, что обладаю всеми необходимыми правами на загрузку этого материала,
                  </span>
                  <span className={styles.addTrackCheckboxLabelLine}>
                    и принимаю условия <Link href="/terms">Пользовательского соглашения</Link>.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <aside className={styles.addTrackFormAside}>
            <div className={styles.addTrackCoverPanel}>
              <p className={`${styles.addTrackLabel} flora-type-15`}>
                Обложка
              </p>
              <button
                type="button"
                className={styles.addTrackCoverUploadBtn}
                onClick={openCoverPicker}
                aria-label="Загрузить обложку"
              >
                {coverImage ? (
                  <img src={coverImage} alt="Обложка" className={styles.addTrackCoverUploadImg} />
                ) : (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                )}
              </button>
              <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                className={styles.addTrackFileInput}
                onChange={handleCoverChange}
                aria-hidden
              />
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
                  disabled={uploading || artistCredits.length === 0 || !genre.trim() || !agreedChecked}
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
            Трек опубликован на площадке.
          </p>
        ) : null}
      </form>
    </div>
  );
}
