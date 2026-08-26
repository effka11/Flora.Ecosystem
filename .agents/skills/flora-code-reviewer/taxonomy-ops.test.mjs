import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

function idsFromTaxonomy(md) {
  const ids = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\| `([a-z_]+)` \|/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

function idsFromPatchOps(md) {
  const ids = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^- `([a-z_]+)` —/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

test("patch-ops covers every taxonomy hole_id and nothing extra", () => {
  const taxonomy = readFileSync(join(here, "taxonomy.md"), "utf8");
  const patchOps = readFileSync(
    join(here, "..", "flora-code-reviser", "patch-ops.md"),
    "utf8",
  );
  const taxIds = idsFromTaxonomy(taxonomy);
  const opIds = idsFromPatchOps(patchOps);
  assert.ok(taxIds.length >= 15, `taxonomy too small: ${taxIds.length}`);
  assert.deepEqual(
    [...opIds].sort(),
    [...taxIds].sort(),
    `taxonomy: ${taxIds.join(", ")}\nops: ${opIds.join(", ")}`,
  );
});
