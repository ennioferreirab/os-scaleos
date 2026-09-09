import { AdminAuditEvent } from "@gadgets/workshop-shared/api";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import { DurableObject } from "cloudflare:workers";

/** Backend-resolved directory identity for one authenticated OS account. */
export type DirectoryActor = {
  /** Canonical authority identifier for this OS installation. */
  authorityId: string;
  /** Canonical organization identifier for the installation's single MVP tenant. */
  tenantId: string;
  /** Stable opaque identifier for this OS installation. */
  osInstallationId: string;
  /** Canonical directory user identifier bound to the authenticated OS account. */
  userId: string;
};

type DirectoryIdentity = Omit<DirectoryActor, "userId">;

type OsAccountBinding = {
  userDoId: string;
  tenantId: string;
  userId: string;
  createdAt: string;
};

type StoredAuditEvent = AdminAuditEvent & {
  storageKey: string;
};

function makeDirectoryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      osAccounts: collection<OsAccountBinding>()({
        primaryKey: "userDoId",
        uniqueIndexes: {
          byUserId: (binding: OsAccountBinding) => binding.userId,
        },
      }),
      auditEvents: collection<StoredAuditEvent>()({
        primaryKey: "storageKey",
        uniqueIndexes: {
          byEventId: (event: StoredAuditEvent) => event.eventId,
          byIdempotencyKey: (event: StoredAuditEvent) => event.idempotencyKey,
        },
      }),
    },
    singletons: {
      identity: <DirectoryIdentity | null>null,
    },
  });
}

type DirectoryStorage = ReturnType<typeof makeDirectoryStorage>;

function canonicalId(authorityId: string, kind: "tenant" | "user"): string {
  return `scaleos:${authorityId}:${kind}:${crypto.randomUUID()}`;
}

function sameAuditEvent(left: AdminAuditEvent, right: AdminAuditEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Authoritative single-tenant directory and local administrative audit store for this deployment.
 * The singleton is always addressed by the reserved name `""`; browser clients never receive its
 * capability directly.
 */
export class OrganizationDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: DirectoryStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeDirectoryStorage(ctx.storage);
  }

  /**
   * Resolve the canonical actor bound to a backend-observed User Durable Object id, creating the
   * installation identity and opaque account binding on first use. No username, email, tenant, or
   * role supplied by a browser participates in this mapping.
   */
  getOrCreateActor(userDoId: string): DirectoryActor {
    if (!userDoId) throw new Error("An authenticated OS account id is required.");

    return this.storage.transaction(() => {
      let identity = this.storage.identity.get();
      if (!identity) {
        let authorityId = crypto.randomUUID();
        identity = {
          authorityId,
          tenantId: canonicalId(authorityId, "tenant"),
          osInstallationId: crypto.randomUUID(),
        };
        this.storage.identity.put(identity);
      }

      let binding = this.storage.osAccounts.get(userDoId);
      if (!binding) {
        binding = {
          userDoId,
          tenantId: identity.tenantId,
          userId: canonicalId(identity.authorityId, "user"),
          createdAt: new Date().toISOString(),
        };
        this.storage.osAccounts.put(binding);
      }
      if (binding.tenantId !== identity.tenantId) {
        throw new Error("OS account binding belongs to another tenant.");
      }

      return {...identity, userId: binding.userId};
    });
  }

  /**
   * Persist an event delivered from the AdminSettings transactional outbox. Replaying the same
   * idempotency key is harmless only when the complete event is identical; conflicting reuse fails
   * closed. Actor, tenant, and installation identifiers must match this directory's own records.
   */
  recordAdminAuditEvent(event: AdminAuditEvent): void {
    this.storage.transaction(() => {
      let identity = this.storage.identity.get();
      if (!identity || event.tenantId !== identity.tenantId ||
          event.resourceId !== identity.osInstallationId) {
        throw new Error("Audit event does not belong to this OS installation.");
      }
      let actor = this.storage.osAccounts.byUserId.get(event.actorUserId);
      if (!actor || actor.tenantId !== event.tenantId) {
        throw new Error("Audit actor is not bound to this tenant.");
      }

      let existing = this.storage.auditEvents.byIdempotencyKey.get(event.idempotencyKey);
      if (existing) {
        let {storageKey: _storageKey, ...storedEvent} = existing;
        if (!sameAuditEvent(storedEvent, event)) {
          throw new Error("Idempotency key was already used for another audit event.");
        }
        return;
      }
      if (this.storage.auditEvents.byEventId.get(event.eventId)) {
        throw new Error("Audit event id was already used.");
      }

      this.storage.auditEvents.put({
        ...event,
        storageKey: `${event.occurredAt}\u0000${event.eventId}`,
      });
    });
  }

  /**
   * Return the newest audit events for the requested tenant. The caller is the already-authorized
   * AdminApi capability; this method still rejects any tenant other than the directory singleton's
   * own tenant so an internal caller cannot accidentally widen the query.
   */
  listAdminAuditEvents(tenantId: string, limit: number): AdminAuditEvent[] {
    let identity = this.storage.identity.get();
    if (!identity || tenantId !== identity.tenantId) {
      throw new Error("Audit history is not available for this tenant.");
    }

    return [...this.storage.auditEvents.list({reverse: true, limit})].map(stored => {
      let {storageKey: _storageKey, ...event} = stored;
      return event;
    });
  }
}
