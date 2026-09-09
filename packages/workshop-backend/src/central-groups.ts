import {
  AUTH_ERROR_CODES,
  AdminAuditEvent,
  AdminMutationReceipt,
  Group,
  createAuthError,
} from "@gadgets/workshop-shared/api";
import { requireSubject, type SupabaseAuthEnv } from "./auth/supabase.js";

const DEFAULT_TIMEOUT_MS = 3000;

export class DependencyUnavailableError extends Error {
  readonly code = AUTH_ERROR_CODES.dependencyUnavailable;
}

function configured(
  env: SupabaseAuthEnv,
  name: "AUTH_PUBLIC_URL" | "SUPABASE_SECRET_KEY"
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new DependencyUnavailableError(`Required backend setting ${name} is missing.`);
  }
  return value.replace(/\/$/, "");
}

function parsePostgrestError(status: number, body: unknown): Error {
  let message = "";
  if (typeof body === "object" && body !== null) {
    const rec = body as Record<string, unknown>;
    if (typeof rec.message === "string") message = rec.message;
    else if (typeof rec.error === "string") message = rec.error;
    else if (typeof rec.details === "string") message = rec.details;
  } else if (typeof body === "string") {
    message = body;
  }

  if (message.includes("NOT_FOUND") || status === 404) {
    return Object.assign(new Error("Directory group was not found."), {
      code: AUTH_ERROR_CODES.notFound,
    });
  }
  if (message.includes("CONFLICT") || status === 409) {
    return createAuthError(AUTH_ERROR_CODES.conflict);
  }
  if (message.includes("INVALID_INPUT")) {
    return Object.assign(new TypeError("The supplied group input is invalid."), {
      code: AUTH_ERROR_CODES.invalidInput,
    });
  }
  return new DependencyUnavailableError(`ScaleOS directory error (${status}): ${message || "unexpected error"}`);
}

function validateGroupRecord(item: unknown): Group {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new DependencyUnavailableError("Invalid group record returned by directory.");
  }
  const rec = item as Record<string, unknown>;
  const groupId = typeof rec.groupId === "string" ? requireSubject(rec.groupId, "groupId") : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : "";
  const updatedAt = typeof rec.updatedAt === "string" ? rec.updatedAt : "";

  if (!groupId || !name || !createdAt || !updatedAt) {
    throw new DependencyUnavailableError("Incomplete group record returned by directory.");
  }
  return {groupId, name, createdAt, updatedAt};
}

function validateReceiptRecord(item: unknown): AdminMutationReceipt {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new DependencyUnavailableError("Invalid mutation receipt returned by directory.");
  }
  const rec = item as Record<string, unknown>;
  const mutationId = typeof rec.mutationId === "string" ? requireSubject(rec.mutationId, "mutationId") : "";
  const policyVersion = typeof rec.policyVersion === "number" ? rec.policyVersion : -1;
  const confirmedAt = typeof rec.confirmedAt === "string" ? rec.confirmedAt : "";

  if (!mutationId || policyVersion < 0 || !confirmedAt) {
    throw new DependencyUnavailableError("Incomplete mutation receipt returned by directory.");
  }
  return {mutationId, policyVersion, confirmedAt};
}

function validateUuidArray(items: unknown): string[] {
  if (!Array.isArray(items)) {
    throw new DependencyUnavailableError("Expected array of UUIDs from directory.");
  }
  return items.map(id => {
    if (typeof id !== "string") {
      throw new DependencyUnavailableError("Invalid UUID element in directory response.");
    }
    return requireSubject(id, "userId");
  });
}

function validateAuditEvents(items: unknown): AdminAuditEvent[] {
  if (!Array.isArray(items)) {
    throw new DependencyUnavailableError("Expected array of audit events from directory.");
  }
  return items.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DependencyUnavailableError("Invalid audit event element in directory response.");
    }
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.eventId !== "string" ||
      typeof rec.occurredAt !== "string" ||
      typeof rec.tenantId !== "string" ||
      typeof rec.actorUserId !== "string" ||
      typeof rec.resourceType !== "string" ||
      typeof rec.resourceId !== "string" ||
      typeof rec.action !== "string" ||
      typeof rec.beforeVersion !== "number" ||
      typeof rec.afterVersion !== "number" ||
      typeof rec.result !== "string" ||
      typeof rec.reasonCode !== "string" ||
      typeof rec.correlationId !== "string" ||
      typeof rec.idempotencyKey !== "string" ||
      typeof rec.change !== "object" || rec.change === null
    ) {
      throw new DependencyUnavailableError("Incomplete audit event record returned by directory.");
    }
    return item as AdminAuditEvent;
  });
}

export type GroupMemberPair = {
  groupId: string;
  userId: string;
};

function validateGroupMemberPairs(items: unknown): GroupMemberPair[] {
  if (!Array.isArray(items)) {
    throw new DependencyUnavailableError("Expected array of group member pairs from directory.");
  }
  return items.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new DependencyUnavailableError("Invalid group member pair in directory response.");
    }
    const rec = item as Record<string, unknown>;
    const groupId = typeof rec.groupId === "string" ? requireSubject(rec.groupId, "groupId") : "";
    const userId = typeof rec.userId === "string" ? requireSubject(rec.userId, "userId") : "";
    if (!groupId || !userId) {
      throw new DependencyUnavailableError("Incomplete group member pair in directory response.");
    }
    return {groupId, userId};
  });
}

