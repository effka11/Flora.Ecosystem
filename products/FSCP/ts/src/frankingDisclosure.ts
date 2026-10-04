/**
 * Раскрытие у ревьюера (franking.md §4.4, §4.7).
 *
 * Обратный путь к сборке жалобы: sealed disclosure → кортеж → блоки → вердикт.
 * Кортеж приходит от жалобщика, то есть от стороны, чью добросовестность как раз
 * и проверяют. Отсюда разделение: то, что делает кортеж нечитаемым (чужая версия,
 * лишнее поле, не-UUID, битый base64url, обрезанный JSON), — исключение, а то, что
 * читается, но не доказывает жалобу, — вердикт. Формат байтов не меняется: здесь
 * только разбор того, что пишет `encodeFrankingComplaintDisclosureV1`.
 */
import { normalizeFscpMessagePlaintext, type FscpMessagePlaintext } from "./envelope.js";
import {
  decodeFrankingComplaintBundleV2,
  decodeFscpBase64Url,
  openFrankingDisclosureV1,
  verifyFrankedMessageV1,
  type FrankComplaintTupleV1,
  type FrankingComplaintBundleV2,
  type FrankingComplaintDisclosureV1,
  type FrankingDisclosureSodium,
  type FrankVerifyResultV1,
  type FscpBase64Sodium,
  type ServerFrankReceiptV1,
} from "./franking.js";
import type { SodiumModule } from "./sodium.js";

const FRANKING_DISCLOSURE_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Алфавит base64url без паддинга (RFC 4648 §5); длина с остатком 1 по модулю 4 недостижима. */
const FRANKING_DISCLOSURE_BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const FRANKING_RECEIPT_SIGNATURE_BYTES = 64;

const FRANKING_DISCLOSURE_KEYS: readonly (keyof FrankingComplaintDisclosureV1)[] = [
  "v",
  "plaintextUtf8Base64Url",
  "frankingKeyBase64Url",
  "frankTagBase64Url",
  "serverFrankReceipt",
  "messageUuid",
  "persistedMessageUuid",
  "conversationUuid",
  "senderUserUuid",
  "senderDeviceUuid",
  "receiverUserUuid",
  "createdAt",
];

const FRANKING_RECEIPT_KEYS: readonly (keyof ServerFrankReceiptV1)[] = [
  "signatureBase64Url",
  "serverFrankingKeyId",
  "serverReceivedAt",
];

function disclosureError(message: string): Error {
  return new Error(`franking disclosure v1: ${message}`);
}

/** `objectName` — имя вложенного объекта или "" для верхнего уровня кортежа. */
function assertExactKeys(
  obj: Record<string, unknown>,
  expected: readonly string[],
  objectName: string,
): void {
  const at = objectName ? `${objectName}: ` : "";
  for (const key of Object.keys(obj)) {
    if (!expected.includes(key)) throw disclosureError(`${at}лишнее поле «${key}».`);
  }
  for (const key of expected) {
    if (!(key in obj)) throw disclosureError(`${at}отсутствует поле «${key}».`);
  }
}

function fieldPath(objectName: string, key: string): string {
  return objectName ? `${objectName}.${key}` : key;
}

function readDisclosureString(obj: Record<string, unknown>, key: string, objectName = ""): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw disclosureError(`${fieldPath(objectName, key)}: ожидается строка.`);
  }
  return value;
}

function readDisclosureBase64Url(
  obj: Record<string, unknown>,
  key: string,
  objectName = "",
): string {
  const value = readDisclosureString(obj, key, objectName);
  if (!FRANKING_DISCLOSURE_BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw disclosureError(`${fieldPath(objectName, key)}: не base64url без паддинга.`);
  }
  return value;
}

function readNullableDisclosureBase64Url(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  return obj[key] === null ? null : readDisclosureBase64Url(obj, key);
}

function readDisclosureUuid(obj: Record<string, unknown>, key: string): string {
  const value = readDisclosureString(obj, key);
  if (!FRANKING_DISCLOSURE_UUID_RE.test(value)) {
    throw disclosureError(`${key}: ожидается UUID в форме 8-4-4-4-12.`);
  }
  return value;
}

function readDisclosureReceipt(raw: unknown): ServerFrankReceiptV1 | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw disclosureError("serverFrankReceipt: ожидается объект или null.");
  }
  const receipt = raw as Record<string, unknown>;
  assertExactKeys(receipt, FRANKING_RECEIPT_KEYS, "serverFrankReceipt");
  return {
    signatureBase64Url: readDisclosureBase64Url(receipt, "signatureBase64Url", "serverFrankReceipt"),
    serverFrankingKeyId: readDisclosureString(receipt, "serverFrankingKeyId", "serverFrankReceipt"),
    serverReceivedAt: readDisclosureString(receipt, "serverReceivedAt", "serverFrankReceipt"),
  };
}

/**
 * Обратная к `encodeFrankingComplaintDisclosureV1` (franking.md §4.4).
 *
 * Частично заполненный кортеж наружу не попадает по построению: единственный
 * объект результата собирается последним выражением функции, поэтому любая
 * непройденная проверка бросает раньше, чем появляется что отдать.
 */
