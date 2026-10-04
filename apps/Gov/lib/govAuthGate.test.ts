import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError } from "@flora/client-core/api";
import type { EmailChangeBeginResult, SecurityStatusDto } from "@flora/client-core/auth";
import {
  completeEmailVerification,
  decideGovGate,
  type GovEmailVerificationDeps,
} from "./govAuthGate";

const CHANGE_TOKEN = "change-token-1";
const CHANGE_EXPIRES_AT = "2026-08-17T21:10:00.000Z";
const NEW_EMAIL = "citizen@flora.test";
const PASSWORD = "correct horse battery staple";
const OTP = "123456";

/** Verbatim text of the Auth response when the address is already on the account. */
const SAME_ADDRESS_ERROR = "Новый email совпадает с текущим.";

function security(emailVerified: boolean): SecurityStatusDto {
  return { twoFactorEnabled: false, emailVerified, phoneVerified: false };
}

type RecordedCall = { name: string; args: unknown[] };

function recordingDeps(overrides: {
  begin?: (password: string, newEmail: string) => Promise<EmailChangeBeginResult>;
  confirm?: (changeToken: string, code: string) => Promise<string>;
  security?: () => Promise<SecurityStatusDto>;
}) {
  const calls: RecordedCall[] = [];
  const deps: GovEmailVerificationDeps = {
    async beginEmailChange(password, newEmail) {
      calls.push({ name: "beginEmailChange", args: [password, newEmail] });
      if (overrides.begin) return overrides.begin(password, newEmail);
      return { changeToken: CHANGE_TOKEN, expiresAt: CHANGE_EXPIRES_AT };
    },
    async confirmEmailChange(changeToken, code) {
      calls.push({ name: "confirmEmailChange", args: [changeToken, code] });
      if (overrides.confirm) return overrides.confirm(changeToken, code);
      return NEW_EMAIL;
    },
    async getSecurityStatus() {
      calls.push({ name: "getSecurityStatus", args: [] });
      if (overrides.security) return overrides.security();
      return security(true);
    },
  };
  return { deps, calls };
}

test("without an access token the gate sends the visitor to the login page", () => {
  assert.equal(decideGovGate({ hasAccessToken: false, security: null }), "login");
  assert.equal(decideGovGate({ hasAccessToken: false, security: security(true) }), "login");
});

test("an unverified email holds the session at the wall", () => {
  assert.equal(decideGovGate({ hasAccessToken: true, security: security(false) }), "wall");
});

test("a verified email opens the civic shell", () => {
  assert.equal(decideGovGate({ hasAccessToken: true, security: security(true) }), "shell");
});

test("an unknown security status fails closed to the wall", () => {
  assert.equal(decideGovGate({ hasAccessToken: true, security: null }), "wall");
});

test("change then confirm then a fresh security read opens the gate", async () => {
  const { deps, calls } = recordingDeps({ security: async () => security(true) });

  const outcome = await completeEmailVerification(deps, {
    password: PASSWORD,
    newEmail: NEW_EMAIL,
    code: OTP,
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["beginEmailChange", "confirmEmailChange", "getSecurityStatus"],
  );
  assert.deepEqual(calls[0]?.args, [PASSWORD, NEW_EMAIL]);
  assert.deepEqual(calls[1]?.args, [CHANGE_TOKEN, OTP]);

  assert.equal(outcome.kind, "verified");
  if (outcome.kind !== "verified") return;
  assert.equal(outcome.email, NEW_EMAIL);
  assert.equal(outcome.decision, "shell");
  assert.equal(outcome.security.emailVerified, true);
});

test("a confirmed change that Auth still reports unverified keeps the gate closed", async () => {
  const { deps } = recordingDeps({ security: async () => security(false) });

  const outcome = await completeEmailVerification(deps, {
    password: PASSWORD,
    newEmail: NEW_EMAIL,
    code: OTP,
  });

  assert.equal(outcome.kind, "verified");
  if (outcome.kind !== "verified") return;
  assert.equal(outcome.decision, "wall");
});

test("the same-address rejection reaches the caller as the server wrote it", async () => {
  const { deps, calls } = recordingDeps({
    begin: async () => {
      throw new ApiRequestError(400, SAME_ADDRESS_ERROR);
    },
  });

  const outcome = await completeEmailVerification(deps, {
    password: PASSWORD,
    newEmail: NEW_EMAIL,
    code: OTP,
  });

  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.stage, "begin");
  assert.equal(outcome.message, SAME_ADDRESS_ERROR);
  assert.equal(outcome.pending, null);

  assert.deepEqual(
    calls.map((call) => call.name),
    ["beginEmailChange"],
  );
  assert.equal(decideGovGate({ hasAccessToken: true, security: security(false) }), "wall");
});

test("without a code the change is only begun and the dev code is passed through", async () => {
  const { deps, calls } = recordingDeps({
    begin: async () => ({
      changeToken: CHANGE_TOKEN,
      expiresAt: CHANGE_EXPIRES_AT,
      devVerificationCode: OTP,
    }),
  });

  const outcome = await completeEmailVerification(deps, {
    password: PASSWORD,
    newEmail: NEW_EMAIL,
    code: "   ",
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["beginEmailChange"],
  );
  assert.equal(outcome.kind, "code-sent");
  if (outcome.kind !== "code-sent") return;
  assert.deepEqual(outcome.pending, {
    changeToken: CHANGE_TOKEN,
    expiresAt: CHANGE_EXPIRES_AT,
    devVerificationCode: OTP,
  });
});

test("an issued change is reused instead of starting a second one", async () => {
  const { deps, calls } = recordingDeps({});

  const outcome = await completeEmailVerification(deps, {
    password: PASSWORD,
    newEmail: NEW_EMAIL,
    code: OTP,
    pending: { changeToken: "already-issued", expiresAt: CHANGE_EXPIRES_AT },
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["confirmEmailChange", "getSecurityStatus"],
  );
  assert.deepEqual(calls[0]?.args, ["already-issued", OTP]);
  assert.equal(outcome.kind, "verified");
});

test("a wrong code keeps the issued change so the citizen can retry it", async () => {
  const wrongCode = "Неверный код подтверждения.";
  const { deps, calls } = recordingDeps({
    confirm: async () => {
      throw new ApiRequestError(400, wrongCode);
    },
  });

  const outcome = await completeEmailVerification(deps, {
    password: PASSWORD,
    newEmail: NEW_EMAIL,
    code: "000000",
  });

  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.stage, "confirm");
  assert.equal(outcome.message, wrongCode);
  assert.equal(outcome.pending?.changeToken, CHANGE_TOKEN);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["beginEmailChange", "confirmEmailChange"],
  );
});
