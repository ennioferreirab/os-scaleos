import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { LibraryReadSession } from "../src/library-read.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";

function deniedSession() {
  const appAccessError = new Error("app access denied");
  const assertAppAccess = vi.fn(async () => {
    throw appAccessError;
  });
  const authorizeObservation = vi.fn(async () => {});
  const collection = {
    search: vi.fn(async () => []),
    getMetadata: vi.fn(async () => undefined),
    listContextDocuments: vi.fn(async () => []),
    getContextDocument: vi.fn(async () => undefined),
  };
  const collections = {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => collection),
  } as unknown as DurableObjectNamespace<ContextCollectionDurableObject>;
  const getEnabledCollections = vi.fn(async () => new Map([["docs", "public" as const]]));
  const userLibraries = {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => ({ getEnabledCollections })),
  } as unknown as DurableObjectNamespace<UserLibraryDurableObject>;
  const authorizer = {assertAppAccess, authorizeObservation} as unknown as
      NativeRpcStub<ApprovalQueue>;
  const session = new LibraryReadSession(
    collections,
    userLibraries,
    "example.test",
    "account-a",
    authorizer,
    vi.fn(async () => ({pendingCollections: [], commit() {}})),
  );
  return {
    appAccessError,
    assertAppAccess,
    authorizeObservation,
    collection,
    getEnabledCollections,
    session,
  };
}

describe("LibraryReadSession", () => {
  it("preflights every retained read before touching library storage", async () => {
    const fixture = deniedSession();

    await expect(fixture.session.search("secret")).rejects.toBe(fixture.appAccessError);
    await expect(fixture.session.list()).rejects.toBe(fixture.appAccessError);
    await expect(fixture.session.read("docs/file.md")).rejects.toBe(fixture.appAccessError);

    expect(fixture.assertAppAccess).toHaveBeenCalledTimes(3);
    expect(fixture.getEnabledCollections).not.toHaveBeenCalled();
    expect(fixture.collection.search).not.toHaveBeenCalled();
    expect(fixture.collection.getMetadata).not.toHaveBeenCalled();
    expect(fixture.collection.listContextDocuments).not.toHaveBeenCalled();
    expect(fixture.collection.getContextDocument).not.toHaveBeenCalled();
    expect(fixture.authorizeObservation).not.toHaveBeenCalled();
  });
});
