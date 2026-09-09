import {
  RpcTarget as NativeRpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ContextAuthority,
  Audience,
  DirectoryAudienceTargets,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AppAccessResult } from "@gadgets/workshop-shared/api";
import { hasSupabaseAuthSettings } from "./auth/supabase.js";
import { HumanSessionGuard } from "./auth/human-session.js";
import type { GatekeeperCaller } from "./overseer.js";
import type { OrganizationDirectoryDurableObject } from "./organization-directory.js";

/**
 * Trusted kernel inputs used to mint a ContextAuthority in the current request's worker.
 *
 * `subject` is supplied by the authenticated kernel or by a kernel-owned User DO; it is never
 * accepted from a browser payload. `assertAdditionalAccess`, when present, is the T05 gate for the
 * workspace/account/hook that owns the bound vendor/app capability.
 */
export type ContextAuthorityOptions = {
  subject: string;
  vendorId?: string;
  directory?: DurableObjectStub<OrganizationDirectoryDurableObject>;
  centralAuthMode?: boolean;
  sessionGuard?: HumanSessionGuard;
  assertAdditionalAccess?: () => Promise<void>;
};


/**
 * Subject-bound authority used at a kernel boundary. Every public method performs the same live
 * checks before returning any value, so retaining this capability cannot retain an old role,
 * app-policy decision, or human session. When `vendorId` is present, the authority is bound to that
 * vendor/app; callers may additionally provide a target-specific T05 check.
 */
@validateRpc()
export class ContextAuthorityImpl extends NativeRpcTarget implements ContextAuthority {
  readonly #subject: string;
  readonly #vendorId?: string;
  readonly #directory?: DurableObjectStub<OrganizationDirectoryDurableObject>;
  readonly #centralAuthMode: boolean;
  readonly #sessionGuard?: HumanSessionGuard;
  readonly #assertAdditionalAccess?: () => Promise<void>;

  constructor(options: ContextAuthorityOptions) {
    super();
    this.#subject = options.subject;
    this.#vendorId = options.vendorId;
    this.#directory = options.directory;
    this.#centralAuthMode = options.centralAuthMode ?? !!options.directory;
    this.#sessionGuard = options.sessionGuard;
    this.#assertAdditionalAccess = options.assertAdditionalAccess;
  }

  /** Recheck the human session, directory user, bound vendor/app policy, and kernel-owned target. */
  async #assertLive(): Promise<AppAccessResult | undefined> {
    this.#sessionGuard?.assertValid();
    if (this.#centralAuthMode) {
      if (!this.#directory) {
        throw new Error("The organization directory is unavailable.");
      }
      await this.#directory.requireActiveUser(this.#subject);
    }
    // The workspace/account/hook check is intentionally repeated on every authority method, not
    // just at mint time. T05's final synchronous re-read remains the authority for the target.
    await this.#assertAdditionalAccess?.();
    if (this.#vendorId === undefined || !this.#centralAuthMode) return undefined;
    const access = await this.#directory!.resolveAppAccess(this.#subject, this.#vendorId);
    if (!access.allowed) {
      throw new Error(`The "${this.#vendorId}" app is not available to this user.`);
    }
    return access;
  }

  async getActor(): Promise<{subject: string; isOrgAdmin: boolean}> {
    await this.#assertLive();
    if (!this.#centralAuthMode || !this.#directory) {
      throw new Error("An authoritative organization directory is unavailable.");
    }
    let isOrgAdmin = false;
    try {
      await this.#directory.requireAdminUser(this.#subject);
      isOrgAdmin = true;
    } catch {
      // Membership is still a valid actor; only the current admin role is false.
    }
    return {subject: this.#subject, isOrgAdmin};
  }

  async resolveAudience(audience: Audience): Promise<{allowed: boolean; sources: string[]}> {
    await this.#assertLive();
    if (!this.#centralAuthMode) {
      // Legacy deployments have no authoritative directory audience. Fail closed instead of
      // manufacturing identity from a username/account property.
      return {allowed: false, sources: []};
    }
    return this.#directory!.resolveAudience(this.#subject, audience);
  }

  async listAudienceTargets(): Promise<DirectoryAudienceTargets> {
    await this.#assertLive();
    if (!this.#centralAuthMode) {
      return {users: [], groups: []};
    }
    return this.#directory!.listAudienceTargets(this.#subject);
  }

  /** Recheck access to the bound vendor/app and its kernel-owned target. */
  async assertAppAccess(): Promise<void> {
    await this.#assertLive();
  }
}

/**
 * Props for a durable authority minted by the kernel for an agent, gadget, or hook call.
 *
 * The caller identity and target are internal serialized kernel state. `subject` is the trusted
 * initiator or hook owner; the Overseer rechecks the caller, workspace, hook, and gatekeeper on
 * every operation.
 */
export type DurableContextAuthorityProps = {
  subject: string;
  vendorId?: string;
  overseerId: string;
  gatekeeperId: number;
  caller: GatekeeperCaller;
};

/** Durable authority form used when a bound vendor/app capability outlives the current worker turn. */
@validateRpc()
export class DurableContextAuthority
    extends WorkerEntrypoint<Cloudflare.Env, DurableContextAuthorityProps>
    implements ContextAuthority {
  #directory() {
    return this.ctx.exports.OrganizationDirectoryDurableObject.getByName("");
  }

  async #assertAdditionalAccess(): Promise<void> {
    const props = this.ctx.props;
    const overseers = this.ctx.exports.OverseerDurableObject;
    await overseers.get(overseers.idFromString(props.overseerId)).assertGatekeeperCallerAccess(
        props.gatekeeperId, props.caller);
  }

  #authority(): ContextAuthorityImpl {
    return new ContextAuthorityImpl({
      subject: this.ctx.props.subject,
      vendorId: this.ctx.props.vendorId,
      directory: this.#directory(),
      centralAuthMode: hasSupabaseAuthSettings(this.env),
      assertAdditionalAccess: () => this.#assertAdditionalAccess(),
    });
  }

  getActor(): Promise<{subject: string; isOrgAdmin: boolean}> {
    return this.#authority().getActor();
  }

  resolveAudience(audience: Audience): Promise<{allowed: boolean; sources: string[]}> {
    return this.#authority().resolveAudience(audience);
  }

  listAudienceTargets(): Promise<DirectoryAudienceTargets> {
    return this.#authority().listAudienceTargets();
  }

  assertAppAccess(): Promise<void> {
    return this.#authority().assertAppAccess();
  }
}
