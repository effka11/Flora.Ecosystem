"use client";

import { useFloraTheme } from "@/app/_shared/FloraThemeProvider";
import {
  WEB_FLORA_THEME_IDS,
  WEB_FLORA_THEMES,
  type WebFloraThemeId,
} from "@/lib/floraTheme";
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
  const { previewTheme } = useFloraTheme();
  const { customization } = draft;
  const { theme, animSpeed, enableAnimations, enableBlur } = customization;

  const patch = (next: Partial<typeof customization>) => {
    clearSaveFeedback();
    updateCustomization(next);
  };

  const selectTheme = (next: WebFloraThemeId) => {
    patch({ theme: next });
    previewTheme(next);
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Тема оформления</h3>
        <div className={styles.cardsGrid}>
          {WEB_FLORA_THEME_IDS.map((themeId) => {
            const meta = WEB_FLORA_THEMES[themeId];
            return (
              <button
                key={themeId}
                type="button"
                className={`${styles.previewCard} ${theme === themeId ? styles.previewCardActive : ""}`}
                onClick={() => selectTheme(themeId)}
              >
                <div className={`${styles.themePreviewBox} ${meta.previewClassName}`}>
                  <div
                    className={styles.themePreviewSidebar}
                    style={{
                      background: "var(--flora-reserve-surface-them)",
                      borderColor: "rgba(var(--flora-white-template-rgb), 0.08)",
                    }}
                  >
                    <div
                      className={styles.themePreviewLine}
                      style={{ background: "rgba(var(--flora-white-template-rgb), 0.1)" }}
                    />
                    <div
                      className={styles.themePreviewLine}
                      style={{
                        background: "rgba(var(--flora-white-template-rgb), 0.1)",
                        width: "60%",
                      }}
                    />
                  </div>
                  <div className={styles.themePreviewMain}>
                    <div
                      className={styles.themePreviewBubble}
                      style={{ background: "var(--flora-reserve-substrate-gray-muted)" }}
                    />
                    <div
                      className={`${styles.themePreviewBubble} ${styles.themePreviewBubbleRight}`}
                      style={{ background: "var(--flora-accent-dark)" }}
                    />
                    <div
                      className={styles.themePreviewBubble}
                      style={{
                        background: "var(--flora-reserve-substrate-gray-muted)",
                        width: "40%",
                      }}
                    />
                  </div>
                </div>
                <div>
                  <p className={styles.previewCardTitle}>{meta.label}</p>
                  <p className={styles.previewCardDesc}>{meta.description}</p>
                </div>
              </button>
            );
          })}
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
