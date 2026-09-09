import { describe, expect, it, vi } from "vitest";
import { UserDurableObject } from "../src/user.js";

function makeAutoProvisionedAccount(mode: "disabled" | "enabled") {
  const revoke = vi.fn(async () => {});
  const account = {
    id: 7,
    account: {revoke},
    vendorId: "context",
    description: {},
    autoProvisioned: true,
  };
  const records = new Map([[account.id, account]]);
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    centralAuthMode: true,
    organizationDirectory: {
      getByName: () => ({
        resolveAppAccess: async () => mode === "enabled"
          ? {allowed: true, mode: "enabled", sources: ["direct:test"]}
          : {allowed: false, mode: "disabled", sources: []},
      }),
    },
    storage: {
      profile: {get: () => ({id: "subject"})},
      connectedAccounts: {
        get: (id: number) => records.get(id),
        delete: (id: number) => records.delete(id),
      },
    },
  });
  return {user, records, revoke};
}

describe("UserDurableObject.disconnectAccount", () => {
  it("keeps cleanup reachable after an auto-provisioned app is disabled", async () => {
    const {user, records, revoke} = makeAutoProvisionedAccount("disabled");

    await expect(user.disconnectAccount(7)).resolves.toBeUndefined();

    expect(revoke).toHaveBeenCalledOnce();
    expect(records.has(7)).toBe(false);
  });

  it("does not disconnect a currently enabled auto-provisioned account", async () => {
    const {user, records, revoke} = makeAutoProvisionedAccount("enabled");

    await expect(user.disconnectAccount(7)).rejects.toThrow(
        "This account is provided automatically and can't be disconnected.");

    expect(revoke).not.toHaveBeenCalled();
    expect(records.has(7)).toBe(true);
  });
});
