import type { Metadata } from "next";
import { GridOverlay } from "@/app/_shared/GridOverlay";
import { PublicSiteHeader, publicSiteStyles as site } from "@/app/_shared/PublicSiteHeader";
import { FLORA_APK_CHANNEL_RELEASES_URL } from "@/lib/apkChannel";
import { fetchFloraApkChannelReleases } from "@/lib/fetchApkChannelReleases";
import { FLORA_TITLE_SEPARATOR, floraPageMetadata } from "@/lib/floraDocumentTitle";
import styles from "./download.module.css";

export const metadata: Metadata = {
  ...floraPageMetadata("Скачать"),
  description: `Скачать Flora Social для Android${FLORA_TITLE_SEPARATOR}официальный APK с канала Flora.`,
};

function formatSizeMb(sizeBytes: number): string {
  const mb = sizeBytes / (1024 * 1024);
  if (!Number.isFinite(mb) || mb <= 0) return "";
  const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `~${rounded} МБ`;
}

function formatPublishedAt(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

function AndroidIcon() {
  return (
    <svg className={styles.ctaIcon} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.6 9.48 19.44 6.3a.55.55 0 0 0-.95-.55l-1.88 3.26A11.3 11.3 0 0 0 12 8.4c-1.64 0-3.18.37-4.61 1.01L5.51 5.75a.55.55 0 1 0-.95.55L6.4 9.48C3.94 11.02 2.4 13.5 2.4 16.4v.4c0 .66.54 1.2 1.2 1.2h16.8c.66 0 1.2-.54 1.2-1.2v-.4c0-2.9-1.54-5.38-4-6.92ZM8.1 14.2a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Zm7.8 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
    </svg>
  );
}

export default async function DownloadPage() {
  const releases = await fetchFloraApkChannelReleases();
  const latest = releases[0] ?? null;
  const older = releases.slice(1);
  const latestSize = latest ? formatSizeMb(latest.sizeBytes) : "";
  const latestDate = latest ? formatPublishedAt(latest.publishedAt) : "";

  return (
    <div className={site.page}>
      <GridOverlay />
      <PublicSiteHeader />

      <main className={site.main}>
        <div className={styles.hero}>
          <h1 className={styles.title}>Скачать Flora Social</h1>
          <p className={styles.intro}>
            Официальный релиз от Flora.
          </p>
        </div>

        {latest ? (
          <section className={styles.primary} aria-label="Скачать для Android">
            <a className={styles.cta} href={latest.apkUrl} rel="noopener noreferrer">
              <AndroidIcon />
              Скачать для Android
            </a>
            <p className={styles.meta}>
              Версия {latest.version}
              {latestDate ? ` · ${latestDate}` : ""}
              {latestSize ? ` · ${latestSize}` : ""}
            </p>
          </section>
        ) : (
          <p className={styles.empty}>
            Канал временно недоступен. Каталог релизов:{" "}
            <a href={FLORA_APK_CHANNEL_RELEASES_URL} rel="noopener noreferrer">
              releases.json
            </a>
            .
          </p>
        )}

        {older.length > 0 ? (
          <section aria-labelledby="other-versions-heading">
            <h2 id="other-versions-heading" className={styles.sectionTitle}>
              Другие версии
            </h2>
            <ul className={styles.list}>
              {older.map((release) => {
                const size = formatSizeMb(release.sizeBytes);
                const date = formatPublishedAt(release.publishedAt);
                return (
                  <li key={release.version} className={styles.row}>
                    <div className={styles.rowMain}>
                      <span className={styles.version}>{release.version}</span>
                      <span className={styles.rowMeta}>
                        {[date, size].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <a className={styles.rowLink} href={release.apkUrl} rel="noopener noreferrer">
                      Скачать
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
