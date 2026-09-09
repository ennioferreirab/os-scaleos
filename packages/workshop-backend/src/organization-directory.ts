import {
  AUTH_ERROR_CODES,
  AdminAuditEvent,
  AdminMutationReceipt,
  DirectoryInviteResult,
  DirectoryUser,
  PendingUserLifecycle,
  ResumeUserStatusInput,
  createAuthError,
  type Audience,
  type DirectoryAudienceTargets,
  type Group,
  type GroupMember,
} from "@gadgets/workshop-shared/api";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import { DurableObject } from "cloudflare:workers";
import { requireSubject, type SupabaseAuthEnv } from "./auth/supabase.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GROUP_NAME_MAX_LENGTH = 80;

/** Stable actor shape retained for the T02 AdminSettings audit outbox. */
export type DirectoryActor = {
  /** Configured organization UUID. */
  authorityId: string;
  /** Configured organization UUID, stored in the historical tenantId envelope. */
  tenantId: string;
  /** Stable deployment resource id used by existing AdminSettings events. */
  osInstallationId: string;
  /** Verified Supabase subject. */
  userId: string;
};

type Organization = {orgId: string; createdAt: string};
type OsAccountBinding = {userId: string; userDoId: string; createdAt: string};
type Admission = {userId: string; invitedBy: string; invitedAt: string; acceptedAt?: string};
type PendingLifecycle = {
  userId: string;
  mutationId: string;
  actorId: string;
  desiredStatus: "active" | "disabled";
  startedAt: string;
};
type PendingInvite = {
  mutationId: string;
  actorId: string;
  email: string;
  displayName: string;
  startedAt: string;
  providerUserId?: string;
};
type DirectoryMutation = {
  key: string;
  mutationId: string;
  actorId: string;
  operation: "inviteUser" | "setUserRole" | "setUserStatus" |
    "createGroup" | "renameGroup" | "replaceGroupMembers" | "deleteGroup";
  requestHash: string;
  receipt: AdminMutationReceipt;
  user?: DirectoryUser;
  group?: Group;
};
type StoredAuditEvent = AdminAuditEvent & {storageKey: string};

function makeDirectoryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      directoryUsers: collection<DirectoryUser>()({primaryKey: "userId"}),
      osAccounts: collection<OsAccountBinding>()({
        primaryKey: "userId",
        uniqueIndexes: {byUserDoId: (binding: OsAccountBinding) => binding.userDoId},
      }),
      admissions: collection<Admission>()({primaryKey: "userId"}),
      pendingLifecycle: collection<PendingLifecycle>()({primaryKey: "userId"}),
      pendingInvites: collection<PendingInvite>()({
        primaryKey: "mutationId",
        uniqueIndexes: {byEmail: (pending: PendingInvite) => pending.email},
      }),
      groups: collection<Group>()({
        primaryKey: "groupId",
        uniqueIndexes: {
          byName: (group: Group) => group.name.trim().toLocaleLowerCase("pt-BR"),
        },
      }),
      groupMembers: collection<GroupMember>()({
        primaryKey: "key",
        nonUniqueIndexes: {
          byGroup: (member: GroupMember) => member.groupId,
          byUser: (member: GroupMember) => member.userId,
        },
      }),
      mutations: collection<DirectoryMutation>()({primaryKey: "key"}),
      auditEvents: collection<StoredAuditEvent>()({
        primaryKey: "storageKey",
        uniqueIndexes: {
          byEventId: (event: StoredAuditEvent) => event.eventId,
          byIdempotencyKey: (event: StoredAuditEvent) => event.idempotencyKey,
        },
      }),
    },
    singletons: {identity: <Organization | null>null, policyVersion: 0},
  });
}

type DirectoryStorage = ReturnType<typeof makeDirectoryStorage>;

type ProviderUser = {
  id: string;
  email: string;
  emailConfirmed: boolean;
  displayName?: string;
};

class DependencyUnavailableError extends Error {
  readonly code = AUTH_ERROR_CODES.dependencyUnavailable;
}

function configured(env: SupabaseAuthEnv & {ORG_ID?: string; BOOTSTRAP_ADMIN_SUB?: string},
    name: "AUTH_PUBLIC_URL" | "OS_PUBLIC_URL" | "SUPABASE_SECRET_KEY" | "ORG_ID" |
      "BOOTSTRAP_ADMIN_SUB"): string {
  const value = env[name]?.trim();
  if (!value) throw new DependencyUnavailableError(`Required backend setting ${name} is missing.`);
  return value.replace(/\/$/, "");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
    throw new TypeError("A valid invitation email is required.");
  }
  return normalized;
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (!normalized || normalized.length > 100) {
    throw new TypeError("Display name must be between 1 and 100 characters.");
  }
  return normalized;
}

