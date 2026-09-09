import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AdminSettings } from "../src/admin-settings.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

describe("AdminSettings audit outbox", () => {
  it("recovers a committed mutation after its KV mirror initially fails", async () => {
    let suffix = crypto.randomUUID();
    let idempotencyKey = `set-signups:${suffix}`;
    let actorUserDoId = `synthetic-user-do:${suffix}`;
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

      expect(recovered.policyVersion).toBe(1);
      expect(repeated).toEqual(recovered);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
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
  });
});
