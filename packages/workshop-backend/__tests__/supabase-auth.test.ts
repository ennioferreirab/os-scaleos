import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { HumanSessionGuard } from "../src/auth/human-session.js";
import { verifyHumanAccessToken } from "../src/auth/supabase.js";

const SUBJECT = "20000000-0000-4000-8000-000000000002";
const ENV = {
  AUTH_ISSUER: "https://auth.example.test",
  AUTH_OS_CLIENT_ID: "os-client",
};

describe("Supabase human access tokens", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("binds a verified access token to its UUID subject and confirmed contact", async () => {
    const identity = await verifyHumanAccessToken("access-token", ENV, async () => ({
      sub: SUBJECT,
      exp: 2_000_000_000,
      client_id: "os-client",
      email: " Person@Example.test ",
      email_verified: true,
    }));
    expect(identity).toEqual({
      subject: SUBJECT,
      expiresAtMs: 2_000_000_000_000,
      verifiedEmail: "person@example.test",
    });
  });

  it("rejects tokens minted for another public client", async () => {
    await expect(verifyHumanAccessToken("access-token", ENV, async () => ({
      sub: SUBJECT,
      exp: 2_000_000_000,
      client_id: "vault-client",
    }))).rejects.toMatchObject({code: AUTH_ERROR_CODES.unauthenticated});
  });

  it("maps a remote JWKS HTTP failure to dependency unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unavailable", {status: 500})) as typeof fetch;
    const encoded = (value: object) => btoa(JSON.stringify(value))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const token = `${encoded({alg: "ES256", kid: "key-1"})}.${encoded({
      sub: SUBJECT,
      exp: 2_000_000_000,
      aud: "authenticated",
      iss: "https://jwks-http-500.example.test",
      client_id: "os-client",
    })}.AA`;
    await expect(verifyHumanAccessToken(token, {
      AUTH_ISSUER: "https://jwks-http-500.example.test",
      AUTH_OS_CLIENT_ID: "os-client",
    })).rejects.toMatchObject({code: AUTH_ERROR_CODES.dependencyUnavailable});
  });

  it("classifies non-JOSE provider failures separately from invalid credentials", async () => {
    await expect(verifyHumanAccessToken("access-token", ENV, async () => {
      throw new TypeError("network unavailable");
    })).rejects.toMatchObject({code: AUTH_ERROR_CODES.dependencyUnavailable});
  });

  it("rejects every guarded RPC use at or after the verified expiry", () => {
    const guard = new HumanSessionGuard(SUBJECT, 1_000);
    expect(() => guard.assertValid(999)).not.toThrow();
    expect(() => guard.assertValid(1_000))
        .toThrow(expect.objectContaining({code: AUTH_ERROR_CODES.unauthenticated}));
  });
});
