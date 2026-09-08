import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_ERROR_CODES, type AdminAuditEvent } from "@gadgets/workshop-shared/api";
import type {
  DirectoryActor,
  OrganizationDirectoryDurableObject,
} from "../src/organization-directory.js";

const ADMIN_ID = "20000000-0000-4000-8000-000000000002";
const MEMBER_ID = "30000000-0000-4000-8000-000000000003";
const RESUMER_ID = "40000000-0000-4000-8000-000000000004";

async function inDirectory<T>(
    name: string, callback: (directory: OrganizationDirectoryDurableObject) => T): Promise<T> {
  const testEnv = env as typeof env & {
    TEST_ORGANIZATION_DIRECTORY: DurableObjectNamespace<OrganizationDirectoryDurableObject>;
  };
  return runInDurableObject(testEnv.TEST_ORGANIZATION_DIRECTORY.getByName(name), callback);
}

function providerUser(id: string, email: string, name: string) {
  return {
    id,
    email,
    email_confirmed_at: "2026-09-08T12:00:00.000Z",
    user_metadata: {display_name: name, name},
  };
}

function auditEvent(actor: DirectoryActor): AdminAuditEvent {
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
  };
}

describe("OrganizationDirectoryDurableObject", () => {
  const originalFetch = globalThis.fetch;
  let failLifecycle = false;
  let requests: Array<{url: string; method: string; body?: any}>;

  beforeEach(() => {
    requests = [];
    failLifecycle = false;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({url, method, body});
      if (url.endsWith(`/admin/users/${ADMIN_ID}`) && method === "GET") {
        return Response.json(providerUser(ADMIN_ID, "admin@example.test", "Admin"));
      }
      if (url.includes("/admin/users?page=") && method === "GET") {
        return Response.json({users: []});
      }
      if (url.includes("/invite?") && method === "POST") {
        const id = body.email === "resumer@example.test" ? RESUMER_ID : MEMBER_ID;
        return Response.json({user: providerUser(id, body.email, body.data.display_name)});
      }
      if (url.endsWith(`/admin/users/${MEMBER_ID}`) && method === "GET") {
        return Response.json(providerUser(MEMBER_ID, "member@example.test", "Member"));
      }
      if (url.endsWith(`/admin/users/${MEMBER_ID}`) && method === "PUT") {
        if (failLifecycle) return Response.json({message: "unavailable"}, {status: 503});
        return Response.json(providerUser(MEMBER_ID, "member@example.test", "Member"));
      }
      return Response.json({message: "unexpected test request"}, {status: 500});
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function bootstrapAndInvite(directory: OrganizationDirectoryDurableObject) {
    const admin = await directory.authenticateHuman(ADMIN_ID, "admin-user-do", "admin@example.test");
    const mutationId = crypto.randomUUID();
    const invited = await directory.inviteUser(ADMIN_ID, {
      email: "member@example.test",
      displayName: "Member",
      mutationId,
    });
    return {admin, invited, mutationId};
  }

  it("bootstraps only the configured, confirmed Supabase subject", async () => {
    await inDirectory(`bootstrap-${crypto.randomUUID()}`, async directory => {
      await expect(directory.authenticateHuman(MEMBER_ID, "member-user-do"))
          .rejects.toMatchObject({code: AUTH_ERROR_CODES.forbidden});
      const admin = await directory.authenticateHuman(
          ADMIN_ID, "admin-user-do", "admin@example.test");
      expect(admin).toMatchObject({
        userId: ADMIN_ID,
        email: "admin@example.test",
        role: "admin",
        status: "active",
      });
      expect(directory.requireAdminUser(ADMIN_ID).userId).toBe(ADMIN_ID);
      expect(requests[0]).toMatchObject({method: "GET"});
    });
  });

  it("invites once, admits the same Subject, and preserves the administrative display name", async () => {
    await inDirectory(`invite-${crypto.randomUUID()}`, async directory => {
      const {invited, mutationId} = await bootstrapAndInvite(directory);
      expect(invited.user).toMatchObject({
        userId: MEMBER_ID,
        email: "member@example.test",
        displayName: "Member",
        role: "member",
        status: "active",
      });
      const replay = await directory.inviteUser(ADMIN_ID, {
        email: "member@example.test",
        displayName: "Member",
        mutationId,
      });
      expect(replay).toEqual(invited);
      expect(requests.filter(request => request.url.includes("/invite?")).length).toBe(1);

      const loggedIn = await directory.authenticateHuman(
          MEMBER_ID, "member-user-do", "member@example.test");
      expect(loggedIn.displayName).toBe("Member");
      expect(() => directory.requireAdminUser(MEMBER_ID))
          .toThrow(expect.objectContaining({code: AUTH_ERROR_CODES.forbidden}));
    });
  });

  it("protects the last active administrator while allowing explicit role changes", async () => {
    await inDirectory(`roles-${crypto.randomUUID()}`, async directory => {
      await bootstrapAndInvite(directory);
      await expect(directory.setUserRole(ADMIN_ID, {
        userId: ADMIN_ID,
        role: "member",
        mutationId: crypto.randomUUID(),
      })).rejects.toMatchObject({code: AUTH_ERROR_CODES.conflict});

      await directory.setUserRole(ADMIN_ID, {
        userId: MEMBER_ID,
        role: "admin",
        mutationId: crypto.randomUUID(),
      });
      await directory.setUserRole(ADMIN_ID, {
        userId: ADMIN_ID,
        role: "member",
        mutationId: crypto.randomUUID(),
      });
      expect(directory.requireAdminUser(MEMBER_ID).role).toBe("admin");
    });
  });

  it("fails closed during a pending external lifecycle change and converges on retry", async () => {
    await inDirectory(`lifecycle-${crypto.randomUUID()}`, async directory => {
      await bootstrapAndInvite(directory);
      const mutationId = crypto.randomUUID();
      failLifecycle = true;
      await expect(directory.setUserStatus(ADMIN_ID, {
        userId: MEMBER_ID,
        status: "disabled",
        mutationId,
      })).rejects.toMatchObject({code: AUTH_ERROR_CODES.dependencyUnavailable});
      expect(() => directory.requireActiveUser(MEMBER_ID))
          .toThrow(expect.objectContaining({code: AUTH_ERROR_CODES.forbidden}));
      expect(directory.getDirectoryUser(MEMBER_ID)?.status).toBe("disabled");

      failLifecycle = false;
      const receipt = await directory.setUserStatus(ADMIN_ID, {
        userId: MEMBER_ID,
        status: "disabled",
        mutationId,
      });
      expect(receipt.mutationId).toBe(mutationId);
      expect(directory.getDirectoryUser(MEMBER_ID)?.status).toBe("disabled");
    });
  });

  it("returns one receipt to concurrent retries that finish provider I/O together", async () => {
    await inDirectory(`concurrent-${crypto.randomUUID()}`, async directory => {
      await bootstrapAndInvite(directory);
      const mutationId = crypto.randomUUID();
      const [first, second] = await Promise.all([
        directory.setUserStatus(ADMIN_ID, {
          userId: MEMBER_ID, status: "disabled", mutationId,
        }),
        directory.setUserStatus(ADMIN_ID, {
          userId: MEMBER_ID, status: "disabled", mutationId,
        }),
      ]);
      expect(second).toEqual(first);
      expect(first.mutationId).toBe(mutationId);
    });
  });

  it("forbids self-disable and lets another active admin resume only the exact pending payload",
      async () => {
    await inDirectory(`resume-${crypto.randomUUID()}`, async directory => {
      await bootstrapAndInvite(directory);
      await directory.inviteUser(ADMIN_ID, {
        email: "resumer@example.test",
        displayName: "Resumer",
        mutationId: crypto.randomUUID(),
      });
      await directory.setUserRole(ADMIN_ID, {
        userId: RESUMER_ID,
        role: "admin",
        mutationId: crypto.randomUUID(),
      });
      await expect(directory.setUserStatus(ADMIN_ID, {
        userId: ADMIN_ID,
        status: "disabled",
        mutationId: crypto.randomUUID(),
      })).rejects.toMatchObject({
        code: AUTH_ERROR_CODES.forbidden,
        message: "Administrators cannot disable their own account.",
      });

      const mutationId = crypto.randomUUID();
      failLifecycle = true;
      await expect(directory.setUserStatus(ADMIN_ID, {
        userId: MEMBER_ID,
        status: "disabled",
        mutationId,
      })).rejects.toMatchObject({code: AUTH_ERROR_CODES.dependencyUnavailable});
      const [pending] = directory.listPendingUserLifecycle(RESUMER_ID);
      expect(pending).toEqual({
        userId: MEMBER_ID,
        status: "disabled",
        mutationId,
        actorUserId: ADMIN_ID,
      });
      await expect(directory.resumeUserStatus(RESUMER_ID, {...pending, status: "active"}))
          .rejects.toMatchObject({code: AUTH_ERROR_CODES.conflict});

      failLifecycle = false;
      const receipt = await directory.resumeUserStatus(RESUMER_ID, pending);
      expect(await directory.resumeUserStatus(RESUMER_ID, pending)).toEqual(receipt);
      expect(directory.listPendingUserLifecycle(RESUMER_ID)).toEqual([]);
      const orgId = directory.getOrCreateActor("admin-user-do").tenantId;
      const event = directory.listAdminAuditEvents(orgId, 50)
          .find(candidate => candidate.correlationId === mutationId);
      expect(event).toMatchObject({
        actorUserId: ADMIN_ID,
        resumedByUserId: RESUMER_ID,
        action: "setUserStatus",
      });
    });
  });

  it("retains T02 audit idempotency for the stable directory actor", async () => {
    await inDirectory(`audit-${crypto.randomUUID()}`, async directory => {
      await directory.authenticateHuman(ADMIN_ID, "admin-user-do", "admin@example.test");
      const actor = directory.getOrCreateActor("admin-user-do");
      const event = auditEvent(actor);
      directory.recordAdminAuditEvent(event);
      directory.recordAdminAuditEvent(event);
      expect(directory.listAdminAuditEvents(actor.tenantId, 50)).toContainEqual(event);
    });
  });

  it("serves one exact directory record only to the backend service token", async () => {
    await inDirectory("", async directory => {
      await bootstrapAndInvite(directory);
    });
    const url = `https://os.example.test/api/internal/directory/users?userId=${MEMBER_ID}`;
    const unauthorized = await SELF.fetch(url);
    expect(unauthorized.status).toBe(401);

    const invalid = await SELF.fetch(
      "https://os.example.test/api/internal/directory/users?userId=not-a-uuid",
      {headers: {Authorization: "Bearer test-directory-service-token"}},
    );
    expect(invalid.status).toBe(400);

    const response = await SELF.fetch(url, {
      headers: {Authorization: "Bearer test-directory-service-token"},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: MEMBER_ID,
      email: "member@example.test",
      displayName: "Member",
      status: "active",
      role: "member",
    });
  });
});
