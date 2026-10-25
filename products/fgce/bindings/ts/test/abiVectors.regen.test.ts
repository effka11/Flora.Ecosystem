import { writeFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { buildDecodingFile, buildEncodingFile } from "./abiVectors";

// Regeneration is deliberate, like the conformance fixtures:
//   FGCE_ABI_VECTORS_REGEN=1 npm test
const regen = process.env.FGCE_ABI_VECTORS_REGEN === "1" ? it : it.skip;

describe("ABI vector regeneration", () => {
  regen("writes tests/abi-vectors from the reference encoder", async () => {
    const base = new URL("../../../tests/abi-vectors/", import.meta.url);
    await writeFile(
      new URL("encoding.json", base),
      `${JSON.stringify(buildEncodingFile(), null, 2)}\n`,
    );
    await writeFile(
      new URL("decoding.json", base),
      `${JSON.stringify(buildDecodingFile(), null, 2)}\n`,
    );
  });
});
