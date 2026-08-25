import type { MsgMessageDto } from "@flora/client-core/contracts";
import { frankingMissingReceiptWarning } from "@flora/client-core/display";
import {
  extractTextFromPlaintext,
  getImageBlocksFromPlaintext,
  getPrimaryVoiceBlock,
  isFscpGroupWirePayload,
  isFscpWirePayload,
  plaintextToPreview,
  type FscpMessagePlaintext,
} from "@flora/client-core/fscp";
import { useEffect, useRef, useState } from "react";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import {
  isOptimisticPayloadSentinel,
  takeClientMessageKey,
} from "@/lib/messageBirthRegistry";
import { messageThreadDecryptCache } from "@/stores/messageThreadCache";

const DECRYPT_BATCH = 4;

/**
 * Окно готовности треда и размер первой волны расшифровки: столько новейших
 * сообщений должно стать терминальными до показа ленты. Ждать весь тред
 * нельзя — время открытия росло линейно с историей (волны по DECRYPT_BATCH,
 * каждая с полным ре-рендером). Старая история дорасшифровывается фоном под
 * уже открытым чатом: peer-строки до готовности скрыты и вставляются выше
 * вьюпорта, у якоря (низ ленты) ничего не прыгает.
 */
export const THREAD_REVEAL_WINDOW = 16;

function isDecryptableFscpWire(enc: string | null | undefined): boolean {
  const t = enc?.trim();
  if (!t) return false;
  return isFscpWirePayload(t) || isFscpGroupWirePayload(t);
}

function missingFrankReceiptFromDto(m: MsgMessageDto, isGroupChat: boolean): boolean {
  return frankingMissingReceiptWarning({
    isGroupChat,
    frankTagBase64Url: m.frankTagBase64Url,
    wire: m.encryptedPayload,
    hasServerFrankReceipt: Boolean(m.serverFrankReceipt),
  });
}

export function messageDecryptCacheKey(m: MsgMessageDto): string {
  return `${m.messageUuid}|${(m.encryptedPayload ?? "").slice(0, 96)}`;
}

/**
 * Дедуп параллельной расшифровки одного сообщения: press-in-прогрев и волна
 * хука стартуют почти одновременно и без дедупа расшифровывали одни и те же
 * 16 строк дважды (в трассе — ready≈880мс при data≈170мс). Ключ — тот же,
 * что у кэша строк; запись снимается по завершении в любом исходе.
 */
const decryptWireInFlight = new Map<string, Promise<FscpMessagePlaintext>>();

function decryptWireDeduped(
  cacheKey: string,
  enc: string,
  viewerUserUuid: string,
  decryptWirePlaintext: (wire: string, viewer: string) => Promise<FscpMessagePlaintext>,
): Promise<FscpMessagePlaintext> {
  const existing = decryptWireInFlight.get(cacheKey);
  if (existing) return existing;
  const p = decryptWirePlaintext(enc, viewerUserUuid);
  decryptWireInFlight.set(cacheKey, p);
  const drop = () => {
    decryptWireInFlight.delete(cacheKey);
  };
  p.then(drop, drop);
  return p;
}

function normalizeRow(row: ThreadBubbleItem): ThreadBubbleItem {
  return {
    ...row,
    previewText: row.previewText ?? row.text ?? "",
    imageBlocks: row.imageBlocks ?? [],
    voiceBlock: row.voiceBlock,
    clientMessageKey:
      row.clientMessageKey ?? takeClientMessageKey(row.messageUuid) ?? row.messageUuid,
    senderUserUuid: row.senderUserUuid,
  };
}

function buildDecryptingRow(m: MsgMessageDto, isGroupChat: boolean): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    text: "",
    previewText: "",
    imageBlocks: [],
    voiceBlock: undefined,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "decrypting",
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
  };
}

function rowFromPlaintext(
  m: MsgMessageDto,
  plain: FscpMessagePlaintext,
  isGroupChat: boolean,
): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    text: extractTextFromPlaintext(plain),
    previewText: plaintextToPreview(plain),
    imageBlocks: getImageBlocksFromPlaintext(plain),
    voiceBlock: getPrimaryVoiceBlock(plain),
    replyTo: plain.replyTo,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "ok",
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
  };
}

