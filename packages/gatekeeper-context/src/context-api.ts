// Per-account management API exposed to the library iframe. Collection DOs own all authorization;
// this object only routes requests and coordinates discovery/projections.

import { RpcTarget } from "capnweb";
import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ContextAuthority, ContextAuthorityCapability, DirectoryAudienceTargets,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  CollectionGrant, ContextApi, ContextCollectionContent, ContextCollectionMetadata,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  ContextAccessEvent, ContextCollectionRole, ContextGrantRole, ContextGrantTargetType,
  ContextMutationReceipt, DEFAULT_GIT_BRANCH, EnabledCollectionInfo,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import { domainName } from "./domain.js";

type CollectionNamespace = DurableObjectNamespace<ContextCollectionDurableObject>;
type UserLibraryNamespace = DurableObjectNamespace<UserLibraryDurableObject>;
type RegistryNamespace = DurableObjectNamespace<LibraryRegistryDurableObject>;

const CONTEXT_NOT_FOUND = "NOT_FOUND";

function codedError(code: string, message: string): Error & {code: string} {
  return Object.assign(new Error(message), {code});
}

function payloadHash(input: {
  title: string;
  description: string;
  icon?: string;
  source: ContextCollectionContent["source"];
}): Promise<string> {
  return crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(input)),
  ).then(bytes => new Uint8Array(bytes).toHex());
}

function summaryForMetadata(metadata: ContextCollectionMetadata) {
  return {
    id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    icon: metadata.icon,
    visibility: "private" as const,
    documentCount: metadata.documentCount,
    lastUpdated: metadata.lastUpdated,
  };
}

async function liveCollectionSummaries(
    registries: RegistryNamespace,
    collections: CollectionNamespace,
    domain: string,
    authority: ContextAuthorityCapability,
): Promise<EnabledCollectionInfo[]> {
  let registry = registries.getByName(domain);
  let indexed = await registry.listCollections();
  let visible = await Promise.all(indexed.map(async summary => {
    try {
      return await collections
        .get(collections.idFromName(domainName(domain, summary.id)))
        .getAuthorizedSummary(authority);
    } catch (error) {
      if ((error as {code?: string})?.code === CONTEXT_NOT_FOUND) return null;
      throw error;
    }
  }));
  return visible.filter(summary => summary !== null);
}

/** Collections visible to this actor, resolved through each live Collection DO. */
export async function loadEnabledContextCollections(
    registries: RegistryNamespace,
    collections: CollectionNamespace,
    domain: string,
    authority: ContextAuthorityCapability,
): Promise<EnabledCollectionInfo[]> {
  return liveCollectionSummaries(registries, collections, domain, authority);
}

@validateRpc()
export class ContextApiImpl extends RpcTarget implements ContextApi {
  private readonly authority: NativeRpcStub<RpcTarget & ContextAuthority>;

  constructor(
    private env: Cloudflare.Env,
    private domain: string,
    private accountId: string,
    authority: NativeRpcStub<RpcTarget & ContextAuthority>,
    private collections: CollectionNamespace,
    private userLibraries: UserLibraryNamespace,
    private registries: RegistryNamespace,
  ) {
    super();
    if (!authority) throw new Error("Context authority is required.");
    this.authority = authority.dup();
  }

  #collection(id: string) {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib() {
    return this.userLibraries.get(
        this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #registry() {
    return this.registries.getByName(this.domain);
  }

