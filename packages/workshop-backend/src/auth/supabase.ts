import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { AUTH_ERROR_CODES, createAuthError } from "@gadgets/workshop-shared/api";

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Backend-only Supabase settings used for human authentication and lifecycle administration. */
export type SupabaseAuthEnv = Readonly<{
  AUTH_ISSUER?: string;
  AUTH_PUBLIC_URL?: string;
  AUTH_OS_CLIENT_ID?: string;
  OS_PUBLIC_URL?: string;
  SUPABASE_SECRET_KEY?: string;
}>;

/** Identity established from a verified OAuth access token issued specifically to the OS client. */
export type VerifiedHumanIdentity = {
  /** Immutable Supabase Auth subject. */
  subject: string;
  /** Access-token expiry as an absolute Unix time in milliseconds. */
  expiresAtMs: number;
  /** Confirmed contact address, when the token explicitly attests verification. */
  verifiedEmail?: string;
};

type AccessTokenVerifier = (token: string, env: SupabaseAuthEnv) => Promise<JWTPayload>;

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function requiredSetting(env: SupabaseAuthEnv, name: keyof SupabaseAuthEnv): string {
  const value = env[name]?.trim();
  if (!value) throw createAuthError(AUTH_ERROR_CODES.dependencyUnavailable);
  return value;
}

function issuerUrl(env: SupabaseAuthEnv): URL {
  const value = new URL(requiredSetting(env, "AUTH_ISSUER"));
  if (value.search || value.hash || value.username || value.password) {
    throw createAuthError(AUTH_ERROR_CODES.dependencyUnavailable);
  }
  const loopback = value.hostname === "localhost" || value.hostname === "127.0.0.1" ||
      value.hostname === "[::1]";
  if (value.protocol !== "https:" && !(value.protocol === "http:" && loopback)) {
    throw createAuthError(AUTH_ERROR_CODES.dependencyUnavailable);
  }
  value.pathname = value.pathname.replace(/\/$/, "");
  return value;
}

async function verifyToken(token: string, env: SupabaseAuthEnv): Promise<JWTPayload> {
  const issuer = issuerUrl(env).toString().replace(/\/$/, "");
  let jwks = remoteJwkSets.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    remoteJwkSets.set(issuer, jwks);
  }
  return (await jwtVerify(token, jwks, {
    issuer,
    audience: "authenticated",
    algorithms: ["ES256"],
  })).payload;
}

/** Verify an OAuth access token and bind it to the configured public OS client. */
export async function verifyHumanAccessToken(
    token: string,
    env: SupabaseAuthEnv,
    verifier: AccessTokenVerifier = verifyToken): Promise<VerifiedHumanIdentity> {
  if (!token || token.length > 16_384) {
    throw createAuthError(AUTH_ERROR_CODES.unauthenticated);
  }
  const expectedClientId = requiredSetting(env, "AUTH_OS_CLIENT_ID");
  let payload: JWTPayload;
  try {
    payload = await verifier(token, env);
  } catch (error) {
    if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid ||
        error instanceof errors.JWKInvalid ||
        (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC") ||
        !(error instanceof errors.JOSEError)) {
      throw createAuthError(AUTH_ERROR_CODES.dependencyUnavailable);
    }
    throw createAuthError(AUTH_ERROR_CODES.unauthenticated);
  }
  if (payload.client_id !== expectedClientId || typeof payload.sub !== "string" ||
      !UUID_PATTERN.test(payload.sub) || typeof payload.exp !== "number") {
    throw createAuthError(AUTH_ERROR_CODES.unauthenticated);
  }
  const verifiedEmail = payload.email_verified === true && typeof payload.email === "string"
    ? payload.email.trim().toLowerCase()
    : undefined;
  return {
    subject: payload.sub.toLowerCase(),
    expiresAtMs: payload.exp * 1000,
    ...(verifiedEmail ? {verifiedEmail} : {}),
  };
}

/** True only when all settings needed to accept Supabase OAuth sessions are configured. */
export function isSupabaseAuthConfigured(env: SupabaseAuthEnv): boolean {
  return !!(env.AUTH_ISSUER?.trim() && env.AUTH_PUBLIC_URL?.trim() &&
      env.AUTH_OS_CLIENT_ID?.trim() && env.OS_PUBLIC_URL?.trim() &&
      env.SUPABASE_SECRET_KEY?.trim());
}

/** Fail closed when a deployment has started configuring T03 but is missing required settings. */
export function hasSupabaseAuthSettings(env: SupabaseAuthEnv): boolean {
  return !!(env.AUTH_ISSUER?.trim() || env.AUTH_PUBLIC_URL?.trim() ||
      env.AUTH_OS_CLIENT_ID?.trim() || env.OS_PUBLIC_URL?.trim() ||
      env.SUPABASE_SECRET_KEY?.trim());
}

/** Throws when a string is not a canonical UUID-shaped subject. */
export function requireSubject(value: string, field = "userId"): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID.`);
  return value.toLowerCase();
}