export function decodeFrankingComplaintDisclosureV1(
  bytes: Uint8Array,
): FrankingComplaintDisclosureV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw disclosureError("байты не разбираются как JSON (обрезанный или повреждённый кортеж).");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw disclosureError("ожидается JSON-объект.");
  }
  const obj = parsed as Record<string, unknown>;

  // Версия — до проверки набора полей: у чужой схемы «лишние поля» ожидаемы,
  // и сообщать надо про версию, а не про них.
  if (!("v" in obj)) throw disclosureError("нет поля версии «v»; поддерживается только v=1.");
  if (obj.v !== 1) {
    throw disclosureError(`версия v=${JSON.stringify(obj.v)} не поддерживается; ожидается v=1.`);
  }
  assertExactKeys(obj, FRANKING_DISCLOSURE_KEYS, "");

  const serverFrankReceipt = readDisclosureReceipt(obj.serverFrankReceipt);

  return {
    v: 1,
    plaintextUtf8Base64Url: readDisclosureBase64Url(obj, "plaintextUtf8Base64Url"),
    frankingKeyBase64Url: readNullableDisclosureBase64Url(obj, "frankingKeyBase64Url"),
    frankTagBase64Url: readNullableDisclosureBase64Url(obj, "frankTagBase64Url"),
    serverFrankReceipt,
    messageUuid: readDisclosureUuid(obj, "messageUuid"),
    persistedMessageUuid: readDisclosureUuid(obj, "persistedMessageUuid"),
    conversationUuid: readDisclosureUuid(obj, "conversationUuid"),
    senderUserUuid: readDisclosureUuid(obj, "senderUserUuid"),
    senderDeviceUuid: readDisclosureUuid(obj, "senderDeviceUuid"),
    receiverUserUuid: readDisclosureUuid(obj, "receiverUserUuid"),
    createdAt: readDisclosureString(obj, "createdAt"),
  };
}

/**
 * Plaintext кортежа → блоки для показа ревьюеру.
 *
 * Нормализация — ровно та же функция, что на пути расшифровки получателя
 * (`normalizeFscpMessagePlaintext`), включая placeholder `kind: "unknown"`:
 * ревьюер обязан видеть то же сообщение, что видел жалобщик, а не свою версию
 * разбора. Паддинг (`pad`, FSCP.md errata-5) при этом снимается вместе с прочими
 * неизвестными top-level полями — в блоки он не попадает.
 *
 * Медиа-блоки отдаются как есть, с `assetUuid` и AES-ключами вложений (§4.6):
 * выкачивание и расшифровка вложений — задача потребителя, не FSCP.
 */
export function parseFrankedPlaintextV1(plaintextUtf8: Uint8Array): FscpMessagePlaintext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintextUtf8));
  } catch {
    throw disclosureError("plaintext кортежа не разбирается как JSON.");
  }
  return normalizeFscpMessagePlaintext(parsed);
}

/** Чего не хватает в кортеже, чтобы жалоба вообще была проверяемой (§4.7 Unverifiable). */
export type FrankingComplaintMissingFieldV1 =
  | "frankingKeyBase64Url"
  | "frankTagBase64Url"
  | "serverFrankReceipt";

export type FrankingComplaintVerdictV1 =
  | FrankVerifyResultV1
  | { ok: false; reason: "unverifiable"; missing: readonly FrankingComplaintMissingFieldV1[] };

export type FrankingComplaintReviewV1 = {
  disclosure: FrankingComplaintDisclosureV1;
  /** Кортеж §4.4; `null`, когда жалоба unverifiable и проверять нечего. */
  tuple: FrankComplaintTupleV1 | null;
  /** Блоки сообщения; `null`, если жалобщик приложил байты, не являющиеся plaintext FSCP. */
  plaintext: FscpMessagePlaintext | null;
  verification: FrankingComplaintVerdictV1;
};

export type FrankingComplaintBundleReviewV2 = {
  bundle: FrankingComplaintBundleV2;
  /** Один независимый кортеж, plaintext и вердикт на каждый элемент bundle. */
  messages: FrankingComplaintReviewV1[];
};

type FrankingReviewSodium = FrankingDisclosureSodium &
  FscpBase64Sodium &
  Pick<SodiumModule, "crypto_sign_verify_detached">;