function normalizeGroupName(name: string): {display: string; index: string} {
  if (typeof name !== "string") {
    throw Object.assign(new TypeError("Group name must be a string."), {
      code: AUTH_ERROR_CODES.invalidInput,
    });
  }
  const display = name.trim();
  if (!display || display.length > GROUP_NAME_MAX_LENGTH) {
    throw Object.assign(
        new TypeError(`Group name must be between 1 and ${GROUP_NAME_MAX_LENGTH} characters.`),
        {code: AUTH_ERROR_CODES.invalidInput});
  }
  return {display, index: display.toLocaleLowerCase("pt-BR")};
}

function requireGroupId(value: string): string {
  try {
    return requireSubject(value, "groupId");
  } catch {
    throw Object.assign(new TypeError("groupId must be a UUID."), {
      code: AUTH_ERROR_CODES.invalidInput,
    });
  }
}

function normalizeMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw Object.assign(new TypeError("userIds must be an array."), {
      code: AUTH_ERROR_CODES.invalidInput,
    });
  }
  try {
    return [...new Set(value.map(userId => requireSubject(userId, "userId")))].toSorted();
  } catch {
    throw Object.assign(new TypeError("userIds must contain only UUIDs."), {
      code: AUTH_ERROR_CODES.invalidInput,
    });
  }
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return new Uint8Array(digest).toHex();
}

function mutationKey(actorId: string, operation: DirectoryMutation["operation"], mutationId: string) {
  return `${actorId}\u0000${operation}\u0000${mutationId}`;
}

function selfDisableError(): Error & {code: typeof AUTH_ERROR_CODES.forbidden} {
  return Object.assign(new Error("Administrators cannot disable their own account."),
      {code: AUTH_ERROR_CODES.forbidden});
}

function notFoundError(message: string): Error & {code: "NOT_FOUND"} {
  return Object.assign(new Error(message), {code: AUTH_ERROR_CODES.notFound});
}

function publicProviderUser(value: unknown): ProviderUser {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DependencyUnavailableError("Supabase returned an invalid user record.");
  }
  const outer = value as Record<string, unknown>;
  const record = typeof outer.user === "object" && outer.user !== null && !Array.isArray(outer.user)
    ? outer.user as Record<string, unknown>
    : outer;
  const id = typeof record.id === "string" ? requireSubject(record.id, "provider user id") : "";
  const email = typeof record.email === "string" ? normalizeEmail(record.email) : "";
  const metadata = typeof record.user_metadata === "object" && record.user_metadata !== null &&
      !Array.isArray(record.user_metadata)
    ? record.user_metadata as Record<string, unknown>
    : undefined;
  const candidateName = metadata && (typeof metadata.full_name === "string"
    ? metadata.full_name : typeof metadata.name === "string" ? metadata.name : undefined);
  return {
    id,
    email,
    emailConfirmed: typeof record.email_confirmed_at === "string",
    ...(candidateName?.trim() ? {displayName: candidateName.trim().slice(0, 100)} : {}),
  };
}

class SupabaseAdminClient {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #redirectTo: string;

  constructor(env: SupabaseAuthEnv) {
    this.#baseUrl = configured(env, "AUTH_PUBLIC_URL");
    this.#secret = configured(env, "SUPABASE_SECRET_KEY");
    this.#redirectTo = `${configured(env, "OS_PUBLIC_URL")}/auth/recovery`;
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/auth/v1${path}`, {
        ...init,
        headers: {
          apikey: this.#secret,
          ...(init.body ? {"Content-Type": "application/json"} : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new DependencyUnavailableError("Supabase Auth is unavailable.");
    }
    if (!response.ok) {
      throw new DependencyUnavailableError(`Supabase Auth request failed with status ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new DependencyUnavailableError("Supabase Auth returned an invalid response.");
    }
  }

  async getUserById(userId: string): Promise<ProviderUser> {
    return publicProviderUser(await this.#request(`/admin/users/${requireSubject(userId)}`));
  }

  async findUserByEmail(email: string): Promise<ProviderUser | undefined> {
    const target = normalizeEmail(email);
    for (let page = 1; page <= 10_000; page++) {
      const raw = await this.#request(`/admin/users?page=${page}&per_page=1000`);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
          !Array.isArray((raw as Record<string, unknown>).users)) {
        throw new DependencyUnavailableError("Supabase Auth returned an invalid user list.");
      }
      const users = (raw as {users: unknown[]}).users;
      for (const candidate of users) {
        const user = publicProviderUser(candidate);
        if (user.email === target) return user;
      }
      if (users.length < 1000) return undefined;
    }
    throw new DependencyUnavailableError("Supabase Auth user pagination did not terminate.");
  }

  async inviteUser(email: string, displayName: string): Promise<ProviderUser> {
    const query = new URLSearchParams({redirect_to: this.#redirectTo});
    return publicProviderUser(await this.#request(`/invite?${query}`, {
      method: "POST",
      body: JSON.stringify({email, data: {display_name: displayName}}),
    }));
  }

  async setUserBanned(userId: string, disabled: boolean): Promise<void> {
    await this.#request(`/admin/users/${requireSubject(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ban_duration: disabled ? "876000h" : "none"}),
    });
  }
}

