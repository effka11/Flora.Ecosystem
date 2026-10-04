import { FLORA_THEME_TOKENS } from "@flora/client-core/display";
import {
  getFloraGridRuntime,
  kegl,
  liveGridRecord,
  sPx,
  tracking,
} from "@/lib/floraGridRuntime";

export { kegl, sPx, tracking } from "@/lib/floraGridRuntime";

const t = FLORA_THEME_TOKENS;

/** Палитра Flora — синхронизирована с apps/Web/app/globals.css через client-core. */
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

export const floraAuthTypography = liveGridRecord(() => ({
  light: "300" as const,
  letterWide: tracking(1.8),
  letterLogo: tracking(3),
  letterButton: tracking(1.6),
  letterLink: tracking(1.8),
  sizeBody: kegl(15),
  sizeLogo: sPx(40),
}));

export const floraSpacing = {
  get grid() {
    return getFloraGridRuntime().step;
  },
  get gridFine() {
    return getFloraGridRuntime().stepFine;
  },
};

/** Триггеры фильтров (сообщения, уведомления) — совпадают с tabButton в ленте. */
export const floraTabFilter = liveGridRecord(() => {
  const triggerHeight = 2 * floraSpacing.grid + floraSpacing.gridFine;
  const triggerLabelLineHeight = kegl(15);
  const indicatorHeight = sPx(2);
  const labelGapAboveIndicator =
    (triggerHeight - triggerLabelLineHeight) / 2 - indicatorHeight;
  return {
    triggerHeight,
    triggerLabelLineHeight,
    indicatorHeight,
    /** Зазор между текстом и верхом подчёркивания. */
    labelGapAboveIndicator,
    /** Такой же зазор под подчёркиванием до меню. */
    menuGapBelow: labelGapAboveIndicator,
  };
});

/** Карточка поста в ленте — feedPostList.module.css / feed.module.css */
export const floraFeedPost = liveGridRecord(() => {
  const nicknameLineHeight = kegl(15);
  const nicknamePaintLineHeight = kegl(15) + floraSpacing.gridFine;
  const textFontSize = kegl(15);
  const textLineHeight = 1.7 * kegl(15);
  return {
    avatarSize: 3 * floraSpacing.grid,
    /** Левый/общий inset карточки — как padding шапки (слот гамбургера / «+»). */
    paddingHorizontal: floraSpacing.grid,
    /**
     * Дополнительный правый inset наполнения (текст, фото, действия, комментарии).
     * Карточка и ⋮ остаются на 1×grid (слот «+»). Наполнение — ещё 2×fine,
     * итого 1×grid + 2×fine от экрана.
     */
    contentInsetRight: floraSpacing.gridFine * 2,
    paddingTop: 2 * floraSpacing.grid,
    paddingBottom: 2 * floraSpacing.grid + sPx(2),
    columnGap: floraSpacing.grid + floraSpacing.gridFine,
    /**
     * Верх аватара → верх ника = 1×fine (web: header padding 2×fine + author top −1×fine).
     * На мобайле задаём напрямую, без промежуточного nudge.
     */
    nicknameGapFromAvatarTop: floraSpacing.gridFine,
    /** Visual slot / fontSize. Do not use as the Text line box — that clips descenders. */
    nicknameLineHeight,
    /** Text line box so `g` / `@` are not clipped (15 + 1×fine). */
    nicknamePaintLineHeight,
    /** Cancel Android half-leading so the cap height stays on the old Y. */
    nicknamePaintShiftY: -((nicknamePaintLineHeight - nicknameLineHeight) / 2),
    rowGap: floraSpacing.gridFine,
    /**
     * Верх слота ⋮: старый top (−grid/2+1) минус половина прироста слота 28→45,
     * чтобы центр глифа остался на горизонтали ника.
     */
    moreMenuTop:
      -floraSpacing.grid / 2 + 1 - (3 * floraSpacing.grid - (2 * floraSpacing.gridFine + sPx(18))) / 2,
    contentNudgeX: -floraSpacing.gridFine,
    /**
     * Низ аватара → верх наполнения (текст/фото) = 1×fine
     * (web: row-gap + postBody −1×fine + images/text +1×fine → net 1×fine).
     */
    bodyMarginTop: floraSpacing.gridFine,
    textFontSize,
    textLineHeight,
    /**
     * Срез half-leading первой строки (паритет с верхом фото / web text-box-trim).
     * Иначе caps текста визуально ниже края фото на ~(lh − size) / 2.
     */
    textCapTrim: -((textLineHeight - textFontSize) / 2),
    g20: 4 * floraSpacing.gridFine,
    /** Иконка лайка/коммента/репоста. */
    actionIconSize: sPx(18),
    /**
     * Зазор между иконками = слот числа (40) + 1×fine воздуха до следующей иконки.
     * Число абсолютно в зазоре, поэтому «0» и «120к» не двигают соседний глиф.
     */
    actionGap: 3 * floraSpacing.grid + floraSpacing.gridFine,
    actionIconGap: floraSpacing.gridFine,
    /** Ширина слота счётчика — «128к» / «999», 2×grid + 2×fine. */
    actionCountWidth: 2 * floraSpacing.grid + 2 * floraSpacing.gridFine,
    actionsBarMarginTop: floraSpacing.grid + floraSpacing.gridFine,
    textMarginBottom: floraSpacing.grid,
    actionFontSize: kegl(13),
    actionLetterSpacing: 0,
    /** Как iconButton / ⋮ в Messages — центр на одной вертикали с «+»/шапкой чата. */
    moreBtnSize: 3 * floraSpacing.grid,
    moreBtnPadding: 0,
    /** Сдвиг по Y к горизонтали ника (как до выравнивания слота). */
    moreBtnNudgeY: floraSpacing.gridFine + sPx(3),
    /** Глиф как ChromeMoreIcon. */
    moreGlyphSlot: sPx(24),
    moreGlyphSize: sPx(24),
    moreCloseGlyphSize: sPx(24),
    /** Отступ панели ниже ⋮: web gap + 1 primary step (визуальный зазор под крестиком). */
    moreMenuGapBelow: floraSpacing.grid * 2 + floraSpacing.gridFine + sPx(3),
  };
});

