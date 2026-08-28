import assert from "node:assert/strict";
import test from "node:test";
import { labelFrankingReviewedBlock, labelFrankingVerification } from "./moderationLabels";

test("reviewed text block is the message body, not a crypto dump", () => {
  assert.equal(labelFrankingReviewedBlock({ kind: "text", body: "wqqeqwe" }), "wqqeqwe");
  assert.equal(
    labelFrankingReviewedBlock({
      kind: "image",
      assetUuid: "a",
      contentType: "image/jpeg",
      encryption: { algorithm: "aes-gcm", keyBase64Url: "k", nonceBase64Url: "n" },
    }),
    "Фото",
  );
});

test("verification label stays human-readable", () => {
  assert.equal(labelFrankingVerification("unverifiable"), "Неверифицируемая");
  assert.equal(labelFrankingVerification("verifiable"), "Верифицируемая");
});
