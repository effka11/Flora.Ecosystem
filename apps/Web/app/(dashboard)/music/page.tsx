"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TabSearchInput } from "@/app/_shared/TabSearchInput";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { GenresCarousel } from "@/app/(dashboard)/music/GenresCarousel";
import { AddTrackTab } from "@/app/(dashboard)/music/AddTrackTab";
import { MyMusicTab } from "@/app/(dashboard)/music/MyMusicTab";
import { MusicSearchResults } from "@/app/(dashboard)/music/MusicSearchResults";
import { MusicFlowPlayer } from "@/app/(dashboard)/music/MusicFlowPlayer";
import { musicLibraryCache, musicPlaylistsCache } from "@/lib/dashboardPreload";
import styles from "./music.module.css";

type MusicBrowseTab = "recommendations" | "myMusic";
type MusicUploadTab = "forSelf" | "forPlatform";
type MusicTab = MusicBrowseTab | "addTrack";

type MusicTabIndicatorStyle = CSSProperties &
  Record<"--music-tab-indicator-left" | "--music-tab-indicator-width", string>;

type MusicTabPanelTransition = null | "fromLeft" | "fromRight" | "fade";

/** Как на главной: сброс класса анимации после duration-6 + 20ms. */
const MUSIC_TAB_TRANSITION_CLEAR_MS = 950;

function musicTabIndex(tab: MusicTab, uploadTab: MusicUploadTab): number {
  if (tab === "recommendations") return 0;
  if (tab === "myMusic") return 1;
  return uploadTab === "forSelf" ? 2 : 3;
}

