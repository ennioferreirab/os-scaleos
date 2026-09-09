import type { RpcStub } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedAccountsSubscriber, AppAccessResult } from "@gadgets/workshop-shared/api";
import type {
  AccountDescription, GatekeeperUser, GatekeeperVendor, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return {promise, resolve};
}

describe("UserDurableObject.subscribeConnectedAccounts", () => {
  it("does not add an account when app access is revoked during metadata reads", async () => {
    const describeStarted = deferred<void>();
    const describeResult = deferred<VendorDescription>();
    const resourcesStarted = deferred<void>();
    const resourcesResult = deferred<SupportedResource[]>();
    let allowed = true;

    const vendor = {
      describe: vi.fn(async () => {
        describeStarted.resolve();
        return describeResult.promise;
      }),
    } as unknown as Service<GatekeeperVendor>;
    const account = {
      getSupportedResources: vi.fn(async () => {
        resourcesStarted.resolve();
        return resourcesResult.promise;
      }),
    } as unknown as Fetcher<GatekeeperUser>;
    const description: AccountDescription = {avatar: {url: ""}, displayName: "Account"};
    const resources: SupportedResource[] = [];
    const record = {id: 0, account, description, vendorId: "test"};
    const connectedAccounts = {
      get: vi.fn((id: number) => id === record.id ? record : undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    };
    const resolveAppAccess = vi.fn(async (): Promise<AppAccessResult> => allowed
      ? {allowed: true, mode: "enabled", sources: ["test"]}
      : {allowed: false, mode: "disabled", sources: []});
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      centralAuthMode: true,
      vendors: new Map([["test", vendor]]),
      env: {BLUEPRINTS: {get: vi.fn(async () => null)}},
      organizationDirectory: {
        getByName: vi.fn(() => ({resolveAppAccess})),
      },
      storage: {
        profile: {get: vi.fn(() => ({id: "user@example.test"}))},
        nextAccountId: {get: vi.fn(() => 1)},
        connectedAccounts,
      },
    });

    const subscriber = {
      dup: vi.fn(() => subscriber),
      add: vi.fn(() => Promise.resolve()),
      remove: vi.fn(),
      ready: vi.fn(() => Promise.resolve()),
      [Symbol.dispose]: vi.fn(),
    } as unknown as RpcStub<ConnectedAccountsSubscriber>;

    const subscription = user.subscribeConnectedAccounts(subscriber);
    await describeStarted.promise;
    describeResult.resolve({displayName: "Vendor", url: "https://vendor.example"});
    await resourcesStarted.promise;
    allowed = false;
    resourcesResult.resolve(resources);

    const result = await subscription;
    expect(account.getSupportedResources).toHaveBeenCalledOnce();
    expect(subscriber.add).not.toHaveBeenCalled();
    expect(subscriber.remove).not.toHaveBeenCalled();
    result[Symbol.dispose]?.();
  });
});