export type GroupMutationOperation =
  | "createGroup"
  | "renameGroup"
  | "replaceGroupMembers"
  | "deleteGroup";

export class CentralGroupsClient {
  readonly #rpcUrl: string;
  readonly #secret: string;

  constructor(env: SupabaseAuthEnv) {
    const baseUrl = configured(env, "AUTH_PUBLIC_URL");
    this.#secret = configured(env, "SUPABASE_SECRET_KEY");
    this.#rpcUrl = `${baseUrl}/rest/v1/rpc`;
  }

  async #callRpc(functionName: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.#rpcUrl}/${functionName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.#secret,
          Authorization: `Bearer ${this.#secret}`,
          "Content-Profile": "scaleos_directory",
          "Accept-Profile": "scaleos_directory",
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      throw new DependencyUnavailableError(
        `Directory connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        // Body was not JSON
      }
      throw parsePostgrestError(response.status, errorBody);
    }

    try {
      return await response.json();
    } catch {
      throw new DependencyUnavailableError("Directory returned an invalid JSON response.");
    }
  }

  /** Lists all groups for an organization. Never returns a fallback or empty list on error. */
  async listGroups(orgId: string): Promise<Group[]> {
    const data = await this.#callRpc("list_groups", {
      p_org_id: requireSubject(orgId, "orgId"),
    });
    if (!Array.isArray(data)) {
      throw new DependencyUnavailableError("Directory list_groups did not return an array.");
    }
    return data.map(validateGroupRecord);
  }

  /** Returns member user IDs for a group; throws NOT_FOUND if group is missing. */
  async getGroupMembers(orgId: string, groupId: string): Promise<string[]> {
    const data = await this.#callRpc("get_group_members", {
      p_org_id: requireSubject(orgId, "orgId"),
      p_group_id: requireSubject(groupId, "groupId"),
    });
    return validateUuidArray(data);
  }

  /** Resolves which of the requested group IDs the subject is currently a member of. */
  async resolveGroupMemberships(orgId: string, subject: string, groupIds: string[]): Promise<string[]> {
    if (groupIds.length === 0) return [];
    const validGroupIds = groupIds.map(g => requireSubject(g, "groupId"));
    const data = await this.#callRpc("resolve_group_memberships", {
      p_org_id: requireSubject(orgId, "orgId"),
      p_subject: requireSubject(subject, "subject"),
      p_group_ids: validGroupIds,
    });
    return validateUuidArray(data);
  }

  /** Filters candidate group IDs to those that exist in the organization. */
  async existingGroupIds(orgId: string, groupIds: string[]): Promise<string[]> {
    if (groupIds.length === 0) return [];
    const validGroupIds = groupIds.map(g => requireSubject(g, "groupId"));
    const data = await this.#callRpc("existing_group_ids", {
      p_org_id: requireSubject(orgId, "orgId"),
      p_group_ids: validGroupIds,
    });
    return validateUuidArray(data);
  }

  /** Returns group-to-member mappings for candidate groups in one batch RPC. */
  async getGroupsMembers(orgId: string, groupIds: string[]): Promise<GroupMemberPair[]> {
    if (groupIds.length === 0) return [];
    const validGroupIds = groupIds.map(g => requireSubject(g, "groupId"));
    const data = await this.#callRpc("get_groups_members", {
      p_org_id: requireSubject(orgId, "orgId"),
      p_group_ids: validGroupIds,
    });
    return validateGroupMemberPairs(data);
  }

  /** Lists newest group audit events up to limit (1..200). */
  async listGroupAuditEvents(orgId: string, limit?: number): Promise<AdminAuditEvent[]> {
    const data = await this.#callRpc("list_group_audit_events", {
      p_org_id: requireSubject(orgId, "orgId"),
      p_limit: limit !== undefined ? limit : 50,
    });
    return validateAuditEvents(data);
  }

  /** Atomically applies a group mutation via apply_group_mutation. */
  async applyGroupMutation(
    orgId: string,
    actorId: string,
    operation: "createGroup",
    mutationId: string,
    requestHash: string,
    payload: Record<string, unknown>
  ): Promise<{group: Group; receipt: AdminMutationReceipt}>;
  async applyGroupMutation(
    orgId: string,
    actorId: string,
    operation: "renameGroup" | "replaceGroupMembers" | "deleteGroup",
    mutationId: string,
    requestHash: string,
    payload: Record<string, unknown>
  ): Promise<AdminMutationReceipt>;
  async applyGroupMutation(
    orgId: string,
    actorId: string,
    operation: GroupMutationOperation,
    mutationId: string,
    requestHash: string,
    payload: Record<string, unknown>
  ): Promise<{group: Group; receipt: AdminMutationReceipt} | AdminMutationReceipt> {
    const data = await this.#callRpc("apply_group_mutation", {
      p_org_id: requireSubject(orgId, "orgId"),
      p_actor_id: requireSubject(actorId, "actorId"),
      p_operation: operation,
      p_mutation_id: requireSubject(mutationId, "mutationId"),
      p_request_hash: requestHash,
      p_payload: payload,
    });

    if (operation === "createGroup") {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new DependencyUnavailableError("Directory returned invalid createGroup result.");
      }
      const rec = data as Record<string, unknown>;
      const group = validateGroupRecord(rec.group);
      const receipt = validateReceiptRecord(rec.receipt);
      return {group, receipt};
    }

    return validateReceiptRecord(data);
  }
}