export default function MusicPage() {
  const { isClient, hasToken } = useProtectedPage();
  const [searchValue, setSearchValue] = useState("");
  const [activeTab, setActiveTab] = useState<MusicTab>("recommendations");
  const [uploadTab, setUploadTab] = useState<MusicUploadTab>("forSelf");
  const [lastBrowseTab, setLastBrowseTab] = useState<MusicBrowseTab>("recommendations");
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);

  const recommendationsTabRef = useRef<HTMLButtonElement>(null);
  const myMusicTabRef = useRef<HTMLButtonElement>(null);
  const uploadForSelfTabRef = useRef<HTMLButtonElement>(null);
  const uploadForPlatformTabRef = useRef<HTMLButtonElement>(null);
  const musicTabsRowRef = useRef<HTMLDivElement>(null);
  const isAddTrackMode = activeTab === "addTrack";
  const [indicatorVars, setIndicatorVars] = useState<MusicTabIndicatorStyle>({
    "--music-tab-indicator-left": "0px",
    "--music-tab-indicator-width": "0px",
  });
  const [indicatorMotionEnabled, setIndicatorMotionEnabled] = useState(false);
  const indicatorMotionPrimedRef = useRef(false);
  const [panelTransition, setPanelTransition] = useState<MusicTabPanelTransition>(null);
  /** Меняется при каждом переключении — remount панели, чтобы CSS-анимация срабатывала при быстрых кликах. */
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const panelTransitionClearRef = useRef<number | null>(null);

  const applyPanelTransition = useCallback((prevIdx: number, nextIdx: number) => {
    if (panelTransitionClearRef.current !== null) {
      window.clearTimeout(panelTransitionClearRef.current);
      panelTransitionClearRef.current = null;
    }

    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduced && prevIdx !== nextIdx) {
      const involvesAddTrack =
        (prevIdx >= 2 && nextIdx < 2) || (prevIdx < 2 && nextIdx >= 2);
      setPanelAnimEpoch((epoch) => epoch + 1);
      setPanelTransition(
        involvesAddTrack ? "fade" : nextIdx > prevIdx ? "fromRight" : "fromLeft",
      );
      panelTransitionClearRef.current = window.setTimeout(() => {
        setPanelTransition(null);
        panelTransitionClearRef.current = null;
      }, MUSIC_TAB_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }
  }, []);

  const switchMusicTab = useCallback(
    (next: MusicTab) => {
      if (next === activeTab) return;

      const prevIdx = musicTabIndex(activeTab, uploadTab);
      const nextIdx = musicTabIndex(next, uploadTab);
      applyPanelTransition(prevIdx, nextIdx);

      if (next !== "addTrack" && activeTab !== "addTrack") {
        setLastBrowseTab(next);
      }
      if (next === "addTrack") {
        if (activeTab !== "addTrack") {
          setLastBrowseTab(activeTab === "myMusic" ? "myMusic" : "recommendations");
        }
        setUploadTab("forSelf");
      }

      setActiveTab(next);
    },
    [activeTab, applyPanelTransition, uploadTab],
  );

  const switchUploadTab = useCallback(
    (next: MusicUploadTab) => {
      if (!isAddTrackMode || next === uploadTab) return;

      const prevIdx = musicTabIndex("addTrack", uploadTab);
      const nextIdx = musicTabIndex("addTrack", next);
      applyPanelTransition(prevIdx, nextIdx);
      setUploadTab(next);
    },
    [applyPanelTransition, isAddTrackMode, uploadTab],
  );

  const exitAddTrack = useCallback(() => {
    switchMusicTab(lastBrowseTab);
  }, [lastBrowseTab, switchMusicTab]);

  useEffect(
    () => () => {
      if (panelTransitionClearRef.current !== null) window.clearTimeout(panelTransitionClearRef.current);
    },
    [],
  );

  const hasSearch = searchValue.trim().length >= 1;

  const handleTrackUploaded = useCallback(() => {
    setLibraryRefreshKey((key) => key + 1);
    setActiveTab("myMusic");
    setLastBrowseTab("myMusic");
  }, []);

  const handlePlatformTrackDeleted = useCallback(() => {
    setLibraryRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    musicLibraryCache.prefetch();
    musicPlaylistsCache.prefetch();
  }, [hasToken, isClient]);

  useEffect(() => {
    if (hasSearch) {
      indicatorMotionPrimedRef.current = false;
      const timer = window.setTimeout(() => setIndicatorMotionEnabled(false), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [hasSearch]);

  useEffect(() => {
    if (hasSearch) return;

    const syncIndicator = () => {
      const row = musicTabsRowRef.current;
      const target = isAddTrackMode
        ? uploadTab === "forSelf"
          ? uploadForSelfTabRef.current
          : uploadForPlatformTabRef.current
        : activeTab === "recommendations"
          ? recommendationsTabRef.current
          : myMusicTabRef.current;
      if (!row || !target) return;
      const rowRect = row.getBoundingClientRect();
      const tabRect = target.getBoundingClientRect();
      const left = tabRect.left - rowRect.left;
      const tabW = tabRect.width;
      if (tabW <= 0) return;
      setIndicatorVars({
        "--music-tab-indicator-left": `${left}px`,
        "--music-tab-indicator-width": `${tabW}px`,
      });
      if (!indicatorMotionPrimedRef.current) {
        indicatorMotionPrimedRef.current = true;
        requestAnimationFrame(() => setIndicatorMotionEnabled(true));
      }
    };

    syncIndicator();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncIndicator) : null;
    if (ro && musicTabsRowRef.current) ro.observe(musicTabsRowRef.current);
    window.addEventListener("resize", syncIndicator);
    return () => {
      window.removeEventListener("resize", syncIndicator);
      ro?.disconnect();
    };
  }, [activeTab, hasSearch, isAddTrackMode, uploadTab]);

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return (
      <section className={styles.page}>
        <div className={styles.musicScroll} id="central-scroll-music">
          <div className={styles.musicTopBlock}>
            <div className={styles.musicTopInner}>
              {isAddTrackMode ? (
                <>
                  <div className={styles.musicAddLabelRow}>
                    <button
                      type="button"
                      id="music-exit-label"
                      className={`${styles.musicAddTextBtn} flora-type-15`}
                      onClick={exitAddTrack}
                    >
                      Выйти
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.musicAddBtn}
                    aria-labelledby="music-exit-label"
                    onClick={exitAddTrack}
                  >
                    <svg className={styles.musicAddBtnIcon} viewBox="0 0 24 24" fill="none" overflow="visible" aria-hidden>
                      <path
                        d="M7.5 7.5l9 9M16.5 7.5l-9 9"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </>
              ) : (
                <>
                  <div className={styles.musicAddLabelRow}>
                    <button
                      type="button"
                      id="music-add-track-label"
                      className={`${styles.musicAddTextBtn} flora-type-15`}
                      onClick={() => switchMusicTab("addTrack")}
                    >
                      Добавить трек
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.musicAddBtn}
                    aria-labelledby="music-add-track-label"
                    onClick={() => switchMusicTab("addTrack")}
                  >
                    <svg className={styles.musicAddBtnIcon} viewBox="0 0 24 24" fill="none" overflow="visible" aria-hidden>
                      <path
                        d="M12 7.5v9M7.5 12h9"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </>
              )}
              <div className={styles.musicSearchHeader}>
                <TabSearchInput
                  placeholder="Поиск по музыке"
                  value={searchValue}
                  onChange={setSearchValue}
                  classNames={{
                    wrap: styles.musicSearchWrap,
                    box: styles.musicSearchBox,
                    icon: styles.musicSearchIcon,
                    input: styles.musicSearchInput,
                    actionButton: styles.musicSearchSendBtn,
                    actionButtonShown: styles.musicSearchSendBtnShown,
                    actionButtonHidden: styles.musicSearchSendBtnHidden
                  }}
                />
              </div>

              {!hasSearch ? (
                <div className={styles.musicFiltersBlock}>
                  <div className={styles.musicTabsWrap}>
                    <div ref={musicTabsRowRef} className={styles.musicTabs}>
                      {isAddTrackMode ? (
                        <>
                          <button
                            ref={uploadForSelfTabRef}
                            type="button"
                            className={`${styles.musicTab} flora-type-15 ${uploadTab === "forSelf" ? styles.musicTabActive : ""}`}
                            onClick={() => switchUploadTab("forSelf")}
                          >
                            <span className={styles.musicTabLabel}>Загрузить для себя</span>
                          </button>
                          <button
                            ref={uploadForPlatformTabRef}
                            type="button"
                            className={`${styles.musicTab} flora-type-15 ${uploadTab === "forPlatform" ? styles.musicTabActive : ""}`}
                            onClick={() => switchUploadTab("forPlatform")}
                          >
                            <span className={styles.musicTabLabel}>Загрузить на площадку</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            ref={recommendationsTabRef}
                            type="button"
                            className={`${styles.musicTab} flora-type-15 ${activeTab === "recommendations" ? styles.musicTabActive : ""}`}
                            onClick={() => switchMusicTab("recommendations")}
                          >
                            <span className={styles.musicTabLabel}>Рекомендации</span>
                          </button>
                          <button
                            ref={myMusicTabRef}
                            type="button"
                            className={`${styles.musicTab} flora-type-15 ${activeTab === "myMusic" ? styles.musicTabActive : ""}`}
                            onClick={() => switchMusicTab("myMusic")}
                          >
                            <span className={styles.musicTabLabel}>Моя музыка</span>
                          </button>
                        </>
                      )}
                    </div>
                    <div
                      className={`${styles.musicTabIndicator} ${!indicatorMotionEnabled ? styles.musicTabIndicatorStatic : ""}`}
                      style={indicatorVars}
                      aria-hidden
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.musicTabPanel}>
            <div
              key={`${activeTab}-${uploadTab}-${panelAnimEpoch}`}
              className={`${styles.musicTabPanelInner} ${
                panelTransition === "fade"
                  ? styles.musicTabPanelInnerFade
                  : panelTransition === "fromLeft"
                    ? styles.musicTabPanelInnerFromLeft
                    : panelTransition === "fromRight"
                      ? styles.musicTabPanelInnerFromRight
                      : ""
              }`}
            >
              {hasSearch ? (
                <MusicSearchResults query={searchValue} />
              ) : activeTab === "addTrack" ? (
                <AddTrackTab uploadMode={uploadTab} onUploaded={handleTrackUploaded} />
              ) : activeTab === "myMusic" ? (
                <MyMusicTab
                  refreshKey={libraryRefreshKey}
                  onPlatformTrackDeleted={handlePlatformTrackDeleted}
                />
              ) : (
                <div className={styles.recommendationsWrap}>
                  <MusicFlowPlayer />
                  <hr className={styles.recommendationsDivider} aria-hidden />
                  <GenresCarousel />
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
  );
}