function sameEvent(left: AdminAuditEvent, right: AdminAuditEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Authoritative organization directory for the configured single organization. */
export class OrganizationDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: DirectoryStorage;
  private inviteInFlight = new Map<string, {
    actorId: string;
    email: string;
    displayName: string;
    promise: Promise<DirectoryInviteResult>;
  }>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeDirectoryStorage(ctx.storage);
  }

  #configuredOrgId(): string {
    return requireSubject(configured(this.env, "ORG_ID"), "ORG_ID");
  }

  #identity(): Organization {
    const identity = this.storage.identity.get();
    if (!identity) throw new Error("The organization has not been bootstrapped.");
    if (identity.orgId !== this.#configuredOrgId()) {
      throw new Error("Configured ORG_ID does not match the durable organization.");
    }
    return identity;
  }

  #effectiveStatus(user: DirectoryUser): "active" | "disabled" {
    return this.storage.pendingLifecycle.get(user.userId) ? "disabled" : user.status;
  }

  #publicUser(user: DirectoryUser): DirectoryUser {
    const status = this.#effectiveStatus(user);
    return status === user.status ? user : {...user, status};
  }

  #requireUser(userId: string): DirectoryUser {
    const user = this.storage.directoryUsers.get(requireSubject(userId));
    if (!user) throw Object.assign(new Error("Organization user was not found."), {code: "NOT_FOUND"});
    return user;
  }

  #requireActive(userId: string): DirectoryUser {
    const user = this.#requireUser(userId);
    if (this.#effectiveStatus(user) !== "active") {
      throw createAuthError(AUTH_ERROR_CODES.forbidden);
    }
    return user;
  }

  #requireAdmin(userId: string): DirectoryUser {
    const user = this.#requireActive(userId);
    if (user.role !== "admin") throw createAuthError(AUTH_ERROR_CODES.forbidden);
    return user;
  }

  #requireGroup(groupId: string): Group {
    const group = this.storage.groups.get(requireGroupId(groupId));
    if (!group) throw notFoundError("Directory group was not found.");
    return group;
  }

  #groupMemberIds(groupId: string): string[] {
    return [...this.storage.groupMembers.byGroup.get(groupId)]
        .map(member => member.userId).toSorted();
  }

  #sortedGroups(): Group[] {
    return [...this.storage.groups.list()].toSorted((left, right) => {
      const byName = left.name.trim().toLocaleLowerCase("pt-BR")
          .localeCompare(right.name.trim().toLocaleLowerCase("pt-BR"), "pt-BR");
      return byName || left.groupId.localeCompare(right.groupId, "pt-BR");
    });
  }

  #hasAnotherActiveAdmin(userId: string): boolean {
    return [...this.storage.directoryUsers.list()].some(candidate =>
      candidate.userId !== userId && candidate.role === "admin" &&
      candidate.status === "active" && !this.storage.pendingLifecycle.get(candidate.userId));
  }

  #event(actorId: string, resourceId: string,
      action: AdminAuditEvent["action"], reasonCode: AdminAuditEvent["reasonCode"],
      mutationId: string, change: AdminAuditEvent["change"], beforeVersion: number,
      afterVersion: number, idempotencyKey = mutationId,
      resumedByUserId?: string,
      resourceType?: AdminAuditEvent["resourceType"]): AdminAuditEvent {
    const orgId = this.#identity().orgId;
    return {
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      tenantId: orgId,
      actorUserId: actorId,
      ...(resumedByUserId ? {resumedByUserId} : {}),
      resourceType: resourceType ?? (resourceId === orgId ? "adminConfig" : "directoryUser"),
      resourceId,
      action,
      beforeVersion,
      afterVersion,
      result: "succeeded",
      reasonCode,
      correlationId: mutationId,
      idempotencyKey,
      change,
    };
  }

  #storeEvent(event: AdminAuditEvent): void {
    const existing = this.storage.auditEvents.byIdempotencyKey.get(event.idempotencyKey);
    if (existing) {
      const {storageKey: _storageKey, ...value} = existing;
      if (!sameEvent(value, event)) throw new Error("Audit mutation id was reused.");
      return;
    }
    this.storage.auditEvents.put({...event,
      storageKey: `${event.occurredAt}\u0000${event.eventId}`});
  }

  #nextVersion(): {before: number; after: number} {
    const before = this.storage.policyVersion.get();
    const after = before + 1;
    this.storage.policyVersion.put(after);
    return {before, after};
  }

  #receipt(mutationId: string, now: string, policyVersion: number): AdminMutationReceipt {
    return {mutationId, policyVersion, confirmedAt: now};
  }

  /** Bootstrap the configured admin or admit an existing active directory user on verified login. */
  async authenticateHuman(subject: string, userDoId: string,
      verifiedEmail?: string): Promise<DirectoryUser> {
    subject = requireSubject(subject);
    const existingIdentity = this.storage.identity.get();
    if (!existingIdentity) {
      const bootstrapSub = requireSubject(configured(this.env, "BOOTSTRAP_ADMIN_SUB"),
          "BOOTSTRAP_ADMIN_SUB");
      if (subject !== bootstrapSub) throw createAuthError(AUTH_ERROR_CODES.forbidden);
      const providerUser = await new SupabaseAdminClient(this.env).getUserById(subject);
      if (providerUser.id !== subject || !providerUser.emailConfirmed) {
        throw createAuthError(AUTH_ERROR_CODES.forbidden);
      }
      const now = new Date().toISOString();
      const user: DirectoryUser = {
        userId: subject,
        email: providerUser.email,
        displayName: providerUser.displayName ?? providerUser.email.split("@")[0],
        role: "admin",
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      return this.storage.transaction(() => {
        const concurrentIdentity = this.storage.identity.get();
        if (concurrentIdentity) {
          if (concurrentIdentity.orgId !== this.#configuredOrgId()) {
            throw new Error("Stored organization does not match ORG_ID.");
          }
          return this.#publicUser(this.#requireActive(subject));
        }
        const orgId = this.#configuredOrgId();
        this.storage.identity.put({orgId, createdAt: now});
        this.storage.directoryUsers.put(user);
        this.storage.osAccounts.put({userId: subject, userDoId, createdAt: now});
        this.storage.admissions.put({
          userId: subject, invitedBy: subject, invitedAt: now, acceptedAt: now,
        });
        const version = this.#nextVersion();
        this.#storeEvent(this.#event(subject, subject, "bootstrapAdmin",
            "DIRECTORY_ADMIN_BOOTSTRAPPED", `bootstrap:${subject}`,
            {field: "role", before: null, after: "admin"}, version.before, version.after));
        return user;
      });
    }

    this.#identity();
    return this.storage.transaction(() => {
      let user = this.#requireActive(subject);
      const binding = this.storage.osAccounts.get(subject);
      const byDo = this.storage.osAccounts.byUserDoId.get(userDoId);
      if ((binding && binding.userDoId !== userDoId) || (byDo && byDo.userId !== subject)) {
        throw new Error("Supabase subject is bound to another OS account.");
      }
      if (!binding) {
        this.storage.osAccounts.put({userId: subject, userDoId, createdAt: new Date().toISOString()});
      }
      const admission = this.storage.admissions.get(subject);
      if (!admission) throw new Error("Organization admission is missing.");
      if (!admission.acceptedAt) {
        this.storage.admissions.put({...admission, acceptedAt: new Date().toISOString()});
      }
      if (verifiedEmail) {
        const email = normalizeEmail(verifiedEmail);
        if (email !== user.email) {
          user = {...user, email, updatedAt: new Date().toISOString()};
          this.storage.directoryUsers.put(user);
        }
      }
      return this.#publicUser(user);
    });
  }

  /** Create the deterministic User DO binding target for a verified Subject. */
  userDoName(subject: string): string {
    return `supabase:${requireSubject(subject)}`;
  }

  /** Verify that the subject is currently active; pending lifecycle changes deny access. */
  requireActiveUser(userId: string): DirectoryUser {
    this.#identity();
    return this.#publicUser(this.#requireActive(userId));
  }

  /** Verify that the subject is a current active organization administrator. */
  requireAdminUser(userId: string): DirectoryUser {
    this.#identity();
    return this.#publicUser(this.#requireAdmin(userId));
  }

  /** Update a directory display name only for that same verified subject. */
  setOwnDisplayName(userId: string, displayName: string): void {
    const user = this.#requireActive(userId);
    const normalized = normalizeDisplayName(displayName);
    this.storage.directoryUsers.put({...user, displayName: normalized,
      updatedAt: new Date().toISOString()});
  }

  /** List directory users for a freshly rechecked administrator. */
  listUsers(actorId: string): DirectoryUser[] {
    this.#requireAdmin(actorId);
    return [...this.storage.directoryUsers.list()].map(user => this.#publicUser(user))
        .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
  }

  /** List only recoverable provider mutations for a freshly rechecked administrator. */
  listPendingUserLifecycle(actorId: string): PendingUserLifecycle[] {
    this.#requireAdmin(actorId);
    return [...this.storage.pendingLifecycle.list()].map(pending => ({
      userId: pending.userId,
      status: pending.desiredStatus,
      mutationId: pending.mutationId,
      actorUserId: pending.actorId,
      startedAt: pending.startedAt,
    })).toSorted((left, right) => left.userId.localeCompare(right.userId));
  }

  /** Coalesce identical in-flight retries; durable pending state remains the recovery authority. */
  async inviteUser(actorId: string, input: {email: string; displayName: string; mutationId: string})
      : Promise<DirectoryInviteResult> {
    actorId = requireSubject(actorId, "actorId");
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const existing = this.inviteInFlight.get(mutationId);
    if (existing) {
      if (existing.actorId !== actorId || existing.email !== email ||
          existing.displayName !== displayName) throw createAuthError(AUTH_ERROR_CODES.conflict);
      return existing.promise;
    }
    const promise = this.#inviteUser(actorId, {email, displayName, mutationId});
    this.inviteInFlight.set(mutationId, {actorId, email, displayName, promise});
    try {
      return await promise;
    } finally {
      if (this.inviteInFlight.get(mutationId)?.promise === promise) {
        this.inviteInFlight.delete(mutationId);
      }
    }
  }

  /** Invite through Supabase Auth and atomically record member admission, receipt, and audit. */
  async #inviteUser(actorId: string, input: {email: string; displayName: string; mutationId: string})
      : Promise<DirectoryInviteResult> {
    actorId = requireSubject(actorId, "actorId");
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const hash = await requestHash({email, displayName});
    const key = mutationKey(actorId, "inviteUser", mutationId);

    const replay = this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash || !completed.user) {
          throw createAuthError(AUTH_ERROR_CODES.conflict);
        }
        return {user: completed.user, receipt: completed.receipt};
      }
      let pending = this.storage.pendingInvites.get(mutationId);
      if (pending) {
        if (pending.actorId !== actorId || pending.email !== email ||
            pending.displayName !== displayName) throw createAuthError(AUTH_ERROR_CODES.conflict);
      } else {
        const byEmail = this.storage.pendingInvites.byEmail.get(email);
        if (byEmail) throw createAuthError(AUTH_ERROR_CODES.conflict);
        pending = {mutationId, actorId, email, displayName, startedAt: new Date().toISOString()};
        this.storage.pendingInvites.put(pending);
      }
      return undefined;
    });
    if (replay) return replay;

    const provider = new SupabaseAdminClient(this.env);
    let pending = this.storage.pendingInvites.get(mutationId)!;
    let providerUser = pending.providerUserId
      ? await provider.getUserById(pending.providerUserId)
      : await provider.findUserByEmail(email);
    if (!providerUser) providerUser = await provider.inviteUser(email, displayName);
    if (providerUser.email !== email) throw new DependencyUnavailableError(
        "Supabase Auth returned a different invitation email.");
    const completedAfterProvider = this.storage.transaction(() => {
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash || !completed.user) {
          throw createAuthError(AUTH_ERROR_CODES.conflict);
        }
        return {user: completed.user, receipt: completed.receipt};
      }
      const current = this.storage.pendingInvites.get(mutationId);
      if (!current || current.actorId !== actorId) throw createAuthError(AUTH_ERROR_CODES.conflict);
      if (current.providerUserId && current.providerUserId !== providerUser.id) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      this.storage.pendingInvites.put({...current, providerUserId: providerUser.id});
      return undefined;
    });
    if (completedAfterProvider) return completedAfterProvider;

    return this.storage.transaction(() => {
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash || !completed.user) {
          throw createAuthError(AUTH_ERROR_CODES.conflict);
        }
        return {user: completed.user, receipt: completed.receipt};
      }
      if (this.storage.directoryUsers.get(providerUser.id)) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const now = new Date().toISOString();
      const user: DirectoryUser = {
        userId: providerUser.id,
        email,
        displayName,
        role: "member",
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      this.storage.directoryUsers.put(user);
      this.storage.admissions.put({userId: user.userId, invitedBy: actorId, invitedAt: now});
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "inviteUser", requestHash: hash, receipt, user,
      });
      this.#storeEvent(this.#event(actorId, user.userId, "inviteUser", "DIRECTORY_USER_INVITED",
          mutationId, {field: "status", before: null, after: "active"},
          version.before, version.after, key));
      this.storage.pendingInvites.delete(mutationId);
      return {user, receipt};
    });
  }

  /** Change an organization role and protect the last usable administrator. */
  async setUserRole(actorId: string,
      input: {userId: string; role: "admin" | "member"; mutationId: string})
      : Promise<AdminMutationReceipt> {
    actorId = requireSubject(actorId, "actorId");
    const userId = requireSubject(input.userId);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const hash = await requestHash({userId, role: input.role});
    const key = mutationKey(actorId, "setUserRole", mutationId);
    return this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      const replay = this.storage.mutations.get(key);
      if (replay) {
        if (replay.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return replay.receipt;
      }
      const user = this.#requireActive(userId);
      if (user.role === input.role) throw createAuthError(AUTH_ERROR_CODES.conflict);
      if (user.role === "admin" && input.role === "member" && !this.#hasAnotherActiveAdmin(userId)) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const now = new Date().toISOString();
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      this.storage.directoryUsers.put({...user, role: input.role, updatedAt: now});
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "setUserRole", requestHash: hash, receipt,
      });
      this.#storeEvent(this.#event(actorId, userId, "setUserRole", "DIRECTORY_USER_ROLE_CHANGED",
          mutationId, {field: "role", before: user.role, after: input.role},
          version.before, version.after, key));
      return receipt;
    });
  }

  /** Reserve, apply at Supabase, and complete an idempotent lifecycle change. */
  async setUserStatus(actorId: string,
      input: {userId: string; status: "active" | "disabled"; mutationId: string})
      : Promise<AdminMutationReceipt> {
    actorId = requireSubject(actorId, "actorId");
    const userId = requireSubject(input.userId);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const hash = await requestHash({userId, status: input.status});
    const key = mutationKey(actorId, "setUserStatus", mutationId);
    const replay = this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      if (actorId === userId && input.status === "disabled") throw selfDisableError();
      const completed = this.storage.mutations.get(key);
      const pending = this.storage.pendingLifecycle.get(userId);
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      const user = this.#requireUser(userId);
      if (pending) {
        if (pending.mutationId !== mutationId || pending.actorId !== actorId ||
            pending.desiredStatus !== input.status) throw createAuthError(AUTH_ERROR_CODES.conflict);
      } else {
        if (user.status === input.status) throw createAuthError(AUTH_ERROR_CODES.conflict);
        if (input.status === "disabled" && user.role === "admin" &&
            !this.#hasAnotherActiveAdmin(userId)) throw createAuthError(AUTH_ERROR_CODES.conflict);
        this.storage.pendingLifecycle.put({
          userId, mutationId, actorId, desiredStatus: input.status,
          startedAt: new Date().toISOString(),
        });
      }
      return undefined;
    });
    if (replay) return replay;

    await new SupabaseAdminClient(this.env).setUserBanned(userId, input.status === "disabled");
    return this.storage.transaction(() => {
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      const pending = this.storage.pendingLifecycle.get(userId);
      if (!pending || pending.mutationId !== mutationId || pending.desiredStatus !== input.status) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const user = this.#requireUser(userId);
      const now = new Date().toISOString();
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      this.storage.directoryUsers.put({...user, status: input.status, updatedAt: now});
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "setUserStatus", requestHash: hash, receipt,
      });
      this.#storeEvent(this.#event(actorId, userId, "setUserStatus",
          input.status === "active" ? "DIRECTORY_USER_REACTIVATED" : "DIRECTORY_USER_DISABLED",
          mutationId, {field: "status", before: user.status, after: input.status},
          version.before, version.after, key));
      this.storage.pendingLifecycle.delete(userId);
      return receipt;
    });
  }

  /** Resume an exact pending lifecycle operation under a different, currently-active admin. */
  async resumeUserStatus(resumerId: string, input: ResumeUserStatusInput)
      : Promise<AdminMutationReceipt> {
    resumerId = requireSubject(resumerId, "resumerId");
    const userId = requireSubject(input.userId);
    const actorId = requireSubject(input.actorUserId, "actorUserId");
    const mutationId = requireSubject(input.mutationId, "mutationId");
    if (input.status !== "active" && input.status !== "disabled") {
      throw new TypeError("status must be active or disabled.");
    }
    if (resumerId === userId && input.status === "disabled") throw selfDisableError();
    const hash = await requestHash({userId, status: input.status});
    const key = mutationKey(actorId, "setUserStatus", mutationId);
    const replay = this.storage.transaction(() => {
      this.#requireAdmin(resumerId);
      const completed = this.storage.mutations.get(key);
      const pending = this.storage.pendingLifecycle.get(userId);
      if (!completed && !pending) {
        throw notFoundError("Pending lifecycle operation was not found.");
      }
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      if (pending!.mutationId !== mutationId || pending!.actorId !== actorId ||
          pending!.desiredStatus !== input.status) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const user = this.#requireUser(userId);
      if (input.status === "disabled" && user.role === "admin" &&
          !this.#hasAnotherActiveAdmin(userId)) throw createAuthError(AUTH_ERROR_CODES.conflict);
      return undefined;
    });
    if (replay) return replay;

    await new SupabaseAdminClient(this.env).setUserBanned(userId, input.status === "disabled");
    return this.storage.transaction(() => {
      this.#requireAdmin(resumerId);
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      const pending = this.storage.pendingLifecycle.get(userId);
      if (!pending) throw notFoundError("Pending lifecycle operation was not found.");
      if (pending.mutationId !== mutationId || pending.actorId !== actorId ||
          pending.desiredStatus !== input.status) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const user = this.#requireUser(userId);
      if (input.status === "disabled" && user.role === "admin" &&
          !this.#hasAnotherActiveAdmin(userId)) throw createAuthError(AUTH_ERROR_CODES.conflict);
      const now = new Date().toISOString();
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      this.storage.directoryUsers.put({...user, status: input.status, updatedAt: now});
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "setUserStatus", requestHash: hash, receipt,
      });
      this.#storeEvent(this.#event(actorId, userId, "setUserStatus",
          input.status === "active" ? "DIRECTORY_USER_REACTIVATED" : "DIRECTORY_USER_DISABLED",
          mutationId, {field: "status", before: user.status, after: input.status},
          version.before, version.after, key, resumerId));
      this.storage.pendingLifecycle.delete(userId);
      return receipt;
    });
  }

  /** List groups after rechecking the requesting administrator in this directory invocation. */
  listGroups(actorId: string): Group[] {
    this.#identity();
    this.#requireAdmin(actorId);
    return this.#sortedGroups();
  }

  /** Return group member Subjects after rechecking the administrator in this invocation. */
  getGroupMembers(actorId: string, groupId: string): string[] {
    this.#identity();
    this.#requireAdmin(actorId);
    const normalizedGroupId = requireGroupId(groupId);
    this.#requireGroup(normalizedGroupId);
    return this.#groupMemberIds(normalizedGroupId);
  }

  /** Return only active-user names and live-group names to an authenticated audience picker. */
  listAudienceTargets(actorId: string): DirectoryAudienceTargets {
    this.#identity();
    this.#requireActive(actorId);
    const users = [...this.storage.directoryUsers.list()]
        .filter(user => this.#effectiveStatus(user) === "active")
        .map(user => ({userId: user.userId, displayName: user.displayName}))
        .toSorted((left, right) => {
          const byName = left.displayName.localeCompare(right.displayName, "pt-BR");
          return byName || left.userId.localeCompare(right.userId, "pt-BR");
        });
    const groups = this.#sortedGroups()
        .map(group => ({groupId: group.groupId, name: group.name}));
    return {users, groups};
  }

  /** Create a group, its receipt, and its local audit event in one directory transaction. */
  async createGroup(actorId: string, input: {name: string; mutationId: string})
      : Promise<{group: Group; receipt: AdminMutationReceipt}> {
    actorId = requireSubject(actorId, "actorId");
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const name = normalizeGroupName(input.name);
    const hash = await requestHash({name: name.display});
    const key = mutationKey(actorId, "createGroup", mutationId);
    return this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash || !completed.group) {
          throw createAuthError(AUTH_ERROR_CODES.conflict);
        }
        return {group: completed.group, receipt: completed.receipt};
      }
      if (this.storage.groups.byName.get(name.index)) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const now = new Date().toISOString();
      const group: Group = {
        groupId: crypto.randomUUID(),
        name: name.display,
        createdAt: now,
        updatedAt: now,
      };
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      const event = this.#event(actorId, group.groupId, "createGroup", "DIRECTORY_GROUP_CREATED",
          mutationId, {field: "name", before: null, after: group.name}, version.before,
          version.after, key, undefined, "directoryGroup");
      this.storage.groups.put(group);
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "createGroup", requestHash: hash, receipt, group,
      });
      this.#storeEvent(event);
      return {group, receipt};
    });
  }

  /** Rename a group while preserving its id and membership atomically. */
  async renameGroup(actorId: string,
      input: {groupId: string; name: string; mutationId: string}): Promise<AdminMutationReceipt> {
    actorId = requireSubject(actorId, "actorId");
    const groupId = requireGroupId(input.groupId);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const name = normalizeGroupName(input.name);
    const hash = await requestHash({groupId, name: name.display});
    const key = mutationKey(actorId, "renameGroup", mutationId);
    return this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      const group = this.#requireGroup(groupId);
      const existing = this.storage.groups.byName.get(name.index);
      if (existing && existing.groupId !== groupId) {
        throw createAuthError(AUTH_ERROR_CODES.conflict);
      }
      const now = new Date().toISOString();
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      const event = this.#event(actorId, groupId, "renameGroup", "DIRECTORY_GROUP_RENAMED",
          mutationId, {field: "name", before: group.name, after: name.display}, version.before,
          version.after, key, undefined, "directoryGroup");
      this.storage.groups.put({...group, name: name.display, updatedAt: now});
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "renameGroup", requestHash: hash, receipt,
      });
      this.#storeEvent(event);
      return receipt;
    });
  }

  /** Replace the complete group member set in one transaction, validating every new member first. */
  async replaceGroupMembers(actorId: string,
      input: {groupId: string; userIds: string[]; mutationId: string})
      : Promise<AdminMutationReceipt> {
    actorId = requireSubject(actorId, "actorId");
    const groupId = requireGroupId(input.groupId);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const userIds = normalizeMemberIds(input.userIds);
    const hash = await requestHash({groupId, userIds});
    const key = mutationKey(actorId, "replaceGroupMembers", mutationId);
    return this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      this.#requireGroup(groupId);
      const before = this.#groupMemberIds(groupId);
      const beforeSet = new Set(before);
      for (const userId of userIds) {
        const user = this.storage.directoryUsers.get(userId);
        if (!user || (!beforeSet.has(userId) && this.#effectiveStatus(user) !== "active")) {
          throw Object.assign(new TypeError("Group members must be existing active users."), {
            code: AUTH_ERROR_CODES.invalidInput,
          });
        }
      }
      const nextSet = new Set(userIds);
      const members = [...this.storage.groupMembers.byGroup.get(groupId)];
      for (const member of members) {
        if (!nextSet.has(member.userId)) this.storage.groupMembers.delete(member.key);
      }
      const now = new Date().toISOString();
      for (const userId of userIds) {
        if (!beforeSet.has(userId)) {
          this.storage.groupMembers.put({
            key: `${groupId}:${userId}`,
            groupId,
            userId,
          });
        }
      }
      const group = this.#requireGroup(groupId);
      this.storage.groups.put({...group, updatedAt: now});
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      const event = this.#event(actorId, groupId, "replaceGroupMembers",
          "DIRECTORY_GROUP_MEMBERS_CHANGED", mutationId,
          {field: "members", before: String(before.length), after: String(userIds.length)},
          version.before, version.after, key, undefined, "directoryGroup");
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "replaceGroupMembers", requestHash: hash, receipt,
      });
      this.#storeEvent(event);
      return receipt;
    });
  }

  /** Delete a group and its membership rows atomically; audience references then grant nothing. */
  async deleteGroup(actorId: string,
      input: {groupId: string; mutationId: string}): Promise<AdminMutationReceipt> {
    actorId = requireSubject(actorId, "actorId");
    const groupId = requireGroupId(input.groupId);
    const mutationId = requireSubject(input.mutationId, "mutationId");
    const hash = await requestHash({groupId});
    const key = mutationKey(actorId, "deleteGroup", mutationId);
    return this.storage.transaction(() => {
      this.#requireAdmin(actorId);
      const completed = this.storage.mutations.get(key);
      if (completed) {
        if (completed.requestHash !== hash) throw createAuthError(AUTH_ERROR_CODES.conflict);
        return completed.receipt;
      }
      const group = this.#requireGroup(groupId);
      const members = [...this.storage.groupMembers.byGroup.get(groupId)];
      for (const member of members) {
        this.storage.groupMembers.delete(member.key);
      }
      this.storage.groups.delete(groupId);
      const now = new Date().toISOString();
      const version = this.#nextVersion();
      const receipt = this.#receipt(mutationId, now, version.after);
      const event = this.#event(actorId, groupId, "deleteGroup", "DIRECTORY_GROUP_DELETED",
          mutationId, {field: "name", before: group.name, after: null}, version.before,
          version.after, key, undefined, "directoryGroup");
      this.storage.mutations.put({
        key, mutationId, actorId, operation: "deleteGroup", requestHash: hash, receipt,
      });
      this.#storeEvent(event);
      return receipt;
    });
  }

  /** Resolve an audience from current directory state without caching or external I/O. */
  resolveAudience(subject: string, audience: Audience): {allowed: boolean; sources: string[]} {
    this.#identity();
    subject = requireSubject(subject);
    const user = this.storage.directoryUsers.get(subject);
    if (!user || this.#effectiveStatus(user) !== "active") return {allowed: false, sources: []};

    const sources: string[] = [];
    if (audience.everyone) sources.push("everyone");
    if (audience.userIds.includes(subject)) sources.push(`user:${subject}`);
    const groupIds = [...new Set(audience.groupIds.filter(groupId => typeof groupId === "string"))]
        .toSorted();
    for (const groupId of groupIds) {
      if (!this.storage.groups.get(groupId)) continue;
      if (this.storage.groupMembers.get(`${groupId}:${subject}`)) sources.push(`group:${groupId}`);
    }
    return {allowed: sources.length > 0, sources};
  }

  /** Resolve an admitted user for the private backend-to-backend directory endpoint. */
  getDirectoryUser(userId: string): DirectoryUser | null {
    this.#identity();
    const user = this.storage.directoryUsers.get(requireSubject(userId));
    return user ? this.#publicUser(user) : null;
  }

  /** Resolve the verified actor used by the existing AdminSettings audit outbox. */
  getOrCreateActor(userDoId: string): DirectoryActor {
    const identity = this.#identity();
    const binding = this.storage.osAccounts.byUserDoId.get(userDoId);
    if (!binding) throw createAuthError(AUTH_ERROR_CODES.forbidden);
    this.#requireAdmin(binding.userId);
    return {
      authorityId: identity.orgId,
      tenantId: identity.orgId,
      osInstallationId: identity.orgId,
      userId: binding.userId,
    };
  }

  /** Persist an event delivered from the existing AdminSettings transactional outbox. */
  recordAdminAuditEvent(event: AdminAuditEvent): void {
    this.storage.transaction(() => {
      const identity = this.#identity();
      if (event.tenantId !== identity.orgId || event.resourceId !== identity.orgId) {
        throw new Error("Audit event does not belong to this organization.");
      }
      this.#requireAdmin(event.actorUserId);
      this.#storeEvent(event);
    });
  }

  /** Return newest audit events for the configured organization. */
  listAdminAuditEvents(orgId: string, limit: number): AdminAuditEvent[] {
    if (orgId !== this.#identity().orgId) throw createAuthError(AUTH_ERROR_CODES.forbidden);
    return [...this.storage.auditEvents.list({reverse: true, limit})].map(stored => {
      const {storageKey: _storageKey, ...event} = stored;
      return event;
    });
  }
}
