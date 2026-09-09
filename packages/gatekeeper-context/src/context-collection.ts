// One collection's metadata and documents. Metadata changes update the all-collection registry and
// owner-summary projection; the Collection DO remains the authorization authority.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type {
  Audience, ContextAuthorityCapability,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  CollectionGrant, ContextAccessEvent, ContextCollectionContent, ContextCollectionMetadata,
  ContextCollectionRole, ContextCollectionSummary, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  ContextGrantRole, ContextGrantTargetType, ContextMutationReceipt, EnabledCollectionInfo,
  DEFAULT_DOCUMENT_CONTENT_TYPE, DEFAULT_GIT_BRANCH, MAX_DOCUMENT_BODY_BYTES,
  contentTypeFromPath, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import { domainName } from "./domain.js";
import {
  readArtifactRepoDocuments, type ArtifactContextDocument,
} from "./artifact-sync.js";
import {
  isSkillManifestPath, parseSkillManifest, type SkillIndexEntry,
} from "./agent-skill.js";
import { obsContext } from "./observability.js";
import {
  decodeStoredContextBody, encodeStoredContextBody, truncateContextDescription,
} from "./context-storage.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

const MAX_DOCUMENT_PATH_LENGTH = 1024;
// Git tokens created through the web UI are valid for one year,
// the maximum TTL supported by Artifacts.
const GIT_TOKEN_TTL_SECONDS = 31_536_000;
// Background git refresh happens minutely at most.
const GIT_REFRESH_MIN_INTERVAL_MS = 60_000;
// Allow simple branch names made of alphanumerics, '/', '.', '_', and '-', but not leading/trailing '/'.
const GIT_BRANCH_RE = /^(?!\/)(?!.*\/$)[A-Za-z0-9/._-]{1,255}$/;
// Older collections build this path list on first use. Increase the version when parsing rules
// change.
const SKILL_INDEX_VERSION = 1;

const CONTEXT_NOT_FOUND = "NOT_FOUND";
const CONTEXT_CONFLICT = "CONFLICT";
const CONTEXT_FORBIDDEN = "FORBIDDEN";
const CONTEXT_INVALID_INPUT = "INVALID_INPUT";
const MAX_ACCESS_EVENT_LIMIT = 200;


function codedError(code: string, message: string): Error & {code: string} {
  return Object.assign(new Error(message), {code});
}

function notFoundError(): Error & {code: string} {
  return codedError(CONTEXT_NOT_FOUND, "Collection not found or you don't have access.");
}

function conflictError(message: string): Error & {code: string} {
  return codedError(CONTEXT_CONFLICT, message);
}

function forbiddenError(message = "Collection access denied."): Error & {code: string} {
  return codedError(CONTEXT_FORBIDDEN, message);
}

function invalidInputError(message: string): Error & {code: string} {
  return codedError(CONTEXT_INVALID_INPUT, message);
}
function requireAuthority(authority: ContextAuthorityCapability): ContextAuthorityCapability {
  if (!authority) throw forbiddenError("Context authority is required.");
  return authority;
}
function grantKey(targetType: ContextGrantTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}


function eventId(collectionId: string, action: string, mutationId: string): string {
  return `${collectionId}:${action}:${mutationId}`;
}

function metadataToSummary(metadata: ContextCollectionMetadata): ContextCollectionSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    icon: metadata.icon,
    visibility: "private",
    documentCount: metadata.documentCount,
    lastUpdated: metadata.lastUpdated,
  };
}

// Validate a document path before using it as a storage key.
function validateDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

// Last path segment; document names derive from paths.
function baseName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

// Lowercased file extension (without the dot), or "" if none.
function extOf(path: string): string {
  let b = baseName(path);
  let i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
}

type ContextRecord = {
  path: string;
  name: string;
  description: string;
  contentType: string;
  // Text is stored as UTF-8 and binary as raw bytes to keep SQLite values close to source size.
  // Legacy records have string bodies: literal text or base64 for binary content.
  body: string | Uint8Array;
  lastUpdated: Date;
};

function contextRecord(document: ContextDocument): ContextRecord & { body: Uint8Array } {
  return {
    ...document,
    description: truncateContextDescription(document.description),
    body: encodeStoredContextBody(document.contentType, document.body),
  };
}

// Old records that predate git-based collections won't have `content` set in storage.
// Unset `content` is defaulted to { "source": "web" } at the API layer, which is why
// we have different types for storage vs. API interface.
type StoredContextCollectionMetadata = Omit<ContextCollectionMetadata, "content"> & {
  content?: ContextCollectionContent;
};

function makeContextCollectionStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      documents: collection<ContextRecord>()({primaryKey: "path"}),
      // Data needed to list skills without loading document bodies.
      skillIndex: collection<SkillIndexEntry>()({primaryKey: "path"}),
      accessGrants: collection<CollectionGrant>()({primaryKey: "key"}),
      accessMutations: collection<{
        key: string;
        requestHash: string;
        receipt: ContextMutationReceipt;
      }>()({primaryKey: "key"}),
      accessEvents: collection<ContextAccessEvent>()({primaryKey: "eventId"}),
    },
    singletons: {
      // Sharing domain for cross-DO references.
      sharingDomain: "",
      // Legacy connection index only. It is never used for human authorization.
      ownerAccountId: "",
      ownerSubject: "",
      accessVersion: 0,
      metadata: <StoredContextCollectionMetadata>{
        id: "",
        title: "",
        description: "",
        visibility: "private" as ContextCollectionVisibility,
        created: new Date(0),
        lastUpdated: new Date(0),
        documentCount: 0,
        content: {source: "web"},
      },
      skillIndexVersion: 0,
    },
  });
}
type ContextCollectionStorage = ReturnType<typeof makeContextCollectionStorage>;

export class ContextCollectionDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ContextCollectionStorage;
  // Set when an artifact refresh operation is in flight. Additional refresh requests should
  // await this promise when set instead of kicking off additional concurrent refreshes.
  #artifactRefresh?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeContextCollectionStorage(ctx.storage);
  }

  // Sharing domain for all cross-DO references.
  #domain(): string {
    return this.storage.sharingDomain.get();
  }

  // The UserLibrary projection remains routed by the stable Context connection account. It is not
  // an identity or authorization source; ownerSubject below is the sole human owner.
  #ownerLibrary() {
    let ns = this.ctx.exports.UserLibraryDurableObject;
    return ns.get(ns.idFromName(domainName(this.#domain(), this.storage.ownerAccountId.get())));
  }

  #registry() {
    let ns = this.ctx.exports.LibraryRegistryDurableObject;
    return ns.getByName(this.#domain());
  }

  #artifacts(): Artifacts {
    let artifacts = this.env.ARTIFACTS;
    if (!artifacts) throw new Error("Git-backed Context collections are not enabled.");
    return artifacts;
  }

  async #createArtifactRepo(metadata: ContextCollectionMetadata): Promise<string> {
    // Artifact repo id is always set to collection id.
    let artifacts = this.#artifacts();
    let created = await artifacts.create(metadata.id, {
      setDefaultBranch: DEFAULT_GIT_BRANCH,
    });

    let repo = await artifacts.get(metadata.id);
    // Artifacts auto-creates an initial write token when the repo is first
    // created. We don't want or need this token, so we immediately revoke it.
    await repo.revokeToken(created.token).catch((err) => {
      logger.warn("failed to revoke initial Artifacts token for context collection", {
        event: "artifacts.initial.token.revoke.failed",
        collectionId: metadata.id,
        error: err,
      });
    });
    return created.remote;
  }

  #metadata(): ContextCollectionMetadata {
    let meta = this.storage.metadata.get();
    // Old storage records won't have `content` set, so default those values at the API boundary.
    return {...meta, content: meta.content ?? {source: "web"}};
  }

  #requireMetadata(): ContextCollectionMetadata {
    let metadata = this.#metadata();
    if (!metadata.id) throw notFoundError();
    return metadata;
  }

  async #actor(authority: ContextAuthorityCapability): Promise<{
    subject: string; isOrgAdmin: boolean;
  }> {
    authority = requireAuthority(authority);
    await authority.assertAppAccess();
    let actor = await authority.getActor();
    if (!actor || typeof actor.subject !== "string" || !actor.subject) {
      throw forbiddenError("Context authority returned no Subject.");
    }
    return actor;
  }
  async #resolveRoleForActor(
      authority: ContextAuthorityCapability, actor: {subject: string; isOrgAdmin: boolean}):
      Promise<{role: ContextCollectionRole; sources: string[]}> {
    this.#requireMetadata();
    let ownerSubject = this.storage.ownerSubject.get();
    if (ownerSubject && ownerSubject === actor.subject) {
      return {role: "owner", sources: ["owner"]};
    }

    let editorAudience: Audience = {everyone: false, userIds: [], groupIds: []};
    let readerAudience: Audience = {everyone: false, userIds: [], groupIds: []};
    for (let grant of this.storage.accessGrants.list()) {
      let audience = grant.role === "editor" ? editorAudience : readerAudience;
      if (grant.targetType === "everyone") audience.everyone = true;
      else if (grant.targetType === "user") audience.userIds.push(grant.targetId);
      else audience.groupIds.push(grant.targetId);
    }

    if (editorAudience.everyone || editorAudience.userIds.length > 0 ||
        editorAudience.groupIds.length > 0) {
      let resolved = await authority.resolveAudience(editorAudience);
      if (resolved.allowed) {
        return {role: "editor", sources: [...new Set(resolved.sources)].toSorted()};
      }
    }
    if (readerAudience.everyone || readerAudience.userIds.length > 0 ||
        readerAudience.groupIds.length > 0) {
      let resolved = await authority.resolveAudience(readerAudience);
      if (resolved.allowed) {
        return {role: "reader", sources: [...new Set(resolved.sources)].toSorted()};
      }
    }
    return {role: "none", sources: []};
  }

  async resolveCollectionRole(authority: ContextAuthorityCapability): Promise<{
    role: ContextCollectionRole; sources: string[];
  }> {
    let trustedAuthority = requireAuthority(authority);
    let actor = await this.#actor(trustedAuthority);
    return this.#resolveRoleForActor(trustedAuthority, actor);
  }
  async getAuthorizedSummary(
      authority: ContextAuthorityCapability): Promise<EnabledCollectionInfo | null> {
    let access = await this.resolveCollectionRole(authority);
    if (access.role === "none") return null;
    let metadata = this.#requireMetadata();
    return {
      id: metadata.id,
      title: metadata.title,
      description: metadata.description,
      icon: metadata.icon,
      role: access.role,
      sources: access.sources,
      lastUpdated: metadata.lastUpdated,
    };
  }

  async getMetadata(authority: ContextAuthorityCapability): Promise<ContextCollectionMetadata> {
    await this.#assertRole(authority, "reader");
    return this.#requireMetadata();
  }

  /**
   * Initialize a private collection from a trusted authority. Subject and ownership are obtained
   * from the authority, never accepted as caller-provided identity.
   */
  async initialize(
      metadata: ContextCollectionMetadata, sharingDomain: string,
      authority: ContextAuthorityCapability, ownerAccountId: string): Promise<ContextCollectionMetadata> {
    let actor = await this.#actor(authority);
    if (metadata.visibility !== "private") {
      throw invalidInputError("Context collections must be private.");
    }
    let existing = this.#metadata();
    if (existing.id) {
      if (this.storage.ownerSubject.get() !== actor.subject ||
          this.storage.ownerAccountId.get() !== ownerAccountId ||
          existing.title !== metadata.title ||
          existing.description !== metadata.description ||
          existing.icon !== metadata.icon ||
          existing.content.source !== metadata.content.source) {
        throw conflictError("Collection already exists with a different owner or payload.");
      }
      return existing;
    }
    this.storage.sharingDomain.put(sharingDomain);
    this.storage.ownerSubject.put(actor.subject);
    this.storage.ownerAccountId.put(ownerAccountId);
    if (metadata.content.source === "git") {
      metadata.content = {
        source: "git",
        remote: await this.#createArtifactRepo(metadata),
        branch: metadata.content.branch,
        lastRefreshedAt: metadata.created,
      };
    }
    this.storage.metadata.put(metadata);
    // A new collection starts with an up-to-date empty path list.
    this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    this.storage.accessVersion.put(0);
    return metadata;
  }

  /**
   * One-time migration of a legacy private collection. The account id is only a trusted connection
   * index supplied by ContextAccount; the new owner is always the current authority Subject.
   */
  async claimLegacyOwner(
      authority: ContextAuthorityCapability, accountId: string): Promise<boolean> {
    let actor = await this.#actor(authority);
    let metadata = this.#requireMetadata();
    if (this.storage.ownerSubject.get()) {
      return this.storage.ownerSubject.get() === actor.subject;
    }
    if (metadata.visibility !== "private" || !this.storage.ownerAccountId.get() ||
        this.storage.ownerAccountId.get() !== accountId) {
      return false;
    }
    this.storage.ownerSubject.put(actor.subject);
    return true;
  }

  async #assertRole(
      authority: ContextAuthorityCapability, required: "reader" | "editor" | "owner"): Promise<{
    role: ContextCollectionRole; sources: string[];
  }> {
    let trustedAuthority = requireAuthority(authority);
    let actor = await this.#actor(trustedAuthority);
    let access = await this.#resolveRoleForActor(trustedAuthority, actor);
    if (access.role === "none") throw notFoundError();
    let rank: Record<ContextCollectionRole, number> = {
      none: 0, reader: 1, editor: 2, owner: 3,
    };
    if (rank[access.role] < rank[required]) {
      throw forbiddenError("The current role cannot perform this collection operation.");
    }
    return access;
  }

  async #assertOwner(authority: ContextAuthorityCapability): Promise<{
    actor: {subject: string; isOrgAdmin: boolean};
    access: {role: ContextCollectionRole; sources: string[]};
  }> {
    let trustedAuthority = requireAuthority(authority);
    let actor = await this.#actor(trustedAuthority);
    let access = await this.#resolveRoleForActor(trustedAuthority, actor);
    if (access.role === "none") throw notFoundError();
    if (access.role !== "owner") {
      throw forbiddenError("Only the collection owner may perform this operation.");
    }
    return {actor, access};
  }

  async #validateAccessTarget(
      authority: ContextAuthorityCapability,
      targetType: ContextGrantTargetType,
      targetId: string,
      role: ContextGrantRole,
  ): Promise<void> {
    if (targetType === "everyone") {
      if (targetId !== "" || role !== "reader") {
        throw invalidInputError("Everyone grants require an empty targetId and reader role.");
      }
      return;
    }
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw invalidInputError("A user or group targetId is required.");
    }
    let targets = await requireAuthority(authority).listAudienceTargets();
    if (targetType === "user") {
      if (!targets.users.some(target => target.userId === targetId)) {
        throw invalidInputError("Access target must be an active directory user.");
      }
      return;
    }
    if (targetType === "group") {
      if (!targets.groups.some(target => target.groupId === targetId)) {
        throw invalidInputError("Access target must be an active directory group.");
      }
      return;
    }
    throw invalidInputError("Unsupported access target type.");
  }

  async listAccess(authority: ContextAuthorityCapability): Promise<CollectionGrant[]> {
    await this.#assertOwner(authority);
    return [...this.storage.accessGrants.list()]
        .toSorted((left, right) => left.key.localeCompare(right.key));
  }

  async setAccess(input: {
    authority: ContextAuthorityCapability;
    targetType: ContextGrantTargetType;
    targetId: string;
    role: ContextGrantRole;
    mutationId: string;
  }): Promise<ContextMutationReceipt> {
    let authority = requireAuthority(input.authority);
    let owner = await this.#assertOwner(authority);
    if (typeof input.mutationId !== "string" || !input.mutationId) {
      throw invalidInputError("mutationId is required.");
    }
    if (input.targetType !== "everyone" && input.targetType !== "user" &&
        input.targetType !== "group") {
      throw invalidInputError("Unsupported access target type.");
    }
    if (input.role !== "reader" && input.role !== "editor") {
      throw invalidInputError("Unsupported access role.");
    }

    // The mutation identity is actor + id. Include the operation in the payload hash so an id
    // cannot be reused for a different operation.
    let key = `${owner.actor.subject}\u0000${input.mutationId}`;
    let requestHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({
          action: "setAccess",
          targetType: input.targetType,
          targetId: input.targetId,
          role: input.role,
        }))).then(bytes => new Uint8Array(bytes).toHex());
    let completed = this.storage.accessMutations.get(key);
    if (completed) {
      if (completed.requestHash !== requestHash) {
        throw conflictError("mutationId was already used with a different access payload.");
      }
      return completed.receipt;
    }

    // Validate only new mutations. A replay must return its original receipt even if a referenced
    // directory group has since been deleted or disabled.
    await this.#validateAccessTarget(authority, input.targetType, input.targetId, input.role);
    let collectionId = this.#requireMetadata().id;
    let targetKey = grantKey(input.targetType, input.targetId);
    let receipt!: ContextMutationReceipt;
    let replay: ContextMutationReceipt | undefined;
    this.storage.transaction(() => {
      let raced = this.storage.accessMutations.get(key);
      if (raced) {
        if (raced.requestHash !== requestHash) {
          throw conflictError("mutationId was already used with a different access payload.");
        }
        replay = raced.receipt;
        return;
      }
      let now = new Date().toISOString();
      let accessVersion = this.storage.accessVersion.get() + 1;
      let previous = this.storage.accessGrants.get(targetKey);
      receipt = {
        version: 1,
        accessVersion,
        mutationId: input.mutationId,
        actorSubject: owner.actor.subject,
        action: "setAccess",
        collectionId,
        targetType: input.targetType,
        targetId: input.targetId,
        role: input.role,
        confirmedAt: now,
      };
      let event: ContextAccessEvent = {
        version: 1,
        accessVersion,
        eventId: eventId(collectionId, "setAccess", input.mutationId),
        collectionId,
        mutationId: input.mutationId,
        actorSubject: owner.actor.subject,
        targetType: input.targetType,
        targetId: input.targetId,
        action: "setAccess",
        role: input.role,
        occurredAt: now,
        receipt,
      };
      this.storage.accessGrants.put({
        key: targetKey,
        targetType: input.targetType,
        targetId: input.targetId,
        role: input.role,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      this.storage.accessVersion.put(accessVersion);
      this.storage.accessMutations.put({key, requestHash, receipt});
      this.storage.accessEvents.put(event);
    });
    return replay ?? receipt;
  }

  async removeAccess(input: {
    authority: ContextAuthorityCapability;
    targetType: ContextGrantTargetType;
    targetId: string;
    mutationId: string;
  }): Promise<ContextMutationReceipt> {
    let authority = requireAuthority(input.authority);
    let owner = await this.#assertOwner(authority);
    if (typeof input.mutationId !== "string" || !input.mutationId) {
      throw invalidInputError("mutationId is required.");
    }
    if (input.targetType !== "everyone" && input.targetType !== "user" &&
        input.targetType !== "group") {
      throw invalidInputError("Unsupported access target type.");
    }
    if (input.targetType === "everyone" && input.targetId !== "") {
      throw invalidInputError("Everyone grants require an empty targetId.");
    }
    if (input.targetType !== "everyone" &&
        (typeof input.targetId !== "string" || !input.targetId)) {
      throw invalidInputError("A user or group targetId is required.");
    }

    let key = `${owner.actor.subject}\u0000${input.mutationId}`;
    let requestHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({
          action: "removeAccess",
          targetType: input.targetType,
          targetId: input.targetId,
        }))).then(bytes => new Uint8Array(bytes).toHex());
    let completed = this.storage.accessMutations.get(key);
    if (completed) {
      if (completed.requestHash !== requestHash) {
        throw conflictError("mutationId was already used with a different access payload.");
      }
      return completed.receipt;
    }

    let collectionId = this.#requireMetadata().id;
    let targetKey = grantKey(input.targetType, input.targetId);
    let receipt!: ContextMutationReceipt;
    let replay: ContextMutationReceipt | undefined;
    this.storage.transaction(() => {
      let raced = this.storage.accessMutations.get(key);
      if (raced) {
        if (raced.requestHash !== requestHash) {
          throw conflictError("mutationId was already used with a different access payload.");
        }
        replay = raced.receipt;
        return;
      }
      let now = new Date().toISOString();
      let accessVersion = this.storage.accessVersion.get() + 1;
      let previous = this.storage.accessGrants.get(targetKey);
      receipt = {
        version: 1,
        accessVersion,
        mutationId: input.mutationId,
        actorSubject: owner.actor.subject,
        action: "removeAccess",
        collectionId,
        targetType: input.targetType,
        targetId: input.targetId,
        ...(previous ? {role: previous.role} : {}),
        confirmedAt: now,
      };
      let event: ContextAccessEvent = {
        version: 1,
        accessVersion,
        eventId: eventId(collectionId, "removeAccess", input.mutationId),
        collectionId,
        mutationId: input.mutationId,
        actorSubject: owner.actor.subject,
        targetType: input.targetType,
        targetId: input.targetId,
        action: "removeAccess",
        ...(previous ? {role: previous.role} : {}),
        occurredAt: now,
        receipt,
      };
      this.storage.accessGrants.delete(targetKey);
      this.storage.accessVersion.put(accessVersion);
      this.storage.accessMutations.put({key, requestHash, receipt});
      this.storage.accessEvents.put(event);
    });
    return replay ?? receipt;
  }

  async getMyAccess(authority: ContextAuthorityCapability): Promise<{
    role: Exclude<ContextCollectionRole, "none">; sources: string[];
  }> {
    let access = await this.resolveCollectionRole(authority);
    if (access.role === "none") throw notFoundError();
    return access as {
      role: Exclude<ContextCollectionRole, "none">; sources: string[];
    };
  }

  async listAccessEvents(
      authority: ContextAuthorityCapability,
      limit = MAX_ACCESS_EVENT_LIMIT): Promise<ContextAccessEvent[]> {
    let trustedAuthority = requireAuthority(authority);
    let actor = await this.#actor(trustedAuthority);
    if (!actor.isOrgAdmin) {
      let access = await this.#resolveRoleForActor(trustedAuthority, actor);
      if (access.role === "none") throw notFoundError();
      if (access.role !== "owner") {
        throw forbiddenError("Only the collection owner or an organization admin may view ACL events.");
      }
    }
    let bounded = Number.isFinite(limit)
      ? Math.max(1, Math.min(MAX_ACCESS_EVENT_LIMIT, Math.floor(limit)))
      : MAX_ACCESS_EVENT_LIMIT;
    return [...this.storage.accessEvents.list()]
        .toSorted((left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.eventId.localeCompare(left.eventId))
        .slice(0, bounded);
  }

  #parseAgentSkill(record: ContextRecord) {
    if (!isSkillManifestPath(record.path) ||
        !isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE)) {
      return undefined;
    }
    try {
      return parseSkillManifest(
        record.path,
        decodeStoredContextBody(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE, record.body),
      );
    } catch {
      return undefined;
    }
  }

  // Update the skill entry after saving a document.
  #updateSkillIndex(record: ContextRecord): void {
    let manifest = this.#parseAgentSkill(record);
    if (manifest) {
      this.storage.skillIndex.put({
        path: record.path,
        skillName: manifest.name,
        description: manifest.description,
      });
    } else {
      this.storage.skillIndex.delete(record.path);
    }
  }

  // Save a document and update its skill entry together.
  #putDocument(record: ContextRecord): void {
    this.storage.documents.put(record);
    this.#updateSkillIndex(record);
  }

  // Delete a document and its skill entry together.
  #deleteDocument(path: string): void {
    this.storage.documents.delete(path);
    this.storage.skillIndex.delete(path);
  }

  #clearSkillIndex(): void {
    // Read the entries before deleting from the same storage collection.
    for (let entry of Array.from(this.storage.skillIndex.list())) {
      this.storage.skillIndex.delete(entry.path);
    }
  }

  // Build the index for collections created before it existed.
  #ensureSkillIndex(): void {
    if (this.storage.skillIndexVersion.get() === SKILL_INDEX_VERSION) return;

    let entries: SkillIndexEntry[] = [];
    for (let record of this.storage.documents.list()) {
      let manifest = this.#parseAgentSkill(record);
      if (manifest) {
        entries.push({
          path: record.path,
          skillName: manifest.name,
          description: manifest.description,
        });
      }
    }

    this.storage.transaction(() => {
      this.#clearSkillIndex();
      for (let entry of entries) {
        this.storage.skillIndex.put(entry);
      }
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  async listAgentSkills(authority: ContextAuthorityCapability): Promise<SkillIndexEntry[]> {
    await this.#assertRole(authority, "reader");
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    this.#ensureSkillIndex();
    return [...this.storage.skillIndex.list()];
  }

  async updateMetadata(
      authority: ContextAuthorityCapability, options: {
    title?: string;
    description?: string;
    icon?: string;
    branch?: string;
  }): Promise<void> {
    await this.#assertRole(authority, "owner");
    let meta = this.#metadata();
    let changed = false;

    if (options.title !== undefined && options.title !== meta.title) { meta.title = options.title; changed = true; }
    if (options.description !== undefined && options.description !== meta.description) { meta.description = options.description; changed = true; }
    if (options.icon !== undefined && options.icon !== meta.icon) { meta.icon = options.icon; changed = true; }
    if (options.branch !== undefined) {
      if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
      let branch = options.branch.trim();
      if (!GIT_BRANCH_RE.test(branch)) throw new Error("Git branch is invalid.");
      if (branch !== meta.content.branch) {
        meta.content.branch = branch;
        delete meta.content.commit;
        changed = true;
      }
    }

    if (changed) {
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
      await this.#propagate();
    }
  }

  // --- Document CRUD ---

  #assertWebWritable(): void {
    if (this.#isGitBased()) {
      throw new Error("Git-based collections are read-only. All changes must be made through git.");
    }
  }

  async listContextDocuments(
      authority: ContextAuthorityCapability, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#assertRole(authority, "reader");
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();
    let options = prefix ? {prefix} : undefined;
    let result: ContextDocumentSummary[] = [];
    for (let record of this.storage.documents.list(options)) {
      let manifest = this.#parseAgentSkill(record);
      result.push({
        path: record.path,
        name: record.name,
        description: manifest?.description ?? record.description,
        contentType: record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE,
        ...(manifest ? {skillName: manifest.name} : {}),
        lastUpdated: record.lastUpdated,
      });
    }
    return result;
  }

  /** Lenient read: bad/missing paths return null, not RPC errors. Mutations validate paths. */
  async getContextDocument(
      authority: ContextAuthorityCapability, path: string): Promise<ContextDocument | null> {
    await this.#assertRole(authority, "reader");
    // Trigger git mirror revalidation in the background on reads.
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let record = this.storage.documents.get(path);
    if (!record) return null;
    let contentType = record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE;
    let manifest = this.#parseAgentSkill(record);
    return {
      path: record.path,
      name: record.name,
      description: manifest?.description ?? record.description,
      contentType,
      body: decodeStoredContextBody(contentType, record.body),
      ...(manifest ? {skillName: manifest.name} : {}),
      lastUpdated: record.lastUpdated,
    };
  }

  async putContextDocument(
      authority: ContextAuthorityCapability, path: string,
      doc: {description: string; body: string; contentType?: string}): Promise<void> {
    await this.#assertRole(authority, "editor");
    this.#assertWebWritable();
    validateDocumentPath(path);
    let contentType = doc.contentType || contentTypeFromPath(path);
    let record = contextRecord({
      path, name: baseName(path), description: doc.description, contentType, body: doc.body,
      lastUpdated: new Date(),
    });
    let byteLength = record.body.byteLength + new TextEncoder().encode(
      JSON.stringify({...record, body: ""}),
    ).byteLength;
    if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(`Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }

    this.storage.transaction(() => {
      let isNew = !this.storage.documents.get(path);
      // Use the file name from the path as the display name.
      this.#putDocument(record);

      let meta = this.#metadata();
      if (isNew) meta.documentCount++;
      meta.lastUpdated = record.lastUpdated;
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async deleteContextDocument(
      authority: ContextAuthorityCapability, path: string): Promise<void> {
    await this.#assertRole(authority, "editor");
    this.#assertWebWritable();
    // Mutations reject invalid paths; reads stay lenient.
    validateDocumentPath(path);
    let existing = this.storage.documents.get(path);
    if (!existing) throw new Error(`Document not found: ${path}`);

    this.storage.transaction(() => {
      this.#deleteDocument(path);

      let meta = this.#metadata();
      meta.documentCount = Math.max(0, meta.documentCount - 1);
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  async moveContextDocument(
      authority: ContextAuthorityCapability, from: string, to: string): Promise<void> {
    await this.#assertRole(authority, "editor");
    this.#assertWebWritable();
    validateDocumentPath(from);
    validateDocumentPath(to);
    if (from === to) return;

    // Reject moving a folder into one of its own descendants.
    if (to.startsWith(from + "/")) {
      throw new Error("Cannot move a folder into itself.");
    }

    let moves: {record: ContextRecord; newPath: string}[] = [];
    let exact = this.storage.documents.get(from);
    if (exact) {
      moves.push({record: exact, newPath: to});
    } else {
      let fromPrefix = from.endsWith("/") ? from : from + "/";
      let toPrefix = to.endsWith("/") ? to : to + "/";
      for (let record of this.storage.documents.list({prefix: fromPrefix})) {
        moves.push({record, newPath: toPrefix + record.path.slice(fromPrefix.length)});
      }
    }

    if (moves.length === 0) throw new Error(`Nothing to move at: ${from}`);

    let movedFrom = new Set(moves.map(m => m.record.path));
    for (let m of moves) {
      if (!movedFrom.has(m.newPath) && this.storage.documents.get(m.newPath)) {
        throw new Error(`Destination already exists: ${m.newPath}`);
      }
    }

    this.storage.transaction(() => {
      for (let m of moves) {
        this.#deleteDocument(m.record.path);
      }
      for (let m of moves) {
        // Update the file name and content type for the new path.
        let contentType = extOf(m.record.path) !== extOf(m.newPath)
          ? contentTypeFromPath(m.newPath)
          : m.record.contentType;
        let record: ContextRecord = {
          ...m.record,
          path: m.newPath,
          name: baseName(m.newPath),
          contentType,
          lastUpdated: new Date(),
        };
        this.#putDocument(record);
      }

      let meta = this.#metadata();
      meta.lastUpdated = new Date();
      this.storage.metadata.put(meta);
    });
    await this.#propagate();
  }

  // --- Artifact-backed projection ---

  async syncArtifactSource(authority: ContextAuthorityCapability): Promise<void> {
    await this.#assertRole(authority, "owner");
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    await this.#refreshArtifactSource();
  }

  async createGitToken(
      authority: ContextAuthorityCapability): Promise<ContextGitTokenCreateResult> {
    await this.#assertRole(authority, "owner");
    let meta = this.#metadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    let repo = await this.#artifacts().get(meta.id);
    let token = await repo.createToken("write", GIT_TOKEN_TTL_SECONDS);
    return {
      id: token.id,
      plaintext: token.plaintext,
      remote: meta.content.remote,
    };
  }

  async listGitTokens(
      authority: ContextAuthorityCapability): Promise<ContextGitTokenList> {
    await this.#assertRole(authority, "owner");
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.#metadata();
    let repo = await this.#artifacts().get(meta.id);
    let result = await repo.listTokens();
    return {
      tokens: result.tokens
        // User-created tokens for mirror setup are always write tokens. This DO
        // mints its own read tokens for cloning the repo into memory which we
        // don't want to expose the user.
        .filter(token => token.scope === "write" && token.state === "active")
        .map(token => ({
          id: token.id,
          expiresAt: token.expiresAt,
        })),
    };
  }

  async revokeGitToken(
      authority: ContextAuthorityCapability, tokenId: string): Promise<boolean> {
    await this.#assertRole(authority, "owner");
    if (!this.#isGitBased()) throw new Error("Collection is not git-based.");
    let meta = this.#metadata();
    let repo = await this.#artifacts().get(meta.id);
    return repo.revokeToken(tokenId);
  }

  #isGitBased(): boolean {
    return this.#metadata().content.source === "git";
  }

  #startBackgroundArtifactRefresh(): void {
    if (!this.env.ARTIFACTS) return;
    let content = this.#metadata().content;
    if (content.source !== "git") return;
    if (Date.now() - content.lastRefreshedAt.getTime() < GIT_REFRESH_MIN_INTERVAL_MS) return;

    void this.#refreshArtifactSource().catch((err) => {
      logger.warn("failed to refresh git-based context collection in the background", {
        event: "context.collection.git.refresh.failed",
        collectionId: this.#metadata().id,
        error: err,
      });
    });
  }

  #refreshArtifactSource(): Promise<void> {
    if (this.#artifactRefresh) return this.#artifactRefresh;

    let promise = this.#loadArtifactSnapshot().finally(() => {
      if (this.#artifactRefresh === promise) this.#artifactRefresh = undefined;
    });
    this.#artifactRefresh = promise;
    return promise;
  }

  #replaceArtifactDocuments(commit: string, documents: ArtifactContextDocument[]): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();
      for (let doc of documents) {
        this.#putDocument(doc);
      }

      let meta = this.#metadata();
      meta.documentCount = documents.length;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  #deleteArtifactDocuments(commit: string): void {
    this.storage.transaction(() => {
      for (let record of this.storage.documents.list()) {
        this.storage.documents.delete(record.path);
      }
      this.#clearSkillIndex();

      let meta = this.#metadata();
      meta.documentCount = 0;
      meta.lastUpdated = new Date();
      if (meta.content.source !== "git") throw new Error("Collection must be git-based.");
      meta.content.commit = commit;
      meta.content.lastRefreshedAt = new Date();
      this.storage.metadata.put(meta);
      this.storage.skillIndexVersion.put(SKILL_INDEX_VERSION);
    });
  }

  async #loadArtifactSnapshot(): Promise<void> {
    const meta = this.#metadata();
    if (meta.content.source !== "git") throw new Error("Collection is not git-based.");
    const result = await readArtifactRepoDocuments(
        this.#artifacts(), meta.id, meta.content.remote, meta.content.branch, meta.content.commit);
    if (!result.changed) {
      // Nothing changed, just bump the refresh timestamp.
      const latestMeta = this.#metadata();
      if (latestMeta.content.source !== "git") throw new Error("Collection is not git-based.");
      latestMeta.content = {...latestMeta.content, lastRefreshedAt: new Date()};
      this.storage.metadata.put(latestMeta);
      return;
    }

    if (result.commit) {
      // The repo was updated to a new commit, stored documents need to be updated.
      this.#replaceArtifactDocuments(result.commit, result.documents);
    } else {
      // The repo was updated to an empty state.
      this.#deleteArtifactDocuments(result.commit);
    }
    await this.#propagate();
  }

  // --- Search ---

  /** Linear scan over one collection. Replace with an index if collection size makes it matter. */
  async search(
      authority: ContextAuthorityCapability, query: string, limit: number = 20):
      Promise<{path: string; name: string; description: string; snippet?: string; score: number}[]> {
    await this.#assertRole(authority, "reader");
    if (this.#isGitBased()) this.#startBackgroundArtifactRefresh();

    let tokens = query.toLowerCase().split(/\s+/).filter(token => token.length > 0);
    if (tokens.length === 0) return [];

    let results: {
      path: string; name: string; description: string; snippet?: string; score: number;
    }[] = [];

    for (let record of this.storage.documents.list()) {
      let score = 0;
      let snippet: string | undefined;

      let isText = isTextContentType(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE);
      let nameLower = record.name.toLowerCase();
      let descLower = record.description.toLowerCase();
      let body = isText
        ? decodeStoredContextBody(record.contentType ?? DEFAULT_DOCUMENT_CONTENT_TYPE, record.body)
        : "";
      let bodyLower = body.toLowerCase();

      for (let token of tokens) {
        if (nameLower.includes(token)) score += 10;
        if (descLower.includes(token)) score += 5;
        let bodyIdx = isText ? bodyLower.indexOf(token) : -1;
        if (bodyIdx >= 0) {
          score += 1;
          if (!snippet) {
            let start = Math.max(0, bodyIdx - 40);
            let end = Math.min(body.length, bodyIdx + token.length + 80);
            snippet = (start > 0 ? "..." : "") + body.slice(start, end) +
              (end < body.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({
          path: record.path, name: record.name, description: record.description, snippet, score,
        });
      }
    }

    results.sort((left, right) => right.score - left.score);
    return results.slice(0, limit);
  }

  // --- Deletion ---

  async deleteSelf(authority: ContextAuthorityCapability): Promise<void> {
    await this.#assertRole(authority, "owner");
    let meta = this.#metadata();
    let id = meta.id;

    if (id) {
      await this.#registry().removeCollection(id);
      if (this.storage.ownerSubject.get()) {
        await this.#ownerLibrary().removeOwnedCollection(id);
      }
    }

    if (meta.content.source === "git" && this.env.ARTIFACTS) {
      await this.env.ARTIFACTS.delete(id).catch((err) => {
        logger.warn("failed to delete Artifacts repo for context collection", {
          event: "artifacts.repo.delete.failed",
          collectionId: id,
          error: err,
        });
      });
    }

    await this.ctx.storage.deleteAll();
  }


  // --- Propagation ---

  // Refresh this collection's denormalized summary in its all-collection registry and owner index.
  async #propagate(): Promise<void> {
    let meta = this.#metadata();
    let summary = metadataToSummary(meta);
    await this.#registry().upsertCollection(summary);
    if (this.storage.ownerSubject.get()) {
      await this.#ownerLibrary().updateOwnedCollection(meta.id, summary);
    }
  }
}