function rowFromPreviewText(
  m: MsgMessageDto,
  preview: string,
  isGroupChat: boolean,
): ThreadBubbleItem {
  return {
    messageUuid: m.messageUuid,
    clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
    text: preview,
    previewText: preview,
    imageBlocks: [],
    voiceBlock: undefined,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    decryptState: "ok",
    isRead: m.isRead,
    senderUserUuid: m.senderUserUuid,
    missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
  };
}

function isRowTerminal(row: ThreadBubbleItem | undefined): boolean {
  return row?.decryptState === "ok" || row?.decryptState === "failed";
}

export function isRowDecryptComplete(
  m: MsgMessageDto,
  row: ThreadBubbleItem | undefined,
): boolean {
  if (!row || row.decryptState !== "ok") return false;
  const enc = m.encryptedPayload?.trim();
  if (enc && isDecryptableFscpWire(enc)) return true;
  return true;
}

function isConversationFullyResolved(
  messages: MsgMessageDto[],
  rows: ThreadBubbleItem[],
): boolean {
  if (rows.length !== messages.length) return false;
  return messages.every((m, i) => {
    const row = rows[i];
    if (row?.messageUuid !== m.messageUuid) return false;
    const enc = m.encryptedPayload?.trim();
    if (enc && isDecryptableFscpWire(enc)) return isRowTerminal(row);
    return row.decryptState === "ok";
  });
}

function withMessageMeta(
  row: ThreadBubbleItem,
  m: MsgMessageDto,
  isGroupChat: boolean,
): ThreadBubbleItem {
  const optimistic = isOptimisticPayloadSentinel(m.encryptedPayload);
  const sendStatus = optimistic ? ("sending" as const) : undefined;
  const missingFrankReceipt = missingFrankReceiptFromDto(m, isGroupChat);
  const senderUserUuid = m.senderUserUuid ?? row.senderUserUuid;
  const clientMessageKey =
    row.clientMessageKey ?? takeClientMessageKey(m.messageUuid) ?? m.messageUuid;
  // Identity-preserving merge: мета не изменилась — возвращаем тот же объект.
  // На этом держится memo пузырей: refetch/слияние «без изменений» не должно
  // перерисовать ни одной ячейки (раньше клонировали всегда, и каждая волна
  // релэйаутила всю ленту).
  if (
    row.messageUuid === m.messageUuid &&
    row.isFromMe === m.isFromMe &&
    row.createdAt === m.createdAt &&
    row.isRead === m.isRead &&
    row.senderUserUuid === senderUserUuid &&
    row.missingFrankReceipt === missingFrankReceipt &&
    row.clientMessageKey === clientMessageKey &&
    row.sendStatus === sendStatus &&
    row.previewText != null &&
    row.imageBlocks != null
  ) {
    return row;
  }
  return normalizeRow({
    ...row,
    messageUuid: m.messageUuid,
    isFromMe: m.isFromMe,
    createdAt: m.createdAt,
    isRead: m.isRead,
    senderUserUuid,
    missingFrankReceipt,
    clientMessageKey,
    sendStatus,
  });
}

function resolveRowForMessage(
  m: MsgMessageDto,
  currentByUuid: Map<string, ThreadBubbleItem>,
  isGroupChat: boolean,
): ThreadBubbleItem {
  const cacheKey = messageDecryptCacheKey(m);
  const wireCached = messageThreadDecryptCache.getMessage(cacheKey);
  if (wireCached && isRowTerminal(wireCached)) {
    return withMessageMeta(wireCached, m, isGroupChat);
  }
  const prev = currentByUuid.get(m.messageUuid);
  if (prev && isRowTerminal(prev)) {
    return withMessageMeta(prev, m, isGroupChat);
  }
  // Уже decrypting — переиспользуем строку: placeholder не рисует мету,
  // а стабильная identity не даёт merge'у ре-рендерить ячейки вьюпорта.
  if (prev && prev.decryptState === "decrypting") return prev;
  return buildDecryptingRow(m, isGroupChat);
}