/** Пустая и пробельная строка — то же, что отсутствие поля (как в plaintext-разборе конверта). */
function nonEmptyOrNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function reviewFrankingComplaintRecordV1(
  sodium: FrankingReviewSodium,
  disclosure: FrankingComplaintDisclosureV1,
  serverFrankingPublicKey: Uint8Array,
): FrankingComplaintReviewV1 {
  const plaintextUtf8 = decodeFscpBase64Url(sodium, disclosure.plaintextUtf8Base64Url);
  // Нечитаемые байты не должны прятать вердикт: жалобщик мог приложить мусор,
  // и ревьюеру важнее увидеть «не верифицируется», чем провал разбора.
  let plaintext: FscpMessagePlaintext | null;
  try {
    plaintext = parseFrankedPlaintextV1(plaintextUtf8);
  } catch {
    plaintext = null;
  }

  const frankingKeyBase64Url = nonEmptyOrNull(disclosure.frankingKeyBase64Url);
  const frankTagBase64Url = nonEmptyOrNull(disclosure.frankTagBase64Url);
  const receipt = disclosure.serverFrankReceipt;
  const missing: FrankingComplaintMissingFieldV1[] = [];
  if (!frankingKeyBase64Url) missing.push("frankingKeyBase64Url");
  if (!frankTagBase64Url) missing.push("frankTagBase64Url");
  if (!receipt) missing.push("serverFrankReceipt");
  if (!frankingKeyBase64Url || !frankTagBase64Url || !receipt) {
    // Жалоба на untagged v1 (§1 «никакой ретроактивности») — policy-решение жюри,
    // а не крипто-доказательство.
    return {
      disclosure,
      tuple: null,
      plaintext,
      verification: { ok: false, reason: "unverifiable", missing },
    };
  }

  const tuple: FrankComplaintTupleV1 = {
    plaintextUtf8,
    frankingKey: decodeFscpBase64Url(sodium, frankingKeyBase64Url),
    frankTag: decodeFscpBase64Url(sodium, frankTagBase64Url),
    receipt,
    // §4.7: в commitInput идёт wire-`messageUuid`, а не строка БД (`persistedMessageUuid`).
    commit: {
      conversationUuid: disclosure.conversationUuid,
      messageUuid: disclosure.messageUuid,
      senderUserUuid: disclosure.senderUserUuid,
      senderDeviceUuid: disclosure.senderDeviceUuid,
      receiverUserUuid: disclosure.receiverUserUuid,
      createdAt: disclosure.createdAt,
    },
  };
  const receiptSignature = decodeFscpBase64Url(sodium, receipt.signatureBase64Url);

  // Длины ключа и подписи — часть кортежа жалобщика, а не окружения: недостающие
  // байты означают, что шаг §4.4 не сходится, и это вердикт, а не исключение
  // libsodium (иначе недобросовестный жалобщик ронял бы UI ревьюера).
  if (tuple.frankingKey.length !== 32) {
    return { disclosure, tuple, plaintext, verification: { ok: false, reason: "commit-mismatch" } };
  }
  if (receiptSignature.length !== FRANKING_RECEIPT_SIGNATURE_BYTES) {
    return {
      disclosure,
      tuple,
      plaintext,
      verification: { ok: false, reason: "receipt-signature-invalid" },
    };
  }

  return {
    disclosure,
    tuple,
    plaintext,
    verification: verifyFrankedMessageV1({
      sodium,
      tuple,
      receiptSignature,
      serverFrankingPublicKey,
    }),
  };
}

/**
 * Единственный вызов, который нужен ревьюеру (franking.md §4.4, §4.7):
 * `sealed` + `reportContentKey` + серверный публичный ключ → кортеж, блоки, вердикт.
 *
 * В сеть не ходит и ничего не выкачивает: `reportContentKey` разворачивает
 * `unwrapReportContentKeyV1`, публичный ключ берётся из transparency log серверной
 * ручкой, вложения качает потребитель. Проверка — существующий `verifyFrankedMessageV1`,
 * новой крипты здесь нет.
 */
export function reviewFrankingComplaintDisclosureV1(
  sodium: FrankingReviewSodium,
  params: {
    /** Сырые байты `nonce || ciphertext` или их base64url (`disclosureCiphertext` из API). */
    sealed: Uint8Array | string;
    reportContentKey: Uint8Array;
    serverFrankingPublicKey: Uint8Array;
  },
): FrankingComplaintReviewV1 {
  const sealed =
    typeof params.sealed === "string" ? decodeFscpBase64Url(sodium, params.sealed) : params.sealed;
  const disclosure = decodeFrankingComplaintDisclosureV1(
    openFrankingDisclosureV1(sodium, sealed, params.reportContentKey),
  );
  return reviewFrankingComplaintRecordV1(sodium, disclosure, params.serverFrankingPublicKey);
}

/**
 * Открывает один seal bundle и проверяет каждый вложенный v1-кортеж независимо.
 * Совокупного `verification` намеренно нет: один unverifiable-элемент нельзя
 * замаскировать успехом остальных сообщений.
 */
export function reviewFrankingComplaintBundleV2(
  sodium: FrankingReviewSodium,
  params: {
    sealed: Uint8Array | string;
    reportContentKey: Uint8Array;
    serverFrankingPublicKey: Uint8Array;
  },
): FrankingComplaintBundleReviewV2 {
  const sealed =
    typeof params.sealed === "string" ? decodeFscpBase64Url(sodium, params.sealed) : params.sealed;
  const bundle = decodeFrankingComplaintBundleV2(
    openFrankingDisclosureV1(sodium, sealed, params.reportContentKey),
  );
  return {
    bundle,
    messages: bundle.messages.map((disclosure) =>
      reviewFrankingComplaintRecordV1(sodium, disclosure, params.serverFrankingPublicKey),
    ),
  };
}
