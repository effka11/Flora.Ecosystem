import type { FscpImageBlock, FscpMessageBlock, FscpMessagePlaintext, FscpVoiceBlock } from "./envelope.js";

export function formatPhotoPreviewCount(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "Фото";
  return `${count} фото`;
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

export function messagePlaintextFromText(
  body: string,
  clientCreatedAt = new Date().toISOString(),
): FscpMessagePlaintext {
  return {
    type: "blocks",
    version: 1,
    blocks: [{ kind: "text", body }],
    clientCreatedAt,
  };
}

export function messagePlaintextFromBlocks(
  blocks: FscpMessageBlock[],
  clientCreatedAt = new Date().toISOString(),
): FscpMessagePlaintext {
  return {
    type: "blocks",
    version: 1,
    blocks,
    clientCreatedAt,
  };
}

export function getImageBlocksFromPlaintext(plain: FscpMessagePlaintext): FscpImageBlock[] {
  return plain.blocks.filter((block): block is FscpImageBlock => block.kind === "image");
}

export function getVoiceBlocksFromPlaintext(plain: FscpMessagePlaintext): FscpVoiceBlock[] {
  return plain.blocks.filter((block): block is FscpVoiceBlock => block.kind === "voice");
}

export function getPrimaryVoiceBlock(plain: FscpMessagePlaintext): FscpVoiceBlock | undefined {
  return plain.blocks.find((block): block is FscpVoiceBlock => block.kind === "voice");
}

export function extractTextFromPlaintext(plain: FscpMessagePlaintext): string {
  return plain.blocks
    .filter((b): b is { kind: "text"; body: string } => b.kind === "text")
    .map((b) => b.body)
    .join("\n");
}