/** Высота зоны иконок нижнего tab bar. */
export function floraTabBarHeight() {
  return sPx(49);
}

/** Отступ от верхней линии до иконок. */
export function floraTabBarTopPad() {
  return getFloraGridRuntime().stepFine * 2;
}

/** Полная высота контента tab bar без safe-area. */
export function floraTabBarContentHeight() {
  return floraTabBarHeight() + floraTabBarTopPad();
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
    paddingTop: floraTabBarTopPad(),
    paddingBottom: bottomInset,
    height: floraTabBarContentHeight() + bottomInset,
  };
}

/**
 * Tab bar «в треде»: hit-testing выключен (compose остаётся нажимаемым),
 * высоту не схлопываем. Пиксели не гасим — видимость ведёт ChatPushTabBar
 * по chatPushProgress (дырка справа), иначе на возврате бар вспыхивает после pop.
 */
export function floraTabBarHiddenStyle(bottomInset: number) {
  return {
    backgroundColor: "transparent",
    borderTopWidth: 0,
    height: floraTabBarContentHeight() + bottomInset,
    minHeight: floraTabBarContentHeight() + bottomInset,
    paddingTop: floraTabBarTopPad(),
    paddingBottom: bottomInset,
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
export const floraProfile = liveGridRecord(() => ({
  coverHeight: 7 * floraSpacing.grid,
  avatarSize: 6 * floraSpacing.grid + 2 * sPx(4),
  statusFontSize: kegl(15),
  statusLineHeight: 2.1 * kegl(15),
  statusStripe: "rgba(250, 250, 250, 0.08)",
}));

export const floraMotion = {
  baseMs: 150,
  /** Как ENERGETIC_OPEN_MS — тап подвкладок (рекомендации/подписки). */
  tabTransitionDurationMs: 150 * 3,
  /** Кадр на отрисовку новой сцены под оверлеем. */
  tabTransitionDelayMs: 20,
};

/** Потолок роста compose — целое число строк, не внесенка `s`. */
const COMPOSE_INPUT_MAX_LINES = 6;
const COMPOSE_FIELD_BORDER_WIDTH = 1;

/** Чат — messages.module.css / messagesChatView */
export const floraMessages = liveGridRecord(() => {
  const composeFieldMinHeight = 3 * floraSpacing.grid;
  const composeChromeBtn = sPx(28);
  const composeInputLineHeight = sPx(22);
  return {
    headerHeight: 8 * floraSpacing.grid,
    headerAvatarSize: 3 * floraSpacing.grid,
    peerBubbleAvatarSize: 3 * floraSpacing.grid,
    bubbleRadius: sPx(18),
    bubbleTailRadius: sPx(6),
    bubbleMaxWidthRatio: 0.78,
    /** Вертикальный зазор между строками сообщений в ленте (и до линии compose у последнего). */
    bubbleRowGap: floraSpacing.grid,
    /** Отступ меню от края пузыря (= gridFine). */
    bubbleMenuGap: floraSpacing.gridFine,
    /** Мин. отступ меню от линий шапка / compose (= grid + fine). */
    bubbleMenuFeedInset: floraSpacing.grid + floraSpacing.gridFine,
    bubbleGap: 2 * floraSpacing.grid,
    /** Горизонтальный padding текстового пузыря (= var(--flora-grid-step) на вебе). */
    bubblePadding: floraSpacing.grid,
    /** Вертикальный padding при inline-времени — 2×gridFine; однострочник 10+25+10=45px (.messagesBubbleInlineTime). */
    bubblePaddingVerticalInline: 2 * floraSpacing.gridFine,
    bubbleFontSize: kegl(15),
    /** Шаг строки текста — паритет web --messages-bubble-line-step. */
    bubbleLineHeight: sPx(25),
    bubbleTimeFontSize: kegl(12),
    /** Пузырь с фото — 20 кл. первичной сетки (messages.module.css). */
    photoBubbleWidth: 20 * floraSpacing.grid,
    /** Коллаж в сообщении — 5 кл. на строку (messagesImageCollage). */
    messageCollageRowHeight: 5 * floraSpacing.grid,
    /** Одно фото в пузыре — max-height 24 кл. */
    messageSingleImageMaxHeight: 24 * floraSpacing.grid,
    voicePlayBtnSize: 2 * floraSpacing.grid,
    /** Голосовое-only — 25 кл. первичной сетки (messagesBubbleVoiceOnly на вебе). */
    voiceBubbleWidth: 25 * floraSpacing.grid,
    composeRadius: sPx(12),
    composeBorderColor: floraColors.greenDark,
    /** Как TabScreenSearchHeader.searchBox — minHeight 45. */
    composeFieldMinHeight,
    composeFieldGap: sPx(10),
    composeChromeBtn,
    composeChromeBtnBottomInset:
      (composeFieldMinHeight - 2 * COMPOSE_FIELD_BORDER_WIDTH - composeChromeBtn) / 2,
    /** Внешние отступы оболочки поля ввода (над полем и под safe area). */
    composeShellPaddingTop: floraSpacing.grid,
    /** Зазор над pill при закрытой клавиатуре (поверх safe area). */
    composeShellPaddingBottomExtra: floraSpacing.grid,
    /** Зазор между pill и клавиатурой/панелью = верхнему зазору (composeShellPaddingTop) для симметрии. */
    composeShellPaddingKeyboard: floraSpacing.grid,
    composeFieldPaddingHorizontal: sPx(14),
    composeFieldPaddingVertical: 0,
    /** Шаг строки в поле ввода: на столько растёт pill с каждой новой строкой. */
    composeInputLineHeight,
    /** Зазор текста до краёв pill — одинаков на любом числе строк. */
    composeInputPaddingVertical:
      (composeFieldMinHeight - 2 * COMPOSE_FIELD_BORDER_WIDTH - composeInputLineHeight) / 2,
    /** Потолок: дальше поле не растёт, строки уходят вверх скроллом внутри инпута. */
    composeInputMaxLines: COMPOSE_INPUT_MAX_LINES,
    /** Рост/сжатие поля — паритет web `transition: height 0.18s`. */
    composeGrowDurationMs: 180,
    /** Панель эмодзи в доке — как messagesStickerPanel на вебе. */
    emojiPanelRadius: sPx(12),
    emojiPanelOuterGap: floraSpacing.grid,
    emojiPanelBottomExtra: floraSpacing.grid,
    themBubbleBg: t.messagesBubbleThemBg,
    themBubbleText: t.messagesBubbleThemText,
    themBubbleTime: t.messagesBubbleThemTime,
    divider: t.reservePopoverDivider,
  };
});
