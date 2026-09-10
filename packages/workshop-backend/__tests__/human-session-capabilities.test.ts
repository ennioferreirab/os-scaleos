import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_ERROR_CODES } from "@gadgets/workshop-shared/api";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

describe("transitive human session capabilities", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects an existing Overseer and its derived Gadget capability at token expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = makeActionStorage();
    storage.gadgets.put({
      id: 7,
      title: "Guarded gadget",
      created: new Date(0),
      bindingName: "GUARDED_GADGET",
      commitId: "0".repeat(40),
      bindings: {},
    });
    const overseer = await openFakeOverseer(storage, {expiresAtMs: 2_000});
    const gadget = await overseer.getGadget(7);
    expect(await gadget.getId()).toBe(7);

    vi.setSystemTime(2_000);
    await expect(overseer.getMetadata())
        .rejects.toMatchObject({code: AUTH_ERROR_CODES.unauthenticated});
    await expect(gadget.getId())
        .rejects.toMatchObject({code: AUTH_ERROR_CODES.unauthenticated});
  });
});
