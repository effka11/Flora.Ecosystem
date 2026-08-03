import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  formatGroupListPreview,
  GROUP_LIST_UNKNOWN_SENDER_LABEL,
} from "./groupListPreview.js";

describe("formatGroupListPreview", () => {
  it("prefixes own messages with Вы", () => {
    assert.equal(
      formatGroupListPreview({ preview: "привет", isFromMe: true }),
      "Вы: привет",
    );
  });

  it("prefixes peer messages with display name", () => {
    assert.equal(
      formatGroupListPreview({
        preview: "ок",
        isFromMe: false,
        senderDisplayName: "Анна",
      }),
      "Анна: ок",
    );
  });

  it("uses Участник when display name is empty", () => {
    assert.equal(
      formatGroupListPreview({
        preview: "ок",
        isFromMe: false,
        senderDisplayName: "  ",
      }),
      `${GROUP_LIST_UNKNOWN_SENDER_LABEL}: ок`,
    );
  });

  it("keeps decrypting stub without sender prefix", () => {
    assert.equal(
      formatGroupListPreview({
        preview: "Расшифровка…",
        isFromMe: false,
        senderDisplayName: "Анна",
      }),
      "Расшифровка…",
    );
  });
});
