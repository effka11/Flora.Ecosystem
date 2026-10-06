/**
 * Полностью тёплый тред: страница уже в памяти, хвост терминален в decrypt-кэше,
 * текстовые строки хвоста имеют замер. Без RN — экран только подставляет чтения.
 */

export const CHAT_WARM_REVEAL_TAIL = 16;

export type ChatWarmOpenBlocker = "page" | "decrypt" | "measure";

/** Счётчики хвоста показа: почему тёплый путь взял или не взял ленту. */
export type ChatWarmOpenDiagnosis = {
  warm: boolean;
  blocker: ChatWarmOpenBlocker | null;
  /** `null` — страницы в кэше нет. */
  pageItems: number | null;
  tail: number;
  decryptTerminal: number;
  decryptMissing: number;
  decryptPending: number;
  textRows: number;
  measureHits: number;
  measureMisses: number;
};

export function diagnoseChatWarmOpen<
  TMessage,
  TRow extends { decryptState: string; text?: string },
>(args: {
  /** `null` — страницы в кэше нет. Пустой массив — закэшированный пустой тред. */
  messages: readonly TMessage[] | null | undefined;
  readDecrypt: (message: TMessage) => TRow | undefined;
  /** Строка с текстом: замер уже в памяти. Пустой текст замером не считается. */
  hasMeasure: (row: TRow) => boolean;
  tail?: number;
}): ChatWarmOpenDiagnosis {
  if (args.messages == null) {
    return {
      warm: false,
      blocker: "page",
      pageItems: null,
      tail: 0,
      decryptTerminal: 0,
      decryptMissing: 0,
      decryptPending: 0,
      textRows: 0,
      measureHits: 0,
      measureMisses: 0,
    };
  }
  const slice = args.messages.slice(-(args.tail ?? CHAT_WARM_REVEAL_TAIL));
  let decryptTerminal = 0;
  let decryptMissing = 0;
  let decryptPending = 0;
  let textRows = 0;
  let measureHits = 0;
  let measureMisses = 0;
  for (const message of slice) {
    const row = args.readDecrypt(message);
    if (!row || (row.decryptState !== "ok" && row.decryptState !== "failed")) {
      if (!row) decryptMissing += 1;
      else decryptPending += 1;
      continue;
    }
    decryptTerminal += 1;
    const text = row.text?.trim() ?? "";
    if (!text) continue;
    textRows += 1;
    if (args.hasMeasure(row)) measureHits += 1;
    else measureMisses += 1;
  }
  const blocker: ChatWarmOpenBlocker | null =
    decryptMissing + decryptPending > 0 ? "decrypt" : measureMisses > 0 ? "measure" : null;
  return {
    warm: blocker == null,
    blocker,
    pageItems: args.messages.length,
    tail: slice.length,
    decryptTerminal,
    decryptMissing,
    decryptPending,
    textRows,
    measureHits,
    measureMisses,
  };
}

export function formatChatWarmOpenDiagnosis(diagnosis: ChatWarmOpenDiagnosis): string {
  const page = diagnosis.pageItems == null ? "нет" : String(diagnosis.pageItems);
  return (
    `page=${page} tail=${diagnosis.tail} ` +
    `decrypt=${diagnosis.decryptTerminal}/${diagnosis.tail} ` +
    `missing=${diagnosis.decryptMissing} pending=${diagnosis.decryptPending} ` +
    `measure=${diagnosis.measureHits}/${diagnosis.textRows} miss=${diagnosis.measureMisses} ` +
    `blocker=${diagnosis.blocker ?? "-"}`
  );
}

export function isChatThreadFullyWarm<
  TMessage,
  TRow extends { decryptState: string; text?: string },
>(args: {
  /** `null` — страницы в кэше нет. Пустой массив — закэшированный пустой тред. */
  messages: readonly TMessage[] | null | undefined;
  readDecrypt: (message: TMessage) => TRow | undefined;
  /** Строка с текстом: замер уже в памяти. Пустой текст замером не считается. */
  hasMeasure: (row: TRow) => boolean;
  tail?: number;
}): boolean {
  return diagnoseChatWarmOpen(args).warm;
}

/**
 * Хвост уже терминален, окно можно собирать за краем.
 * Замер текста не ждём: его даст onLayout самой ленты.
 * Пустая страница готова. Нет страницы — нет.
 */
export function isChatWarmBenchPageReady<
  TMessage,
  TRow extends { decryptState: string; text?: string },
>(args: {
  messages: readonly TMessage[] | null | undefined;
  readDecrypt: (message: TMessage) => TRow | undefined;
  tail?: number;
}): boolean {
  if (args.messages == null) return false;
  return (
    diagnoseChatWarmOpen({
      messages: args.messages,
      readDecrypt: args.readDecrypt,
      hasMeasure: () => true,
      tail: args.tail,
    }).blocker == null
  );
}
