import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AdminSettings } from "../src/admin-settings.js";
import type { OrganizationDirectoryDurableObject } from "../src/organization-directory.js";

const ADMIN_ID = "20000000-0000-4000-8000-000000000002";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    TEST_ORGANIZATION_DIRECTORY: DurableObjectNamespace<OrganizationDirectoryDurableObject>;
  }
}

describe("AdminSettings audit outbox", () => {
  it("recovers a committed mutation after its KV mirror initially fails", async () => {
    let suffix = crypto.randomUUID();
    let idempotencyKey = `set-signups:${suffix}`;
    let actorUserDoId = "admin-user-do";
    let originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/rpc/list_group_audit_events")) {
        return Response.json([]);
      }
      return Response.json({
        id: ADMIN_ID,
        email: "admin@example.test",
        email_confirmed_at: "2026-09-08T12:00:00.000Z",
      });
    }) as typeof fetch;
    try {
      await runInDurableObject(
          env.TEST_ORGANIZATION_DIRECTORY.getByName(""),
          directory => directory.authenticateHuman(ADMIN_ID, actorUserDoId, "admin@example.test"));
    let admin = env.TEST_ADMIN_SETTINGS.getByName(`admin-settings-outbox:${suffix}`);
    await runInDurableObject(admin, async instance => {
      let instanceEnv = (instance as unknown as {env: Cloudflare.Env}).env;
      let putSpy = vi.spyOn(instanceEnv.BLUEPRINTS, "put")
          .mockRejectedValueOnce(new Error("synthetic KV failure"));

      try {
        await expect(instance.setSignupsEnabledAudited(
            false, idempotencyKey, actorUserDoId)).rejects.toThrow("synthetic KV failure");
      } finally {
        putSpy.mockRestore();
      }

      expect(instance.getAdminConfig().signupsEnabled).toBe(false);

      let recovered = await instance.setSignupsEnabledAudited(
          false, idempotencyKey, actorUserDoId);
      let repeated = await instance.setSignupsEnabledAudited(
          false, idempotencyKey, actorUserDoId);
      let events = await instance.listAdminAuditEvents(actorUserDoId);
      let settingEvents = events.filter(event => event.action === "setSignupsEnabled");
      let bootstrapEvents = events.filter(event => event.action === "bootstrapAdmin");

      expect(recovered.policyVersion).toBe(1);
      expect(repeated).toEqual(recovered);
      expect(settingEvents).toHaveLength(1);
      expect(bootstrapEvents).toHaveLength(1);
      expect(settingEvents[0]).toMatchObject({
        correlationId: recovered.mutationId,
        idempotencyKey,
        action: "setSignupsEnabled",
        beforeVersion: 0,
        afterVersion: 1,
        change: {
          field: "signupsEnabled",
          before: true,
          after: false,
        },
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  });
});