function rowsFromWireCache(
  conversationUuid: string,
  messages: MsgMessageDto[],
  isGroupChat: boolean,
): ThreadBubbleItem[] | null {
  const cached = messageThreadDecryptCache.get(conversationUuid);
  if (!cached || !isConversationFullyResolved(messages, cached)) return null;
  const sameOrder = messages.every((m, i) => cached[i]?.messageUuid === m.messageUuid);
  return sameOrder
    ? messages.map((m, i) => withMessageMeta(cached[i]!, m, isGroupChat))
    : null;
}

function rowsMergingCurrent(
  messages: MsgMessageDto[],
  current: ThreadBubbleItem[],
  isGroupChat: boolean,
): ThreadBubbleItem[] {
  const byUuid = new Map(current.map((row) => [row.messageUuid, row]));
  return messages.map((m) => resolveRowForMessage(m, byUuid, isGroupChat));
}

/**
 * Фоновый прогрев decrypt-кэша треда (idle-префетч, гидрация с диска): к
 * моменту открытия чата все строки терминальны → `threadReady` истинен с
 * первого кадра, без «Расшифровка…»/скрытых пузырей.
 *
 * Пишет в те же кэши, что и хук (`messageThreadDecryptCache`), ключи
 * идентичны (`messageDecryptCacheKey`). Ошибка расшифровки прерывает прогрев
 * молча — терминальный `failed` выставляет только сам хук при открытии.
 */
export async function warmThreadDecryptRows(params: {
  conversationUuid: string;
  /** Oldest-first, как в RQ-кэше треда. */
  messages: readonly MsgMessageDto[];
  isGroupChat: boolean;
  viewerUserUuid: string;
  decryptWirePlaintext: (wire: string, viewerUserUuid: string) => Promise<FscpMessagePlaintext>;
  shouldContinue?: () => boolean;
  yieldBetweenSteps?: () => Promise<void>;
}): Promise<void> {
  const {
    conversationUuid,
    messages,
    isGroupChat,
    viewerUserUuid,
    decryptWirePlaintext,
  } = params;
  const shouldContinue = params.shouldContinue ?? (() => true);
  const yieldStep =
    params.yieldBetweenSteps ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  if (!conversationUuid || messages.length === 0) return;

  // Новые первыми: пользователь открывает низ ленты.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!shouldContinue()) return;
    const m = messages[i]!;
    if (isOptimisticPayloadSentinel(m.encryptedPayload)) continue;
    const cacheKey = messageDecryptCacheKey(m);
    const cached = messageThreadDecryptCache.getMessage(cacheKey);
    if (cached && isRowTerminal(cached)) continue;

    const enc = m.encryptedPayload?.trim();
    let row: ThreadBubbleItem;
    if (enc && isDecryptableFscpWire(enc)) {
      try {
        const plain = await decryptWireDeduped(
          cacheKey,
          enc,
          viewerUserUuid,
          decryptWirePlaintext,
        );
        row = rowFromPlaintext(m, plain, isGroupChat);
      } catch {
        return;
      }
    } else {
      row = rowFromPreviewText(
        m,
        plaintextToPreview({
          type: "blocks",
          version: 1,
          blocks: [{ kind: "text", body: m.encryptedPayload ?? "" }],
          clientCreatedAt: m.createdAt,
        }),
        isGroupChat,
      );
    }
    messageThreadDecryptCache.setMessage(cacheKey, row);
    await yieldStep();
  }

  if (!shouldContinue()) return;
  // Полный массив треда — fast path `rowsFromWireCache` при открытии.
  const rows: ThreadBubbleItem[] = [];
  for (const m of messages) {
    const cached = messageThreadDecryptCache.getMessage(messageDecryptCacheKey(m));
    if (!cached || !isRowTerminal(cached)) return;
    rows.push(withMessageMeta(cached, m, isGroupChat));
  }
  // Вызовы со срезом (прогрев окна показа) не должны усаживать уже полный
  // массив треда — иначе fast path при открытии деградирует до merge.
  const prevThreadRows = messageThreadDecryptCache.get(conversationUuid);
  if (prevThreadRows && prevThreadRows.length > rows.length) return;
  messageThreadDecryptCache.set(conversationUuid, rows);
}

