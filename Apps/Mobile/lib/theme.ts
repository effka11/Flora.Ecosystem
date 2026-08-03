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
  /**
   * Верх аватара → верх ника = 1×fine (web: header padding 2×fine + author top −1×fine).
   * На мобайле задаём напрямую, без промежуточного nudge.
   */
  nicknameGapFromAvatarTop: floraSpacing.gridFine,
  nicknameLineHeight: 15,
  rowGap: floraSpacing.gridFine,
  /**
   * Верх слота ⋮: старый top (−grid/2+1) минус половина прироста слота 28→45,
   * чтобы центр глифа остался на горизонтали ника.
   */
  moreMenuTop: -floraSpacing.grid / 2 + 1 - (45 - (2 * floraSpacing.gridFine + 18)) / 2,
  contentNudgeX: -floraSpacing.gridFine,
  /**
   * Низ аватара → верх наполнения (текст/фото) = 1×fine
   * (web: row-gap + postBody −1×fine + images/text +1×fine → net 1×fine).
   */
  bodyMarginTop: floraSpacing.gridFine,
  textFontSize: 15,
  textLineHeight: 25.5,
  /**
   * Срез half-leading первой строки (паритет с верхом фото / web text-box-trim).
   * Иначе caps текста визуально ниже края фото на ~(lh − size) / 2.
   */
  textCapTrim: -((25.5 - 15) / 2),
  g20: 4 * floraSpacing.gridFine,
  actionGap: 4 * floraSpacing.gridFine,
  actionIconGap: floraSpacing.gridFine,
  actionsBarMarginTop: 4 * floraSpacing.gridFine,
  textMarginBottom: floraSpacing.grid,
  actionFontSize: 14,
  actionLetterSpacing: 0.42,
  /** Как iconButton / ⋮ в Messages — центр на одной вертикали с «+»/шапкой чата. */
  moreBtnSize: 45,
  moreBtnPadding: 0,
  /** Сдвиг по Y к горизонтали ника (как до выравнивания слота). */
  moreBtnNudgeY: floraSpacing.gridFine + 3,
  /** Глиф как ChatHeaderMoreIcon. */
  moreGlyphSlot: 24,
  moreGlyphSize: 24,
  moreCloseGlyphSize: 24,
  /** Отступ панели ниже ⋮: web gap + 1 primary step (визуальный зазор под крестиком). */
  moreMenuGapBelow: floraSpacing.grid * 2 + floraSpacing.gridFine + 3,
};

/** Высота зоны иконок нижнего tab bar. */
export const floraTabBarHeight = 49;

/** Отступ от верхней линии до иконок. */
export const floraTabBarTopPad = floraSpacing.gridFine * 2;

/** Полная высота контента tab bar без safe-area. */
export function floraTabBarContentHeight() {
  return floraTabBarHeight + floraTabBarTopPad;
}

/** Нижний отступ списков, чтобы контент не прятался под absolute tab bar. */
export function floraTabBarContentPadding(bottomInset: number) {
  return floraTabBarContentHeight() + bottomInset + floraSpacing.grid;
}

/** Единый стиль tab bar — чёрный фон, absolute. */
export function floraTabBarStyle(bottomInset: number) {
  return {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "transparent",
    borderTopWidth: 0,
    elevation: 0,
    paddingTop: floraTabBarTopPad,
    paddingBottom: bottomInset,
    height: floraTabBarContentHeight() + bottomInset,
  };
}

