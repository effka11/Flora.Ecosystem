/**
 * FscpV1ConversationSession — машина состояний 1:1 сессии (Documents/fscp/FSCP.md §Session state).
 *
 * Состояние ведётся на пару (conversationUuid, keyEpochId) и живёт вне нормы wire
 * (память / локальное хранилище). Реализация — чистые функции над immutable-снимком:
 * никакого I/O, чтобы поведение переходов было тестируемым и переносимым (Web/Mobile/Rust).
 *
 * | состояние         | условие                                   | поведение                                  |
 * | uninitialized     | нет успешно обработанного envelope        | можно отправить первое сообщение           |
 * | ready             | ≥1 сообщение успешно обработано           | обычный обмен                              |
 * | compromised_local | revoke / смена epoch / reset / сбой decrypt| исходящие приостановлены до re-handshake  |
 *
 * Сбои decrypt классифицируются (errata-5, FSCP-REVIEW п.3): одиночный сбой не
 * замораживает исходящие (иначе собеседник/сервер может DoS-ить отправку одним
 * мусорным конвертом). В compromised_local ведут только повторные
 * key-mismatch-сбои (порог `FSCP_DECRYPT_COMPROMISE_THRESHOLD`).
 */

import type { FscpDecryptFailureCategory } from "./envelope.js";

export type FscpSessionState = "uninitialized" | "ready" | "compromised_local";

/** Причина перевода в compromised_local — для UX и телеметрии (без plaintext-контекста). */
export type FscpSessionCompromiseReason =
  | "device_revoked"
  | "epoch_identity_changed"
  | "user_reset"
  | "decrypt_failure";

export type FscpV1ConversationSession = {
  conversationUuid: string;
  keyEpochId: string;
  peerUserUuid: string;
  fscpProtocolVersion: 1;
  sessionState: FscpSessionState;
  /** Опционально, anti-duplicate UX (FSCP.md §Session state, таблица полей). */
  lastProcessedInboundMessageUuid?: string;
  lastAcceptedOutboundMessageUuid?: string;
  /** Заполнено только в compromised_local. */
  compromiseReason?: FscpSessionCompromiseReason;
  /** Подряд идущие key-mismatch-сбои decrypt; сбрасывается успешным decrypt. */
  consecutiveDecryptFailures?: number;
};

export function createConversationSession(params: {
  conversationUuid: string;
  keyEpochId: string;
  peerUserUuid: string;
}): FscpV1ConversationSession {
  return {
    conversationUuid: params.conversationUuid.toLowerCase(),
    keyEpochId: params.keyEpochId.toLowerCase(),
    peerUserUuid: params.peerUserUuid.toLowerCase(),
    fscpProtocolVersion: 1,
    sessionState: "uninitialized",
  };
}

/** Исходящие разрешены во всех состояниях, кроме compromised_local (спека: «приостановлены до re-handshake»). */
export function canSendOutbound(session: FscpV1ConversationSession): boolean {
  return session.sessionState !== "compromised_local";
}

export type FscpInboundDecryptOutcome = {
  session: FscpV1ConversationSession;
  /** false для повторно доставленного messageUuid — UX не показывает дубликат. */
  isNewMessage: boolean;
};

/**
 * Успешный decrypt входящего: uninitialized|ready → ready.
 * В compromised_local входящие продолжают читаться (заморожены только исходящие),
 * но состояние не «лечится» само — выход только через re-handshake.
 */
export function noteInboundDecrypted(
  session: FscpV1ConversationSession,
  messageUuid: string,
): FscpInboundDecryptOutcome {
  const uuid = messageUuid.toLowerCase();
  if (session.lastProcessedInboundMessageUuid === uuid) {
    return { session, isNewMessage: false };
  }
  return {
    session: {
      ...session,
      sessionState: session.sessionState === "compromised_local" ? "compromised_local" : "ready",
      lastProcessedInboundMessageUuid: uuid,
      consecutiveDecryptFailures: 0,
    },
    isNewMessage: true,
  };
}

// ── Классификация сбоев decrypt (анти-DoS, errata-5) ─────────────────────────

/** Порог подряд идущих key-mismatch-сбоев до перехода в compromised_local. */
export const FSCP_DECRYPT_COMPROMISE_THRESHOLD = 3;

export type FscpDecryptFailureImpact =
  /** Свидетельство рассинхронизации ключей — считается к порогу compromised_local. */
  | "key_mismatch_suspect"
  /** Конверт отклонён по форме/подписи — атрибутируемо отправителю, сессию не трогаем. */
  | "envelope_rejected";

export function classifyDecryptFailure(category: FscpDecryptFailureCategory): FscpDecryptFailureImpact {
  switch (category) {
    case "rke_unwrap_failed":
    case "body_decrypt_failed":
      return "key_mismatch_suspect";
    default:
      return "envelope_rejected";
  }
}

