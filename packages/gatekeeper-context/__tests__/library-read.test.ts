import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  ContextAuthorityCapability, ObservationAuthorizer,
} from "@gadgets/workshop-shared/gatekeeper";
import { LibraryReadSession } from "../src/library-read.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";

function deniedSession() {
  const appAccessError = new Error("app access denied");
  const authorizeObservation = vi.fn(async () => {});
  const authorityAssertAppAccess = vi.fn(async () => {
    throw appAccessError;
  });
  const collection = {
    search: vi.fn(async () => []),
    getAuthorizedSummary: vi.fn(async () => null),
    listContextDocuments: vi.fn(async () => []),
    getContextDocument: vi.fn(async () => undefined),
  };
  const collections = {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => collection),
  } as unknown as DurableObjectNamespace<ContextCollectionDurableObject>;
  const registries = {
    getByName: vi.fn(() => ({listCollections: vi.fn(async () => [])})),
  } as unknown as DurableObjectNamespace<LibraryRegistryDurableObject>;
  const duplicate = <T extends object>(value: T): T => ({
    ...value,
    dup: vi.fn(() => value),
  });
  const authority = duplicate({
    assertAppAccess: authorityAssertAppAccess,
    getActor: vi.fn(async () => ({subject: "subject-a", isOrgAdmin: false})),
    resolveAudience: vi.fn(async () => ({allowed: false, sources: []})),
    listAudienceTargets: vi.fn(async () => ({users: [], groups: []})),
  }) as unknown as ContextAuthorityCapability;
  const authorizer = duplicate({
    authorizeObservation,
  }) as unknown as NativeRpcStub<ObservationAuthorizer>;
  const session = new LibraryReadSession(
    collections,
    registries,
    "example.test",
    authority,
    authorizer,
    vi.fn(async () => ({pendingCollections: [], commit() {}})),
  );
  return {
    appAccessError,
    authorityAssertAppAccess,
    authorizeObservation,
    collection,
    session,
  };
}

describe("LibraryReadSession", () => {
  it("preflights every retained read before touching library storage", async () => {
    const fixture = deniedSession();

    await expect(fixture.session.search("secret")).rejects.toBe(fixture.appAccessError);
    await expect(fixture.session.list()).rejects.toBe(fixture.appAccessError);
    await expect(fixture.session.read("docs/file.md")).rejects.toBe(fixture.appAccessError);

    expect(fixture.authorityAssertAppAccess).toHaveBeenCalledTimes(3);
    expect(fixture.collection.search).not.toHaveBeenCalled();
    expect(fixture.collection.getAuthorizedSummary).not.toHaveBeenCalled();
    expect(fixture.collection.listContextDocuments).not.toHaveBeenCalled();
    expect(fixture.collection.getContextDocument).not.toHaveBeenCalled();
    expect(fixture.authorizeObservation).not.toHaveBeenCalled();
  });
});
