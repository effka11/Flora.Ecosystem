import type { FscpImageBlock, FscpMessageBlock, FscpMessagePlaintext, FscpVoiceBlock } from "@/lib/fscp";
import { floraNewUuid } from "@/lib/floraUuid";

export type DraftTextBlock = {
  id: string;
  kind: "text";
  body: string;
};

export type DraftVoiceBlock = {
  id: string;
  kind: "voice";
  blob: Blob;
  objectUrl: string;
  durationMs: number;
  waveform: number[];
  contentType: string;
};

export type DraftMessageBlock = DraftTextBlock | DraftVoiceBlock;

export function newDraftTextBlock(body = ""): DraftTextBlock {
  return {
    id: floraNewUuid(),
    kind: "text",
    body,
  };
}

export function blocksHaveSendableContent(blocks: DraftMessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "voice" || block.body.trim().length > 0);
}

export function getImageBlocksFromPayload(payload: FscpMessagePlaintext): FscpImageBlock[] {
  return payload.blocks.filter((block): block is FscpImageBlock => block.kind === "image");
}

export function messagePlaintextFromText(body: string, clientCreatedAt = new Date().toISOString()): FscpMessagePlaintext {
  return {
    type: "blocks",
    version: 1,
    blocks: [{ kind: "text", body }],
    clientCreatedAt,
  };
}

export function plaintextFromBlocks(blocks: FscpMessageBlock[], clientCreatedAt = new Date().toISOString()): FscpMessagePlaintext {
  return {
    type: "blocks",
    version: 1,
    blocks,
    clientCreatedAt,
  };
}

export function formatPhotoPreviewCount(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "Фото";
  return `${count} фото`;
}

function collapsePreviewPhotoParts(parts: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    if (parts[i] === "Фото") {
      let count = 0;
      while (i < parts.length && parts[i] === "Фото") {
        count++;
        i++;
      }
      out.push(formatPhotoPreviewCount(count));
    } else {
      out.push(parts[i]!);
      i++;
    }
  }
  return out;
}

/** Сжимает повторяющиеся «Фото» в уже собранной строке превью (legacy / server). */
export function collapsePhotoPreviewLabels(preview: string): string {
  if (!preview.includes("Фото")) return preview;
  return collapsePreviewPhotoParts(preview.split(" · ")).join(" · ");
}

export function messageBlocksToPreview(blocks: FscpMessageBlock[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (block.kind === "text") {
      const body = block.body.trim();
      if (body) parts.push(body);
      i++;
    } else if (block.kind === "image") {
      let count = 0;
      while (i < blocks.length && blocks[i]!.kind === "image") {
        count++;
        i++;
      }
      parts.push(formatPhotoPreviewCount(count));
    } else if (block.kind === "video") {
      parts.push("Видео");
      i++;
    } else {
      parts.push("Голосовое сообщение");
      i++;
    }
  }
  return parts.join(" · ");
}

export function plaintextToPreview(plain: FscpMessagePlaintext): string {
  return messageBlocksToPreview(plain.blocks);
}

export function plainLegacyToBlocks(body: string): FscpMessagePlaintext {
  return messagePlaintextFromText(body);
}

export function isVoiceOnlyPayload(payload: FscpMessagePlaintext): boolean {
  return payload.blocks.length === 1 && payload.blocks[0]?.kind === "voice";
}

export function isTextOnlyPayload(payload: FscpMessagePlaintext): boolean {
  return payload.blocks.length === 1 && payload.blocks[0]?.kind === "text";
}

export function getVoiceBlockFromPayload(payload: FscpMessagePlaintext) {
  const block = payload.blocks[0];
  return block?.kind === "voice" ? block : null;
}

/** Собирает FSCP-блоки из черновика; для voice нужен уже известный assetUuid (после upload или dev id). */
export function draftBlocksToFscpBlocks(
  draftBlocks: DraftMessageBlock[],
  voiceAssetByDraftId: Record<
    string,
    Pick<FscpVoiceBlock, "assetUuid" | "durationMs" | "waveform" | "contentType" | "encryption">
  >
): FscpMessageBlock[] {
  const out: FscpMessageBlock[] = [];
  for (const block of draftBlocks) {
    if (block.kind === "text") {
      if (block.body.trim().length > 0) out.push({ kind: "text", body: block.body });
      continue;
    }
    const voice = voiceAssetByDraftId[block.id];
    if (!voice) continue;
    out.push({
      kind: "voice",
      assetUuid: voice.assetUuid,
      durationMs: voice.durationMs,
      waveform: voice.waveform,
      contentType: voice.contentType,
      encryption: voice.encryption,
    });
  }
  return out;
}