/** Скрытый tab bar: не схлопываем высоту (нет белой вспышки), убираем из потока через absolute. */
export function floraTabBarHiddenStyle(bottomInset: number) {
  return {
    backgroundColor: "transparent",
    borderTopWidth: 0,
    height: floraTabBarContentHeight() + bottomInset,
    minHeight: floraTabBarContentHeight() + bottomInset,
    paddingTop: floraTabBarTopPad,
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
  /** dashboardShell — var(--flora-duration-6). */
  tabTransitionDurationMs: 900,
  /** dashboardShell — animation-delay 0.02s. */
  tabTransitionDelayMs: 20,
};

const COMPOSE_FIELD_MIN_HEIGHT = 45;
const COMPOSE_FIELD_BORDER_WIDTH = 1;
const COMPOSE_INPUT_LINE_HEIGHT = 22;
const COMPOSE_CHROME_BTN = 28;
/**
 * Кнопки прижаты к низу pill (паритет `.messagesComposeRow { align-items:
 * flex-end }`), иначе на многострочном поле они всплывают к его середине — и
 * едут туда прямо во время анимации роста. Отступ равен тому, что давало
 * центрирование однострочника, поэтому на одной строке вид не меняется.
 */
const COMPOSE_CHROME_BTN_BOTTOM_INSET =
  (COMPOSE_FIELD_MIN_HEIGHT - 2 * COMPOSE_FIELD_BORDER_WIDTH - COMPOSE_CHROME_BTN) / 2;
/**
 * Зазор «текст ↔ край pill» — остаток однострочника пополам:
 * 45 = 1 + 10.5 + 22 + 10.5 + 1. Живёт на самом TextInput, а не на pill:
 * padding на строке поля добавился бы и к кнопкам 28px и поднял бы минимум
 * pill с 45 до 51.
 */
const COMPOSE_INPUT_PADDING_VERTICAL =
  (COMPOSE_FIELD_MIN_HEIGHT - 2 * COMPOSE_FIELD_BORDER_WIDTH - COMPOSE_INPUT_LINE_HEIGHT) / 2;
/** Потолок роста — целое число строк, иначе сверху вечно висит половина строки. */
const COMPOSE_INPUT_MAX_LINES = 6;

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
  /** Отступ меню от края пузыря (= ½ bubbleRowGap). */
  bubbleMenuGap: floraSpacing.grid / 2,
  bubbleGap: 2 * floraSpacing.grid,
  /** Горизонтальный padding текстового пузыря (= var(--flora-grid-step) на вебе). */
  bubblePadding: floraSpacing.grid,
  /** Вертикальный padding при inline-времени — 2×gridFine; однострочник 10+25+10=45px (.messagesBubbleInlineTime). */
  bubblePaddingVerticalInline: 2 * floraSpacing.gridFine,
  bubbleFontSize: 15,
  /** Шаг строки текста — паритет web --messages-bubble-line-step. */
  bubbleLineHeight: 25,
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
  composeFieldMinHeight: COMPOSE_FIELD_MIN_HEIGHT,
  composeFieldGap: 10,
  composeChromeBtn: COMPOSE_CHROME_BTN,
  composeChromeBtnBottomInset: COMPOSE_CHROME_BTN_BOTTOM_INSET,
  /** Внешние отступы оболочки поля ввода (над полем и под safe area). */
  composeShellPaddingTop: floraSpacing.grid,
  /** Зазор над pill при закрытой клавиатуре (поверх safe area). */
  composeShellPaddingBottomExtra: floraSpacing.grid,
  /** Зазор между pill и клавиатурой/панелью = верхнему зазору (composeShellPaddingTop) для симметрии. */
  composeShellPaddingKeyboard: floraSpacing.grid,
  composeFieldPaddingHorizontal: 14,
  composeFieldPaddingVertical: 0,
  /** Шаг строки в поле ввода: на столько растёт pill с каждой новой строкой. */
  composeInputLineHeight: COMPOSE_INPUT_LINE_HEIGHT,
  /** Зазор текста до краёв pill — одинаков на любом числе строк. */
  composeInputPaddingVertical: COMPOSE_INPUT_PADDING_VERTICAL,
  /** Потолок: дальше поле не растёт, строки уходят вверх скроллом внутри инпута. */
  composeInputMaxLines: COMPOSE_INPUT_MAX_LINES,
  /** Рост/сжатие поля — паритет web `transition: height 0.18s`. */
  composeGrowDurationMs: 180,
  /** Панель эмодзи в доке — как messagesStickerPanel на вебе. */
  emojiPanelRadius: 12,
  emojiPanelOuterGap: floraSpacing.grid,
  emojiPanelBottomExtra: floraSpacing.grid,
  themBubbleBg: t.messagesBubbleThemBg,
  themBubbleText: t.messagesBubbleThemText,
  themBubbleTime: t.messagesBubbleThemTime,
  divider: t.reservePopoverDivider,
};
