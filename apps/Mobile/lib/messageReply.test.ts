import { describe, expect, it } from "vitest";

import {
  canReplyToMessage,
  replyDraftFromMessage,
  replyPreviewFromMessage,
  type MessageReplySource,
} from "./messageReply";
import type { FscpImageBlock, FscpVoiceBlock } from "@flora/client-core/fscp";

function message(
  partial: Partial<MessageReplySource> & Pick<MessageReplySource, "messageUuid" | "isFromMe">,
): MessageReplySource {
  return {
    text: "",
    previewText: "",
    imageBlocks: [],
    decryptState: "ok",
    ...partial,
  };
}

describe("replyPreviewFromMessage", () => {
  it("prefers previewText, then body text", () => {
    expect(
      replyPreviewFromMessage({
        previewText: "  привет  ",
        text: "other",
        imageBlocks: [],
      }),
    ).toBe("привет");
    expect(
      replyPreviewFromMessage({
        previewText: "  ",
        text: "подпись",
        imageBlocks: [],
      }),
    ).toBe("подпись");
  });

  it("falls back to media labels", () => {
    expect(
      replyPreviewFromMessage({
        previewText: "",
        text: "",
        imageBlocks: [{ kind: "image", assetUuid: "a", contentType: "image/jpeg" }] as FscpImageBlock[],
      }),
    ).toBe("Фото");
    expect(
      replyPreviewFromMessage({
        previewText: "",
        text: "",
        imageBlocks: [],
        voiceBlock: { kind: "voice", assetUuid: "v" } as FscpVoiceBlock,
      }),
    ).toBe("Голосовое сообщение");
  });
});

describe("canReplyToMessage", () => {
  it("allows own messages the same as peer messages", () => {
    expect(
      canReplyToMessage(
        message({ messageUuid: "me", isFromMe: true, previewText: "своё" }),
      ),
    ).toBe(true);
    expect(
      canReplyToMessage(
        message({ messageUuid: "them", isFromMe: false, previewText: "чужое" }),
      ),
    ).toBe(true);
  });

  it("blocks decrypting, failed, empty, and in-flight rows", () => {
    expect(
      canReplyToMessage(
        message({ messageUuid: "a", isFromMe: true, decryptState: "decrypting", previewText: "x" }),
      ),
    ).toBe(false);
    expect(
      canReplyToMessage(message({ messageUuid: "a", isFromMe: true, sendStatus: "sending", previewText: "x" })),
    ).toBe(false);
    expect(canReplyToMessage(message({ messageUuid: "a", isFromMe: true }))).toBe(false);
  });
});

describe("replyDraftFromMessage", () => {
  it("labels own messages as Вы", () => {
    expect(
      replyDraftFromMessage(
        message({ messageUuid: "own", isFromMe: true, previewText: "черновик" }),
        "Аня",
      ),
    ).toEqual({
      messageUuid: "own",
      authorDisplayName: "Вы",
      preview: "черновик",
    });
  });
});
