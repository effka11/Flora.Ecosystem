import type { EmailChangeBeginResult, SecurityStatusDto } from "@flora/client-core/auth";

/**
 * Gov admits a session only after Auth reports a confirmed email. The decision is
 * kept out of the React tree so it can be exercised without a DOM.
 *
 * Residual risk, accepted for this slice: the gate is client-side only. Messaging
 * does not read the Auth database and the JWT carries no `emailVerified` claim, so
 * another client holding the same access token bypasses it. A server-side port or a
 * JWT claim is a separate decision.
 */
export type GovGateDecision = "login" | "wall" | "shell";

/** Unknown security status fails closed to the wall: functions stay hidden until Auth says verified. */
export function decideGovGate(input: {
  hasAccessToken: boolean;
  security: SecurityStatusDto | null;
}): GovGateDecision {
  if (!input.hasAccessToken) return "login";
  return input.security?.emailVerified === true ? "shell" : "wall";
}

/** An email change that Auth has issued and is waiting to confirm with an OTP. */
export type GovEmailChangePending = {
  changeToken: string;
  expiresAt: string;
  /** Returned by dev builds only, so a human can finish the flow without SMTP. */
  devVerificationCode?: string;
};

export type GovEmailVerificationDeps = {
  beginEmailChange: (password: string, newEmail: string) => Promise<EmailChangeBeginResult>;
  confirmEmailChange: (changeToken: string, code: string) => Promise<string>;
  getSecurityStatus: () => Promise<SecurityStatusDto>;
};

export type GovEmailVerificationStage = "begin" | "confirm" | "security";

export type GovEmailVerificationInput = {
  password: string;
  newEmail: string;
  /** Empty until Auth has sent the code; then the change is confirmed with it. */
  code: string;
  /** Reuse of an already issued change, so retrying a code does not invalidate it. */
  pending?: GovEmailChangePending | null;
};

export type GovEmailVerificationOutcome =
  | { kind: "code-sent"; pending: GovEmailChangePending }
  | {
      kind: "verified";
      email: string;
      security: SecurityStatusDto;
      decision: GovGateDecision;
    }
  | {
      kind: "failed";
      stage: GovEmailVerificationStage;
      message: string;
      pending: GovEmailChangePending | null;
    };

/**
 * The server text is the only text a caller shows for a rejected request.
 * `ApiRequestError` already carries the Auth message, so nothing here rewrites it.
 */
export function serverErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function pendingFromBegin(begun: EmailChangeBeginResult): GovEmailChangePending {
  return {
    changeToken: begun.changeToken,
    expiresAt: begun.expiresAt,
    ...(begun.devVerificationCode ? { devVerificationCode: begun.devVerificationCode } : {}),
  };
}

/**
 * Completes the only path that flips `email_verified` for an already signed-in
 * account: begin the email change, confirm it with the OTP, then re-read the
 * security status and report whether the gate now opens.
 *
 * Without a code the call stops after the change is begun, because the OTP only
 * exists once Auth has issued it.
 */
export async function completeEmailVerification(
  deps: GovEmailVerificationDeps,
  input: GovEmailVerificationInput,
): Promise<GovEmailVerificationOutcome> {
  let pending = input.pending ?? null;

  if (!pending) {
    try {
      pending = pendingFromBegin(await deps.beginEmailChange(input.password, input.newEmail));
    } catch (error) {
      return { kind: "failed", stage: "begin", message: serverErrorText(error), pending: null };
    }
  }

  const code = input.code.trim();
  if (!code) return { kind: "code-sent", pending };

  let email: string;
  try {
    email = await deps.confirmEmailChange(pending.changeToken, code);
  } catch (error) {
    return { kind: "failed", stage: "confirm", message: serverErrorText(error), pending };
  }

  try {
    const security = await deps.getSecurityStatus();
    return {
      kind: "verified",
      email,
      security,
      decision: decideGovGate({ hasAccessToken: true, security }),
    };
  } catch (error) {
    // The change token is spent, so a retry has to start a new change.
    return { kind: "failed", stage: "security", message: serverErrorText(error), pending: null };
  }
}