  async #assertActive(): Promise<void> {
    await this.authority.assertAppAccess();
  }

  async #actor(): Promise<{subject: string; isOrgAdmin: boolean}> {
    await this.#assertActive();
    let actor = await this.authority.getActor();
    if (!actor?.subject) throw codedError("FORBIDDEN", "Context authority returned no Subject.");
    return actor;
  }

  async #claimLegacy(collectionId: string): Promise<void> {
    await this.#collection(collectionId).claimLegacyOwner(this.authority, this.accountId);
  }

  async #claimLegacyRows(): Promise<void> {
    let indexed = await this.#registry().listCollections();
    await Promise.all(indexed.map(async summary => {
      try {
        await this.#collection(summary.id).claimLegacyOwner(this.authority, this.accountId);
      } catch (error) {
        // A stale registry row is filtered by the live authorization lookup below.
        if ((error as {code?: string})?.code !== CONTEXT_NOT_FOUND) throw error;
      }
    }));
  }

  #assertArtifactsAvailable(): void {
    if (!this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
  }

  async getViewerInfo(): Promise<{isAdmin: boolean; supportsGitCollections: boolean}> {
    let actor = await this.#actor();
    return {isAdmin: actor.isOrgAdmin, supportsGitCollections: !!this.env.ARTIFACTS};
  }

  // --- Collection management ---

  async createCollection(input: {
    title: string;
    description: string;
    icon?: string;
    source?: ContextCollectionContent["source"];
    mutationId: string;
  }): Promise<{collectionId: string; receipt: ContextMutationReceipt}> {
    let actor = await this.#actor();
    let source = input.source ?? "web";
    if (source !== "web" && source !== "git") {
      throw codedError("INVALID_INPUT", `Unsupported collection source: ${source}`);
    }
    if (typeof input.mutationId !== "string" || !input.mutationId) {
      throw codedError("INVALID_INPUT", "mutationId is required.");
    }
    if (typeof input.title !== "string" || typeof input.description !== "string") {
      throw codedError("INVALID_INPUT", "title and description are required.");
    }

    let hash = await payloadHash({
      title: input.title,
      description: input.description,
      icon: input.icon,
      source,
    });
    let reservation = await this.#userLib().reserveCollectionCreation(
        actor.subject, input.mutationId, hash);
    if (reservation.status === "complete" && reservation.receipt) {
      return {collectionId: reservation.collectionId, receipt: reservation.receipt};
    }
    if (source === "git") this.#assertArtifactsAvailable();

    let created = new Date(reservation.reservedAt);
    let metadata: ContextCollectionMetadata = {
      id: reservation.collectionId,
      icon: input.icon,
      title: input.title,
      description: input.description,
      visibility: "private",
      created,
      lastUpdated: created,
      documentCount: 0,
      content: source === "git"
        ? {source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: created}
        : {source},
    };
    metadata = await this.#collection(reservation.collectionId).initialize(
        metadata, this.domain, this.authority, this.accountId);

    // Registry confirmation precedes completion of the account-owned projection and success.
    await this.#registry().upsertCollection(summaryForMetadata(metadata));
    let completed = await this.#userLib().completeCollectionCreation(
        actor.subject, input.mutationId, summaryForMetadata(metadata));
    if (!completed.receipt) {
      throw codedError("CONFLICT", "Collection creation completed without a receipt.");
    }
    return {collectionId: completed.collectionId, receipt: completed.receipt};
  }

  async updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void> {
    await this.#claimLegacy(collectionId);
    if (options.branch !== undefined) this.#assertArtifactsAvailable();
    await this.#collection(collectionId).updateMetadata(this.authority, options);
  }

  async syncContextCollectionArtifactSource(collectionId: string): Promise<void> {
    await this.#claimLegacy(collectionId);
    this.#assertArtifactsAvailable();
    await this.#collection(collectionId).syncArtifactSource(this.authority);
  }

  async createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult> {
    await this.#claimLegacy(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).createGitToken(this.authority);
  }

  async listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList> {
    await this.#claimLegacy(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).listGitTokens(this.authority);
  }

  async revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean> {
    await this.#claimLegacy(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).revokeGitToken(this.authority, tokenId);
  }

  async deleteContextCollection(collectionId: string): Promise<void> {
    await this.#claimLegacy(collectionId);
    await this.#collection(collectionId).deleteSelf(this.authority);
  }

  async getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null> {
    await this.#claimLegacy(collectionId);
    return this.#collection(collectionId).getMetadata(this.authority);
  }

  // --- Document editing ---

  async listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#claimLegacy(collectionId);
    return this.#collection(collectionId).listContextDocuments(this.authority, prefix);
  }

  async getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null> {
    await this.#claimLegacy(collectionId);
    return this.#collection(collectionId).getContextDocument(this.authority, path);
  }

  async putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    await this.#claimLegacy(collectionId);
    await this.#collection(collectionId).putContextDocument(this.authority, path, doc);
  }

  async deleteContextDocument(collectionId: string, path: string): Promise<void> {
    await this.#claimLegacy(collectionId);
    await this.#collection(collectionId).deleteContextDocument(this.authority, path);
  }

  async moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void> {
    await this.#claimLegacy(collectionId);
    await this.#collection(collectionId).moveContextDocument(this.authority, fromPath, toPath);
  }

  /** Active directory targets available to the authenticated Share picker. */
  async listAccessTargets(): Promise<DirectoryAudienceTargets> {
    await this.#assertActive();
    return this.authority.listAudienceTargets();
  }

  async listAccess(collectionId: string): Promise<CollectionGrant[]> {
    await this.#claimLegacy(collectionId);
    return this.#collection(collectionId).listAccess(this.authority);
  }

  async setAccess(input: {
    collectionId: string;
    targetType: ContextGrantTargetType;
    targetId: string;
    role: ContextGrantRole;
    mutationId: string;
  }): Promise<ContextMutationReceipt> {
    await this.#claimLegacy(input.collectionId);
    return this.#collection(input.collectionId).setAccess({
      authority: this.authority,
      targetType: input.targetType,
      targetId: input.targetId,
      role: input.role,
      mutationId: input.mutationId,
    });
  }

  async removeAccess(input: {
    collectionId: string;
    targetType: ContextGrantTargetType;
    targetId: string;
    mutationId: string;
  }): Promise<ContextMutationReceipt> {
    await this.#claimLegacy(input.collectionId);
    return this.#collection(input.collectionId).removeAccess({
      authority: this.authority,
      targetType: input.targetType,
      targetId: input.targetId,
      mutationId: input.mutationId,
    });
  }

  async getMyAccess(collectionId: string): Promise<{
    role: Exclude<ContextCollectionRole, "none">; sources: string[];
  }> {
    await this.#claimLegacy(collectionId);
    return this.#collection(collectionId).getMyAccess(this.authority);
  }

  async listAccessEvents(collectionId: string, limit?: number): Promise<ContextAccessEvent[]> {
    await this.#claimLegacy(collectionId);
    return this.#collection(collectionId).listAccessEvents(this.authority, limit);
  }

  async listEnabledContextCollections(): Promise<EnabledCollectionInfo[]> {
    await this.#assertActive();
    await this.#claimLegacyRows();
    return loadEnabledContextCollections(
        this.registries, this.collections, this.domain, this.authority);
  }

  [Symbol.dispose](): void {
    this.authority[Symbol.dispose]();
  }
}
