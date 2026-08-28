import assert from "node:assert/strict";
import test from "node:test";
import { GOV_FSCP_VAULT_DB } from "./sealedVault";
import { GOV_FSCP_PROFILE_PREFIX } from "./storage";

test("Gov FSCP vault keys stay on the civic flora.gov.fscp. prefix", () => {
  assert.ok(GOV_FSCP_PROFILE_PREFIX.startsWith("flora.gov.fscp."));
  assert.equal(GOV_FSCP_PROFILE_PREFIX, "flora.gov.fscp.profile.v1.");
  assert.notEqual(GOV_FSCP_PROFILE_PREFIX.startsWith("flora.fscp.profile."), true);
  assert.equal(GOV_FSCP_VAULT_DB, "flora-gov-fscp-vault");
});
