import { FLORA_THEME_TOKENS } from "@flora/client-core/display";

const t = FLORA_THEME_TOKENS;

/** Палитра Flora — синхронизирована с Apps/Web/app/globals.css через client-core. */
export const floraColors = {
  bg: t.bg,
  surface: t.reserveHoverSurface,
  surfaceElevated: t.reserveSurfaceThem,
  text: t.whiteTemplate,
  textMuted: t.gray,
  accent: t.greenLight,
  accentDark: t.greenDark,
  like: t.like,
  border: t.grayDivider,
  error: t.like,
  whiteTemplate: t.whiteTemplate,
  gray: t.gray,
  grayLight: t.whiteTemplate,
  greenLight: t.greenLight,
  greenDark: t.greenDark,
  greenBubble: t.greenBubble,
  popoverRail: t.reserveSubstrateGrayMuted,
  popoverInset: t.reservePopoverInset,
  popoverDivider: t.reservePopoverDivider,
  textOnBubble: t.textOnBubble,
};

export const floraAuthTypography = {
  light: "300" as const,
  letterWide: 1.8,
  letterLogo: 3,
  letterButton: 1.6,
  letterLink: 1.8,
  sizeBody: 15,
  sizeLogo: 40,
};

export const floraSpacing = {
  grid: 15,
  gridFine: 5,
};

/** Триггеры фильтров (сообщения, уведомления) — совпадают с tabButton в ленте. */
export const floraTabFilter = {
  triggerHeight: 35,
  triggerLabelLineHeight: 15,
  indicatorHeight: 2,
  /** Зазор между текстом и верхом подчёркивания. */
  labelGapAboveIndicator: (35 - 15) / 2 - 2,
  /** Такой же зазор под подчёркиванием до меню. */
  menuGapBelow: (35 - 15) / 2 - 2,
};

/** Карточка поста в ленте — feedPostList.module.css / feed.module.css */
export const floraFeedPost = {
  avatarSize: 3 * floraSpacing.grid,
  paddingTop: 2 * floraSpacing.grid,
  paddingBottom: 2 * floraSpacing.grid + 2,
  columnGap: floraSpacing.grid + floraSpacing.gridFine,
  headerPaddingTop: 2 * floraSpacing.gridFine,
  nicknameLineHeight: 15,
  nicknameNudgeY: -floraSpacing.gridFine,
  rowGap: floraSpacing.gridFine,
  moreMenuTop: -floraSpacing.grid / 2 + 1,
  contentNudgeX: -floraSpacing.gridFine,
  g20: 4 * floraSpacing.gridFine,
  actionGap: 4 * floraSpacing.gridFine,
  actionIconGap: floraSpacing.gridFine,
  actionsBarMarginTop: 4 * floraSpacing.gridFine,
  textMarginBottom: floraSpacing.grid,
  actionFontSize: 14,
  actionLetterSpacing: 0.42,
  moreBtnSize: 2 * floraSpacing.gridFine + 18,
  moreBtnPadding: floraSpacing.gridFine,
  moreBtnNudgeY: floraSpacing.gridFine + 3,
  /** Слот глифа ⋮/✕ — PostMoreMenu.triggerGlyphStack (18px). */
  moreGlyphSlot: 18,
  moreGlyphSize: 18,
  /** Тот же слот 18px; крестик = размер ⋮ для визуального паритета. */
  moreCloseGlyphSize: 18,
  /** Отступ панели ниже ⋮: web gap + 1 primary step (визуальный зазор под крестиком). */
  moreMenuGapBelow: floraSpacing.grid * 2 + floraSpacing.gridFine + 3,
};

/** Высота контента нижнего tab bar (UIKit default в React Navigation). */
export const floraTabBarHeight = 49;

/** Единый стиль tab bar — использовать и при восстановлении после скрытия в чате. */
export function floraTabBarStyle(bottomInset: number) {
  return {
    backgroundColor: floraColors.surface,
    borderTopColor: floraColors.border,
    paddingBottom: bottomInset,
    height: floraTabBarHeight + bottomInset,
  };
}

