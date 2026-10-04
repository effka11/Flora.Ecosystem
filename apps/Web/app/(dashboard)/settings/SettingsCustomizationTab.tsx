"use client";

import { useSettings } from "./SettingsContext";
import styles from "./settings.module.css";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        className={styles.toggleInput}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className={styles.toggleTrack}>
        <div className={styles.toggleThumb} />
      </div>
    </label>
  );
}

export function SettingsCustomizationTab() {
  const { draft, updateCustomization, clearSaveFeedback } = useSettings();
  const { customization } = draft;
  const { theme, animSpeed, enableAnimations, enableBlur } = customization;

  const patch = (next: Partial<typeof customization>) => {
    clearSaveFeedback();
    updateCustomization(next);
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Тема оформления</h3>
        <div className={styles.cardsGrid}>
          <button
            type="button"
            className={`${styles.previewCard} ${theme === "dark" ? styles.previewCardActive : ""}`}
            onClick={() => patch({ theme: "dark" })}
          >
            <div
              className={styles.themePreviewBox}
              style={{
                background: "#0c0c0c",
                borderColor: "rgba(250,250,250,0.08)",
              }}
            >
              <div className={styles.themePreviewSidebar} style={{ background: "#111210", borderColor: "rgba(250,250,250,0.08)" }}>
                <div className={styles.themePreviewLine} style={{ background: "rgba(250,250,250,0.1)" }} />
                <div className={styles.themePreviewLine} style={{ background: "rgba(250,250,250,0.1)", width: "60%" }} />
              </div>
              <div className={styles.themePreviewMain}>
                <div className={styles.themePreviewBubble} style={{ background: "#1c1d1b" }} />
                <div className={`${styles.themePreviewBubble} ${styles.themePreviewBubbleRight}`} style={{ background: "var(--flora-green-dark)" }} />
                <div className={styles.themePreviewBubble} style={{ background: "#1c1d1b", width: "40%" }} />
              </div>
            </div>
            <div>
              <p className={styles.previewCardTitle}>Тёмная (Flora)</p>
              <p className={styles.previewCardDesc}>Классическая тёмная тема</p>
            </div>
          </button>

          <button
            type="button"
            className={`${styles.previewCard} ${theme === "light" ? styles.previewCardActive : ""}`}
            onClick={() => patch({ theme: "light" })}
          >
            <div
              className={styles.themePreviewBox}
              style={{
                background: "#f7f7f7",
                borderColor: "rgba(0,0,0,0.1)",
              }}
            >
              <div className={styles.themePreviewSidebar} style={{ background: "#ffffff", borderColor: "rgba(0,0,0,0.1)" }}>
                <div className={styles.themePreviewLine} style={{ background: "rgba(0,0,0,0.1)" }} />
                <div className={styles.themePreviewLine} style={{ background: "rgba(0,0,0,0.1)", width: "60%" }} />
              </div>
              <div className={styles.themePreviewMain}>
                <div className={styles.themePreviewBubble} style={{ background: "#e0e0e0" }} />
                <div className={`${styles.themePreviewBubble} ${styles.themePreviewBubbleRight}`} style={{ background: "#a4d18a" }} />
                <div className={styles.themePreviewBubble} style={{ background: "#e0e0e0", width: "40%" }} />
              </div>
            </div>
            <div>
              <p className={styles.previewCardTitle}>Светлая</p>
              <p className={styles.previewCardDesc}>Высокий контраст</p>
            </div>
          </button>

          <button
            type="button"
            className={`${styles.previewCard} ${theme === "midnight" ? styles.previewCardActive : ""}`}
            onClick={() => patch({ theme: "midnight" })}
          >
            <div
              className={styles.themePreviewBox}
              style={{
                background: "#050510",
                borderColor: "rgba(138, 159, 209, 0.15)",
              }}
            >
              <div className={styles.themePreviewSidebar} style={{ background: "#0a0a1a", borderColor: "rgba(138, 159, 209, 0.15)" }}>
                <div className={styles.themePreviewLine} style={{ background: "rgba(138, 159, 209, 0.2)" }} />
                <div className={styles.themePreviewLine} style={{ background: "rgba(138, 159, 209, 0.2)", width: "60%" }} />
              </div>
              <div className={styles.themePreviewMain}>
                <div className={styles.themePreviewBubble} style={{ background: "#15152a" }} />
                <div className={`${styles.themePreviewBubble} ${styles.themePreviewBubbleRight}`} style={{ background: "#4a5b8e" }} />
                <div className={styles.themePreviewBubble} style={{ background: "#15152a", width: "40%" }} />
              </div>
            </div>
            <div>
              <p className={styles.previewCardTitle}>Полуночная</p>
              <p className={styles.previewCardDesc}>Глубокие синие оттенки</p>
            </div>
          </button>

          <button
            type="button"
            className={`${styles.previewCard} ${theme === "system" ? styles.previewCardActive : ""}`}
            onClick={() => patch({ theme: "system" })}
          >
            <div
              className={styles.themePreviewBox}
              style={{
                background: "linear-gradient(135deg, #f7f7f7 50%, #0c0c0c 50%)",
                borderColor: "rgba(128,128,128,0.2)",
              }}
            >
              <div className={styles.themePreviewSidebar} style={{ background: "transparent", borderColor: "transparent" }}>
                <div className={styles.themePreviewLine} style={{ background: "rgba(128,128,128,0.3)" }} />
                <div className={styles.themePreviewLine} style={{ background: "rgba(128,128,128,0.3)", width: "60%" }} />
              </div>
            </div>
            <div>
              <p className={styles.previewCardTitle}>Системная</p>
              <p className={styles.previewCardDesc}>Синхронизация с ОС</p>
            </div>
          </button>
        </div>
      </div>

      <div className={styles.formSection}>
        <div className={styles.formSectionHeader}>
          <h3 className={styles.formSectionTitle}>Анимации и эффекты</h3>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--flora-grid-step)" }}>
            <span className={styles.label} style={{ height: "auto", padding: 0 }}>
              Включить анимации
            </span>
            <Toggle checked={enableAnimations} onChange={(next) => patch({ enableAnimations: next })} />
          </div>
        </div>

        {enableAnimations ? (
          <div className={styles.cardsGrid}>
            <button
              type="button"
              className={`${styles.previewCard} ${animSpeed === "smooth" ? styles.previewCardActive : ""}`}
              onClick={() => patch({ animSpeed: "smooth" })}
            >
              <div className={styles.animPreviewBox}>
                <div className={`${styles.animDot} ${styles.animSmooth}`} />
              </div>
              <div>
                <p className={styles.previewCardTitle}>Плавные</p>
                <p className={styles.previewCardDesc}>Мягкие и естественные переходы</p>
              </div>
            </button>

            <button
              type="button"
              className={`${styles.previewCard} ${animSpeed === "fast" ? styles.previewCardActive : ""}`}
              onClick={() => patch({ animSpeed: "fast" })}
            >
              <div className={styles.animPreviewBox}>
                <div className={`${styles.animDot} ${styles.animFast}`} />
              </div>
              <div>
                <p className={styles.previewCardTitle}>Динамичные</p>
                <p className={styles.previewCardDesc}>Быстрые и резкие анимации</p>
              </div>
            </button>

            <button
              type="button"
              className={`${styles.previewCard} ${animSpeed === "reduced" ? styles.previewCardActive : ""}`}
              onClick={() => patch({ animSpeed: "reduced" })}
            >
              <div className={styles.animPreviewBox}>
                <div className={`${styles.animDot} ${styles.animReduced}`} />
              </div>
              <div>
                <p className={styles.previewCardTitle}>Минимальные</p>
                <p className={styles.previewCardDesc}>Только необходимые эффекты (fade)</p>
              </div>
            </button>
          </div>
        ) : null}

        <div className={styles.listCard} style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Размытие фона (Blur)</p>
            <p className={styles.listCardDesc}>Эффект матового стекла под меню и шапками</p>
          </div>
          <Toggle checked={enableBlur} onChange={(next) => patch({ enableBlur: next })} />
        </div>
      </div>
    </div>
  );
}