type Args = {
  conversationUuid: string;
  messages: MsgMessageDto[];
  messagesKey: string;
  isGroupChat: boolean;
  viewerUserUuid: string | undefined;
  fscpReady: boolean;
  fscpDecryptKey?: string | null;
  decryptWirePlaintext: (wire: string, viewerUserUuid: string) => Promise<FscpMessagePlaintext>;
  /**
   * Пока true — стоят все волны, не кормящие окно показа (включая первую,
   * если окно уже терминально из прогрева). Каждая волна — setRows →
   * перестройка listData прямо в окне замера FlashList (ready→load):
   * открытие длиннее, строки истории «подмигивают». Экран передаёт сюда
   * `!listRevealed` — фон идёт после первого кадра.
   */
  holdBackgroundWaves?: boolean;
};

const HOLD_POLL_MS = 64;
/**
 * Потолок удержания: показ ленты — не гарантия (пустой тред, сорванный
 * onLoad), а история обязана дорасшифроваться. Ждём разумную паузу и идём.
 */
const HOLD_MAX_MS = 2500;

export function useThreadMessageDecrypt({
  conversationUuid,
  messages,
  messagesKey,
  isGroupChat,
  viewerUserUuid,
  fscpReady,
  fscpDecryptKey,
  decryptWirePlaintext,
  holdBackgroundWaves,
}: Args): ThreadBubbleItem[] {
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const decryptWirePlaintextRef = useRef(decryptWirePlaintext);
  decryptWirePlaintextRef.current = decryptWirePlaintext;

  const holdBackgroundWavesRef = useRef(holdBackgroundWaves === true);
  holdBackgroundWavesRef.current = holdBackgroundWaves === true;

  const prevMessagesKeyRef = useRef<string | null>(null);
  const prevFscpDecryptKeyRef = useRef<string | null | undefined>(undefined);

  const [rows, setRows] = useState<ThreadBubbleItem[]>(() => {
    if (!conversationUuid || messages.length === 0) return [];
    return (
      rowsFromWireCache(conversationUuid, messages, isGroupChat) ??
      rowsMergingCurrent(messages, [], isGroupChat)
    );
  });

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const currentMessages = messagesRef.current;
    if (!messagesKey) {
      setRows([]);
      return;
    }

    const conversationCached = rowsFromWireCache(
      conversationUuid,
      currentMessages,
      isGroupChat,
    );
    if (conversationCached) {
      // Все строки совпали по identity — setRows не нужен (лишний ре-рендер
      // всей ленты на тёплом открытии).
      const prev = rowsRef.current;
      const same =
        prev.length === conversationCached.length &&
        conversationCached.every((row, i) => row === prev[i]);
      if (!same) {
        setRows(conversationCached);
        rowsRef.current = conversationCached;
      }
      return;
    }

    const messagesKeyChanged = prevMessagesKeyRef.current !== messagesKey;
    const fscpKeyChanged = prevFscpDecryptKeyRef.current !== fscpDecryptKey;
    prevMessagesKeyRef.current = messagesKey;
    prevFscpDecryptKeyRef.current = fscpDecryptKey;

    if (messagesKeyChanged || fscpKeyChanged) {
      const seeded = rowsMergingCurrent(currentMessages, rowsRef.current, isGroupChat);
      // Все строки совпали по identity (тёплое повторное открытие) — коммит
      // не нужен, иначе весь вьюпорт ячеек ре-рендерится впустую.
      const prev = rowsRef.current;
      const same =
        prev.length === seeded.length && seeded.every((row, i) => row === prev[i]);
      if (!same) {
        setRows(seeded);
        rowsRef.current = seeded;
      }
    } else {
      const merged = rowsMergingCurrent(currentMessages, rowsRef.current, isGroupChat);
      const changed = merged.some((row, i) => row !== rowsRef.current[i]);
      if (changed) {
        setRows(merged);
        rowsRef.current = merged;
      }
    }

    if (!viewerUserUuid || !fscpReady) return;

    let cancelled = false;
    const pending = currentMessages
      .map((m, index) => ({ m, index }))
      .filter(({ m, index }) => {
        if (isOptimisticPayloadSentinel(m.encryptedPayload)) return false;
        const cacheKey = messageDecryptCacheKey(m);
        const cached = messageThreadDecryptCache.getMessage(cacheKey);
        if (cached && isRowTerminal(cached)) return false;
        const row = rowsRef.current[index];
        if (row?.messageUuid === m.messageUuid && isRowTerminal(row)) return false;
        return true;
      })
      .reverse();

    if (pending.length === 0) {
      if (isConversationFullyResolved(currentMessages, rowsRef.current)) {
        messageThreadDecryptCache.set(conversationUuid, rowsRef.current);
      }
      return;
    }

    void (async () => {
      const next = rowsRef.current.slice();
      // Индекс начала окна показа: волны, не задевающие его, — чистый фон.
      const revealWindowStart = currentMessages.length - THREAD_REVEAL_WINDOW;

      for (let offset = 0; offset < pending.length; ) {
        if (cancelled) return;
        // Первая волна = окно показа: reveal после одного setRows, а не после
        // window/DECRYPT_BATCH ре-рендеров. pending отсортирован новыми вперёд.
        const size = offset === 0 ? THREAD_REVEAL_WINDOW : DECRYPT_BATCH;
        const chunk = pending.slice(offset, offset + size);
        offset += size;
        // Фоновые волны ждут первого видимого кадра ленты (см. Args). Держим
        // ЛЮБУЮ волну, не кормящую окно показа, — включая первую: на тёплом
        // открытии (прогрев с касания) pending — только старая история, и
        // расшифровка 16 строк жгла CPU ровно в окне монтажа ячеек.
        const feedsRevealWindow = chunk.some(({ index }) => index >= revealWindowStart);
        const holdUntil = Date.now() + HOLD_MAX_MS;
        while (
          !feedsRevealWindow &&
          holdBackgroundWavesRef.current &&
          !cancelled &&
          Date.now() < holdUntil
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, HOLD_POLL_MS));
        }
        if (cancelled) return;
        await Promise.all(
          chunk.map(async ({ m, index }) => {
            const cacheKey = messageDecryptCacheKey(m);
            const enc = m.encryptedPayload?.trim();
            let row: ThreadBubbleItem;
            // Re-check к моменту расшифровки: pending снят до того, как
            // press-in-прогрев дописал кэш, — без этой проверки та же строка
            // расшифровывалась второй раз.
            const freshCached = messageThreadDecryptCache.getMessage(cacheKey);
            if (freshCached && isRowTerminal(freshCached)) {
              next[index] = withMessageMeta(freshCached, m, isGroupChat);
              return;
            }
            if (enc && isDecryptableFscpWire(enc)) {
              try {
                const plain = await decryptWireDeduped(
                  cacheKey,
                  enc,
                  viewerUserUuid,
                  decryptWirePlaintextRef.current,
                );
                row = rowFromPlaintext(m, plain, isGroupChat);
              } catch {
                row = {
                  messageUuid: m.messageUuid,
                  clientMessageKey: takeClientMessageKey(m.messageUuid) ?? m.messageUuid,
                  text: "",
                  previewText: "",
                  imageBlocks: [],
                  voiceBlock: undefined,
                  isFromMe: m.isFromMe,
                  createdAt: m.createdAt,
                  decryptState: "failed",
                  isRead: m.isRead,
                  senderUserUuid: m.senderUserUuid,
                  missingFrankReceipt: missingFrankReceiptFromDto(m, isGroupChat),
                };
              }
            } else if (isOptimisticPayloadSentinel(enc)) {
              const cached = messageThreadDecryptCache.getMessage(cacheKey);
              row =
                cached && isRowTerminal(cached)
                  ? withMessageMeta(cached, m, isGroupChat)
                  : buildDecryptingRow(m, isGroupChat);
            } else {
              row = rowFromPreviewText(
                m,
                plaintextToPreview({
                  type: "blocks",
                  version: 1,
                  blocks: [{ kind: "text", body: m.encryptedPayload ?? "" }],
                  clientCreatedAt: m.createdAt,
                }),
                isGroupChat,
              );
            }
            messageThreadDecryptCache.setMessage(cacheKey, row);
            next[index] = row;
          }),
        );
        if (cancelled) return;
        rowsRef.current = next;
        setRows(next.slice());
      }

      if (!cancelled && isConversationFullyResolved(currentMessages, rowsRef.current)) {
        messageThreadDecryptCache.set(conversationUuid, rowsRef.current);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationUuid, fscpDecryptKey, fscpReady, isGroupChat, messagesKey, viewerUserUuid]);

  return rows;
}
