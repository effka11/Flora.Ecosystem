import {
  assembleFrankingReportV1,
  decodeFscpBase64Url,
  decryptFscpWireEnvelopeDetailed,
  getSodium,
  isFscpWirePayload,
  frankingReportBlockedByMissingReceipt,
  type FrankingWrapTargetV1,
  type FscpLocalMaterial,
} from "@flora/fscp";
import {
  type FrankingReportCategory,
  type FrankingReportMetaDto,
  type FrankingWrapTargetDto,
  type ServerFrankReceiptDto,
} from "../contracts/franking.js";
import { FRANKING_MISSING_RECEIPT_MESSAGE } from "../display/frankingReport.js";
import { apiCreateFrankingReport, apiGetFrankingWrapTargets } from "./franking.js";
import { selectFrankingSubmitWrapTargets } from "./frankingSubmitWraps.js";

export { selectFrankingSubmitWrapTargets, FRANKING_MAX_VIEWER_ACCOUNTS } from "./frankingSubmitWraps.js";

function decodeWrapTarget(
  sodium: Awaited<ReturnType<typeof getSodium>>,
  item: FrankingWrapTargetDto,
): FrankingWrapTargetV1 | null {
  try {
    const agreementPublicKey = decodeFscpBase64Url(sodium, item.agreementPublicKeyBase64Url);
    if (agreementPublicKey.length !== 32) return null;
    return {
      userUuid: item.userUuid,
      deviceUuid: item.deviceUuid,
      agreementPublicKey,
    };
  } catch {
    return null;
  }
}

/** Submit-time wraps are optional (franking.md §4.7): fetch failure → empty roster. */
export async function loadFrankingSubmitWrapRoster(): Promise<{
  ownItems: FrankingWrapTargetDto[];
  reviewerItems: FrankingWrapTargetDto[];
}> {
  try {
    const roster = await apiGetFrankingWrapTargets();
    return {
      ownItems: roster.ownItems,
      reviewerItems: roster.reviewerRosterReady ? roster.items : [],
    };
  } catch {
    return { ownItems: [], reviewerItems: [] };
  }
}

export async function submitFrankingMessageReport(params: {
  category: FrankingReportCategory;
  persistedMessageUuid: string;
  wire: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
  serverFrankReceipt: ServerFrankReceiptDto | null;
  frankTagBase64Url: string | null;
  localMaterial?: FscpLocalMaterial;
}): Promise<FrankingReportMetaDto> {
  const wire = params.wire.trim();
  if (!isFscpWirePayload(wire)) {
    throw new Error("Жалобу можно подать только на расшифрованное FSCP-сообщение.");
  }

  const sodium = await getSodium();
  const opened = await decryptFscpWireEnvelopeDetailed({
    wire,
    viewerUserUuid: params.viewerUserUuid,
    agreementPrivateKey: params.agreementPrivateKey,
  });

  const envelopeTag =
    opened.envelope.frankTagBase64Url?.trim() || params.frankTagBase64Url?.trim() || null;
  if (
    frankingReportBlockedByMissingReceipt({
      frankTagBase64Url: envelopeTag,
      hasServerFrankReceipt: Boolean(params.serverFrankReceipt),
    })
  ) {
    throw new Error(FRANKING_MISSING_RECEIPT_MESSAGE);
  }

  const accusedUserUuid = opened.envelope.senderUserUuid;
  const wrapTargets: FrankingWrapTargetV1[] = [];
  const seen = new Set<string>();
  const pushTarget = (target: FrankingWrapTargetV1) => {
    const key = `${target.userUuid.toLowerCase()}|${target.deviceUuid.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    wrapTargets.push(target);
  };

  const { ownItems, reviewerItems } = await loadFrankingSubmitWrapRoster();

  const selected = selectFrankingSubmitWrapTargets({
    ownItems,
    reviewerItems,
    reporterUserUuid: params.viewerUserUuid,
    accusedUserUuid,
  });
  for (const item of [...selected.backup, ...selected.viewers]) {
    const decoded = decodeWrapTarget(sodium, item);
    if (decoded) pushTarget(decoded);
  }
  // Wrap только на цели GET server-key: Active `user_device_keys` и/или
  // опубликованный identity key (`user_e2e_keys`, bootstrap v1).
  // `deviceUuidFromServer` на клиенте часто bootstrap-сентинел
  // (`00000000-0000-4000-8000-000000000002`) или устаревший UUID — сервер
  // отвечает 400 «не принадлежит активному устройству».

  const assembled = assembleFrankingReportV1(sodium, {
    complaint: {
      plaintextUtf8: opened.plaintextUtf8,
      frankingKeyBase64Url: opened.frankingKeyBase64Url,
      frankTagBase64Url: envelopeTag,
      serverFrankReceipt: params.serverFrankReceipt,
      messageUuid: opened.envelope.messageUuid,
      persistedMessageUuid: params.persistedMessageUuid,
      conversationUuid: opened.envelope.conversationUuid,
      senderUserUuid: opened.envelope.senderUserUuid,
      senderDeviceUuid: opened.envelope.senderDeviceUuid,
      receiverUserUuid: params.viewerUserUuid,
      createdAt: opened.envelope.createdAt,
    },
    wrapTargets,
  });

  return apiCreateFrankingReport({
    persistedMessageUuid: params.persistedMessageUuid,
    category: params.category,
    disclosureCiphertext: assembled.disclosureCiphertext,
    wraps: assembled.wraps,
  });
}
