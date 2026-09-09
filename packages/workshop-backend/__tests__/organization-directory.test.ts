import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AdminAuditEvent } from "@gadgets/workshop-shared/api";
import type {
  DirectoryActor,
  OrganizationDirectoryDurableObject,
} from "../src/organization-directory.js";

async function inDirectory<T>(
    name: string, callback: (directory: OrganizationDirectoryDurableObject) => T): Promise<T> {
  let testEnv = env as typeof env & {
    TEST_ORGANIZATION_DIRECTORY: DurableObjectNamespace<OrganizationDirectoryDurableObject>;
  };
  return runInDurableObject(testEnv.TEST_ORGANIZATION_DIRECTORY.getByName(name), callback);
}

function auditEvent(actor: DirectoryActor, overrides: Partial<AdminAuditEvent> = {})
    : AdminAuditEvent {
  return {
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    resourceType: "adminConfig",
    resourceId: actor.osInstallationId,
    action: "setSignupsEnabled",
    beforeVersion: 0,
    afterVersion: 1,
    result: "succeeded",
    reasonCode: "ADMIN_CONFIG_UPDATED",
    correlationId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    change: {field: "signupsEnabled", before: true, after: false},
    ...overrides,
  };
}

describe("OrganizationDirectoryDurableObject", () => {
  it("assigns stable opaque users inside one installation tenant", async () => {
    await inDirectory("stable-actors", directory => {
      let first = directory.getOrCreateActor("user-do-a");
      let retry = directory.getOrCreateActor("user-do-a");
      let second = directory.getOrCreateActor("user-do-b");

      expect(retry).toEqual(first);
      expect(second.tenantId).toBe(first.tenantId);
      expect(second.authorityId).toBe(first.authorityId);
      expect(second.osInstallationId).toBe(first.osInstallationId);
      expect(second.userId).not.toBe(first.userId);
      expect(first.userId).not.toContain("user-do-a");
    });
  });

  it("stores one event when an identical idempotency key is delivered twice", async () => {
    await inDirectory("event-retry", directory => {
      let actor = directory.getOrCreateActor("user-do-a");
      let event = auditEvent(actor);

      directory.recordAdminAuditEvent(event);
      directory.recordAdminAuditEvent(event);

      expect(directory.listAdminAuditEvents(actor.tenantId, 50)).toEqual([event]);
    });
  });

  it("rejects conflicting retries and backend identifiers outside the directory", async () => {
    await inDirectory("event-forgery", directory => {
      let actor = directory.getOrCreateActor("user-do-a");
      let event = auditEvent(actor);
      directory.recordAdminAuditEvent(event);

      expect(() => directory.recordAdminAuditEvent({
        ...event,
        change: {...event.change, after: true},
      })).toThrow(/Idempotency key/);
      expect(() => directory.recordAdminAuditEvent(auditEvent(actor, {
        tenantId: "scaleos:foreign:tenant:foreign",
      }))).toThrow(/does not belong/);
      expect(() => directory.listAdminAuditEvents("scaleos:foreign:tenant:foreign", 50))
          .toThrow(/not available/);
    });
  });
});