export type FscpDecryptFailureOutcome = {
  session: FscpV1ConversationSession;
  /** true, если именно этот сбой перевёл сессию в compromised_local. */
  compromisedNow: boolean;
};

/**
 * Сбой decrypt входящего. Вместо мгновенного `markCompromisedLocal` (DoS-вектор,
 * FSCP-REVIEW п.3): подпись/форма/чужой конверт не влияют на сессию; только
 * подряд идущие криптосбои с корректным конвертом (`key_mismatch_suspect`)
 * накапливаются и при достижении порога замораживают исходящие.
 */
export function noteInboundDecryptFailure(
  session: FscpV1ConversationSession,
  category: FscpDecryptFailureCategory,
): FscpDecryptFailureOutcome {
  if (session.sessionState === "compromised_local") {
    return { session, compromisedNow: false };
  }
  if (classifyDecryptFailure(category) === "envelope_rejected") {
    return { session, compromisedNow: false };
  }
  const failures = (session.consecutiveDecryptFailures ?? 0) + 1;
  if (failures >= FSCP_DECRYPT_COMPROMISE_THRESHOLD) {
    return {
      session: {
        ...session,
        sessionState: "compromised_local",
        compromiseReason: "decrypt_failure",
        consecutiveDecryptFailures: failures,
      },
      compromisedNow: true,
    };
  }
  return {
    session: { ...session, consecutiveDecryptFailures: failures },
    compromisedNow: false,
  };
}

/**
 * Сервер принял исходящее (envelope прошёл валидацию): «хотя бы одно сообщение
 * успешно обработано» → ready. Вызов при compromised_local — ошибка использования:
 * отправка обязана быть заблокирована `canSendOutbound` ДО построения конверта.
 */
export function noteOutboundAccepted(
  session: FscpV1ConversationSession,
  messageUuid: string,
): FscpV1ConversationSession {
  if (session.sessionState === "compromised_local") {
    throw new Error("FSCP session: исходящие приостановлены до re-handshake (compromised_local).");
  }
  return {
    ...session,
    sessionState: "ready",
    lastAcceptedOutboundMessageUuid: messageUuid.toLowerCase(),
  };
}

/** Любой из триггеров спеки: revoke устройства, смена epoch identity, reset в UI, сбой decrypt. */
export function markCompromisedLocal(
  session: FscpV1ConversationSession,
  reason: FscpSessionCompromiseReason,
): FscpV1ConversationSession {
  if (session.sessionState === "compromised_local") {
    return session; // идемпотентно; первая причина сохраняется
  }
  return { ...session, sessionState: "compromised_local", compromiseReason: reason };
}

/** Статус device binding из server-attested списка (GET epochs/{id}/devices). */
export type FscpDeviceBindingStatus = "Active" | "Pending" | "Revoked";

export type FscpInboundSenderDevicePolicyOutcome = {
  session: FscpV1ConversationSession;
  /** false — конверт не обрабатывать (не расшифровывать/не показывать). */
  acceptInbound: boolean;
};

/**
 * Инбаунд-политика device revocation (FSCP.md §Device revocation,
 * e2e-security.md Acceptance: «отклоняют дальнейшие операции с отозванным device
 * как с active»). Криптографически wire от отозванного устройства остаётся
 * валидным (подпись/AEAD не знают о статусе) — отказ обязан приходить из
 * policy-слоя: перед обработкой входящего вызывающий сопоставляет
 * `senderDeviceUuid` конверта с server-attested статусом устройства.
 *
 * Revoked → конверт отклоняется, сессия переводится в compromised_local
 * (`device_revoked`), выход — только re-handshake с active-устройством.
 * Golden: fscp-revoked-device-v1.json (`message_session_revoked_device_v1_failure`).
 */
export function evaluateInboundSenderDevice(
  session: FscpV1ConversationSession,
  senderDeviceStatus: FscpDeviceBindingStatus | undefined,
): FscpInboundSenderDevicePolicyOutcome {
  if (senderDeviceStatus === "Revoked") {
    return {
      session: markCompromisedLocal(session, "device_revoked"),
      acceptInbound: false,
    };
  }
  return { session, acceptInbound: true };
}

/**
 * Re-handshake: свежая uninitialized-сессия для (возможно, новой) эпохи.
 * Счётчики сообщений сбрасываются — прежние uuid принадлежат старой паре
 * (conversationUuid, keyEpochId) и для новой сессии не «уже обработаны».
 */
export function reHandshake(
  session: FscpV1ConversationSession,
  params?: { newKeyEpochId?: string },
): FscpV1ConversationSession {
  return createConversationSession({
    conversationUuid: session.conversationUuid,
    keyEpochId: params?.newKeyEpochId ?? session.keyEpochId,
    peerUserUuid: session.peerUserUuid,
  });
}
