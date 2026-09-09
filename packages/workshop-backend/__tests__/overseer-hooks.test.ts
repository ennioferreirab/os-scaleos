import { RpcStub as NativeRpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeOverseer(hook: {
  enabled: boolean;
  callback?: object;
  ownerSubject?: string;
} | null = {
  enabled: true,
  callback: {},
  ownerSubject: "owner-subject",
}) {
  let authorizeObservation = vi.fn(async () => {});
  let submitAction = vi.fn(async () => {});
  let bindHook = vi.fn(async () => {});
  let assertGatekeeperCallerAccess = vi.fn(async (_id: number, _caller: unknown) => {
    if (!hook) throw new Error("Hook has been deleted.");
    if (!hook.enabled) throw new Error("Hook has been deleted or disabled.");
    return {...hook, gatekeeperId: 1};
  });
  let assertHookAccess = vi.fn(async (_id: number) => {
    if (!hook) throw new Error("Hook has been deleted.");
    if (!hook.enabled) throw new Error("Hook has been deleted or disabled.");
    return {...hook, gatekeeperId: 1};
  });
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {
    impl: {
      assertHookAccess, assertGatekeeperCallerAccess, authorizeObservation, submitAction, bindHook,
    },
  });
  return {
    overseer,
    calls: {
      assertHookAccess, assertGatekeeperCallerAccess, authorizeObservation, submitAction, bindHook,
    },
  };
}

describe("OverseerDurableObject.startHook", () => {
  it("rechecks retained callbacks and scopes every approval-queue operation to the hook", async () => {
    let fire = vi.fn(async (_value: string) => {});
    let callback = new NativeRpcStub(new (class extends RpcTarget {
      async onFire(value: string) {
        await fire(value);
      }
    })());
    let hook = {
      enabled: true,
      callback,
      ownerSubject: "owner-subject",
    };
    let {overseer, calls} = makeOverseer(hook);

    let started = await overseer.startHook(4);
    expect(calls.assertHookAccess).toHaveBeenCalledWith(4);

    let observation = {title: "Read", description: "Read data"};
    await started.approvalQueue.authorizeObservation(observation);
    expect(calls.authorizeObservation).toHaveBeenCalledWith(
        1, observation, {from: "hook", hookId: 4, ownerSubject: "owner-subject"});

    let action = {title: "Write", description: "Write data", implementsRevert: false};
    await started.approvalQueue.submitAction(7, action);
    expect(calls.submitAction).toHaveBeenCalledWith(
        1, 7, action, {from: "hook", hookId: 4, ownerSubject: "owner-subject"});
    await started.approvalQueue.assertAppAccess();
    expect(calls.assertGatekeeperCallerAccess).toHaveBeenCalledWith(
        1, {from: "hook", hookId: 4, ownerSubject: "owner-subject"});


    let controller = new NativeRpcStub(new (class extends RpcTarget {
      async enable() {}
      async disable() {}
    })());
    let hookCallback = new NativeRpcStub(new (class extends RpcTarget {})());
    let description = {title: "Nested", description: "Register nested hook"};
    await started.approvalQueue.bindHook(controller, hookCallback, description);
    expect(calls.bindHook).toHaveBeenCalledWith(
        1, controller, hookCallback, description,
        {from: "hook", hookId: 4, ownerSubject: "owner-subject"});

    const authorizedCallback = overseer.authorizedHookCallback(4, callback) as unknown as {
      onFire(value: string): Promise<void>;
    };
    await authorizedCallback.onFire("first");
    hook.enabled = false;
    await expect(authorizedCallback.onFire("denied"))
        .rejects.toThrow("Hook has been deleted or disabled.");
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("rejects delivery when the hook is disabled", async () => {
    let {overseer} = makeOverseer({enabled: false});
    await expect(overseer.startHook(4)).rejects.toThrow("Hook has been deleted or disabled.");
  });

  it("rejects delivery when the hook was deleted", async () => {
    let {overseer} = makeOverseer(null);
    await expect(overseer.startHook(4)).rejects.toThrow("Hook has been deleted.");
  });
});

async function makeTargetOverseer(gadgetId?: number) {
  let controllerEnable = vi.fn(async (_initiator: object, _target: object) => {});
  let record = {
    id: 4,
    actionId: 12,
    gatekeeperId: 1,
    gadgetId,
    controller: {enable: controllerEnable},
    callback: {},
    description: {title: "Incoming email", description: "Receives email"},
    enabled: false,
  };
  let client = await openFakeOverseer({
    boundHooks: {get: () => record, put: vi.fn()},
    actions: {get: () => undefined, put: vi.fn()},
  }, {exports: {GatekeeperHookLoopback: ({props}: {props: object}) => props}});
  return {client, controllerEnable};
}

describe("hook target", () => {

  it("passes the workspace and gadget IDs to enable()", async () => {
    let {client, controllerEnable} = await makeTargetOverseer(17);

    await client.enableHook(4);

    expect(controllerEnable).toHaveBeenCalledTimes(1);
    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id", gadgetId: 17});
  });

  it("omits the gadget ID for a hook that is not pinned to one", async () => {
    let {client, controllerEnable} = await makeTargetOverseer();

    await client.enableHook(4);

    expect(controllerEnable.mock.calls[0][1]).toEqual({workspaceId: "workspace-id"});
  });

});
