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
 */

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
    },
    isNewMessage: true,
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
