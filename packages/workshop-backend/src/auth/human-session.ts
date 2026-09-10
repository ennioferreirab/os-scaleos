import { AUTH_ERROR_CODES, createAuthError } from "@gadgets/workshop-shared/api";

/** Verified, time-bounded human authority carried by an authenticated RPC capability. */
export class HumanSessionGuard {
  constructor(
      /** Immutable Supabase subject attached to this capability. */
      readonly subject: string,
      /** Access-token expiry as an absolute Unix time in milliseconds. */
      readonly expiresAtMs: number) {}

  /** Reject use at or after the verified access token's expiry. */
  assertValid(nowMs = Date.now()): void {
    if (nowMs >= this.expiresAtMs) {
      throw createAuthError(AUTH_ERROR_CODES.unauthenticated);
    }
  }
}
