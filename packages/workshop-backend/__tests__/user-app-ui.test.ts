import { expect, it, vi } from "vitest";
import type { AppUiContext, GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

it("does not return an app frame when its connected account disappears during minting", async () => {
  let releaseStart!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseStart = resolve; });
  let enteredStart!: () => void;
  const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
  const dispose = vi.fn();
  const frame = {
    iframeHtml: "",
    ui: {[Symbol.dispose]: dispose},
  } as unknown as GatekeeperUiFrame;
  const account = {
    async startAppUi() {
      enteredStart();
      await blocked;
      return frame;
    },
  };
  const records = new Map([[7, {
    id: 7,
    account,
    vendorId: "context",
    description: {providesUi: {title: "Context", icon: "context"}},
  }]]);
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    centralAuthMode: false,
    vendors: new Map([["context", {}]]),
    storage: {connectedAccounts: {get: (id: number) => records.get(id)}},
  });

  const pending = user.startAccountAppUi(7, {authority: {}} as AppUiContext);
  await entered;
  records.delete(7);
  releaseStart();

  await expect(pending).rejects.toThrow("No such app.");
  expect(dispose).toHaveBeenCalledOnce();
});

it("does not return an account expansion URL when optional access is revoked mid-request", async () => {
  let releaseRequest!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let enteredRequest!: () => void;
  const entered = new Promise<void>((resolve) => { enteredRequest = resolve; });
  let allowed = true;
  const account = {
    async ensureResources() {
      enteredRequest();
      await blocked;
      return {url: "https://vendor.example/connect"};
    },
  };
  const record = {id: 7, account, vendorId: "github", description: {}};
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    centralAuthMode: true,
    vendors: new Map([["github", {}]]),
    organizationDirectory: {
      getByName: () => ({
        resolveAppAccess: async () => ({
          allowed,
          mode: allowed ? "optional" : "disabled",
          sources: allowed ? ["direct:test"] : [],
        }),
      }),
    },
    storage: {
      profile: {get: () => ({id: "subject"})},
      connectedAccounts: {get: (id: number) => id === record.id ? record : undefined},
    },
  });

  const pending = user.ensureAccountResources(7, ["https://github.com/*"]);
  await entered;
  allowed = false;
  releaseRequest();

  await expect(pending).rejects.toThrow('The "github" app is not available to this user.');
});