/** Скрытый tab bar: не схлопываем высоту (нет белой вспышки), убираем из потока через absolute. */
export function floraTabBarHiddenStyle(bottomInset: number) {
  return {
    backgroundColor: floraColors.bg,
    borderTopWidth: 0,
    height: floraTabBarHeight + bottomInset,
    minHeight: floraTabBarHeight + bottomInset,
    paddingBottom: bottomInset,
    opacity: 0,
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none" as const,
    elevation: 0,
  };
}

/** Опции native stack — тёмный фон карточки, без белой полосы при переходе. */
export const floraNativeStackOptions = {
  headerStyle: { backgroundColor: floraColors.surface },
  headerTintColor: floraColors.text,
  contentStyle: { backgroundColor: floraColors.bg },
  animation: "fade" as const,
  animationDuration: 180,
  gestureEnabled: true,
  fullScreenGestureEnabled: true,
};

/** Карточка профиля — profile.module.css / ProfileCardStatus */
export const floraProfile = {
  coverHeight: 7 * floraSpacing.grid,
  avatarSize: 98,
  statusFontSize: 15,
  statusLineHeight: 31.5,
  statusStripe: "rgba(250, 250, 250, 0.08)",
};

export const floraMotion = {
  baseMs: 150,
};

/** Чат — messages.module.css / messagesChatView */
export const floraMessages = {
  headerHeight: 8 * floraSpacing.grid,
  headerAvatarSize: 3 * floraSpacing.grid,
  peerBubbleAvatarSize: 3 * floraSpacing.grid,
  bubbleRadius: 18,
  bubbleTailRadius: 6,
  bubbleMaxWidthRatio: 0.78,
  /** Вертикальный зазор между строками сообщений в ленте (и до линии compose у последнего). */
  bubbleRowGap: floraSpacing.grid,
  bubbleGap: 2 * floraSpacing.grid,
  bubblePadding: floraSpacing.grid,
  bubbleFontSize: 15,
  bubbleLineHeight: 22,
  bubbleTimeFontSize: 12,
  /** Пузырь с фото — 20 кл. первичной сетки (messages.module.css). */
  photoBubbleWidth: 20 * floraSpacing.grid,
  /** Коллаж в сообщении — 5 кл. на строку (messagesImageCollage). */
  messageCollageRowHeight: 5 * floraSpacing.grid,
  /** Одно фото в пузыре — max-height 24 кл. */
  messageSingleImageMaxHeight: 24 * floraSpacing.grid,
  voicePlayBtnSize: 2 * floraSpacing.grid,
  /** Голосовое-only — 25 кл. первичной сетки (messagesBubbleVoiceOnly на вебе). */
  voiceBubbleWidth: 25 * floraSpacing.grid,
  composeRadius: 12,
  composeBorderColor: floraColors.greenDark,
  /** Как TabScreenSearchHeader.searchBox — minHeight 45. */
  composeFieldMinHeight: 45,
  composeFieldGap: 10,
  composeChromeBtn: 28,
  /** Внешние отступы оболочки поля ввода (над полем и под safe area). */
  composeShellPaddingTop: floraSpacing.grid,
  /** Зазор над pill при закрытой клавиатуре (поверх safe area). */
  composeShellPaddingBottomExtra: floraSpacing.grid,
  /** Зазор между pill и клавиатурой/панелью = верхнему зазору (composeShellPaddingTop) для симметрии. */
  composeShellPaddingKeyboard: floraSpacing.grid,
  composeFieldPaddingHorizontal: 14,
  composeFieldPaddingVertical: 0,
  /** Панель эмодзи в доке — как messagesStickerPanel на вебе. */
  emojiPanelRadius: 12,
  emojiPanelOuterGap: floraSpacing.gridFine,
  emojiPanelBottomExtra: floraSpacing.grid,
  themBubbleBg: t.messagesBubbleThemBg,
  themBubbleText: t.messagesBubbleThemText,
  themBubbleTime: t.messagesBubbleThemTime,
  divider: t.reservePopoverDivider,
};
