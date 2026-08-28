import {
  FRANKING_NO_DEVICE_WRAP_MESSAGE,
  isApiRequestError,
} from "@flora/client-core/api";
import type {
  FrankingReportMetaDto,
  FrankingReportStatus,
  FrankingReviewerResult,
} from "@flora/client-core/contracts";
import type { ModerationFrankingDeps } from "./moderationQueue";

export type AnketaDisclosureIntent = "idle" | "waiting" | "unlock" | "fetch";

export type AnketaDisclosureView =
  | { phase: "idle" }
  | { phase: "waiting" }
  | { phase: "unlock" }
  | { phase: "loading" }
  | { phase: "ready"; result: FrankingReviewerResult }
  | { phase: "mismatch"; message: string }
  | { phase: "error"; message: string };

export const DISCLOSURE_UNLOCK_COPY = "Сначала разблокируйте ключи";
export const DISCLOSURE_WAITING_COPY =
  "Нет viewer-wrap на этот аккаунт. Запечатанное сообщение есть — ожидается раскрытие от жалобщика.";

export function canFetchFrankingDisclosure(status: FrankingReportStatus): boolean {
  return status === "claimed" || status === "claimedAwaitingDisclosure";
}

export function resolveAnketaDisclosureIntent(
  status: FrankingReportStatus,
  keysReady: boolean,
): AnketaDisclosureIntent {
  if (!canFetchFrankingDisclosure(status)) return "idle";
  if (!keysReady) return "unlock";
  return "fetch";
}

/** Sync presentation of anketa disclosure; fetch result is keyed so stale loads do not show. */
export function presentAnketaDisclosureView(input: {
  intent: AnketaDisclosureIntent;
  bootstrapLoading: boolean;
  keysReady: boolean;
  fetched: { key: string; view: AnketaDisclosureView } | null;
  fetchKey: string;
}): AnketaDisclosureView {
  if (input.intent === "idle") return { phase: "idle" };
  if (input.intent === "unlock" || !input.keysReady) {
    return input.bootstrapLoading ? { phase: "loading" } : { phase: "unlock" };
  }
  if (input.fetched?.key === input.fetchKey) return input.fetched.view;
  return { phase: "loading" };
}

function isNoWrapDisclosureForbidden(error: { code?: string; message: string }): boolean {
  if (error.code === "no_wrap") return true;
  return error.message.includes("viewer-wrap");
}

export function classifyDisclosureLoadError(error: unknown): "waiting" | "mismatch" | "error" {
  if (isApiRequestError(error) && error.status === 403) {
    return isNoWrapDisclosureForbidden(error) ? "waiting" : "error";
  }
  if (error instanceof Error && error.message === FRANKING_NO_DEVICE_WRAP_MESSAGE) {
    return "mismatch";
  }
  return "error";
}

export async function loadAnketaDisclosure(params: {
  deps: ModerationFrankingDeps;
  report: FrankingReportMetaDto;
  viewerUserUuid: string | null;
  agreementPrivateKey: Uint8Array;
}): Promise<AnketaDisclosureView> {
  const persistedMessageUuid = params.report.persistedMessageUuid.trim();
  const viewerUserUuid = params.viewerUserUuid?.trim() ?? "";
  if (!persistedMessageUuid || !viewerUserUuid) {
    return { phase: "error", message: "Нет persistedMessageUuid заявки franking." };
  }
  try {
    const result = await params.deps.reviewReport({
      reportUuid: params.report.reportUuid,
      persistedMessageUuid,
      viewerUserUuid,
      agreementPrivateKey: params.agreementPrivateKey,
    });
    return { phase: "ready", result };
  } catch (error: unknown) {
    const kind = classifyDisclosureLoadError(error);
    if (kind === "waiting") {
      return { phase: "waiting" };
    }
    if (kind === "mismatch") {
      return {
        phase: "mismatch",
        message: error instanceof Error ? error.message : FRANKING_NO_DEVICE_WRAP_MESSAGE,
      };
    }
    return {
      phase: "error",
      message: error instanceof Error ? error.message : "Не удалось раскрыть сообщение.",
    };
  }
}
