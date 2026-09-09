// Agent read path over collections. Every result is authorized as an observation and attributed to
// the collections whose metadata or content it reveals.

import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  ContextAuthorityCapability, ObservationAuthorizer, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ContextSearchResult, ContextListing, ContextListingEntry, ContextReadResult,
  EnabledCollectionInfo, decodeDocId, encodeDocId, isTextContentType, VENDOR_ID,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import { domainName } from "./domain.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Fanout cap for whole-library search/list.
const MAX_COLLECTION_FANOUT = 8;
const CONTEXT_NOT_FOUND = "NOT_FOUND";

type ObserveCollections = (collectionIds: string[]) => Promise<{
  excludeObservers?: string[];
  pendingCollections: string[];
  commit(): void;
}>;

type CollectionNamespace = DurableObjectNamespace<ContextCollectionDurableObject>;
type RegistryNamespace = DurableObjectNamespace<LibraryRegistryDurableObject>;
type AuthorityCapability = ContextAuthorityCapability;

function notFoundError(): Error & {code: string} {
  return Object.assign(new Error("Collection not found or you don't have access."), {
    code: CONTEXT_NOT_FOUND,
  });
}

@validateRpc()
export class LibraryReadSession extends RpcTarget {
  private readonly authority: AuthorityCapability;
  private readonly authorizer: NativeRpcStub<ObservationAuthorizer>;

  constructor(
    private collections: CollectionNamespace,
    private registries: RegistryNamespace,
    private domain: string,
    authority: AuthorityCapability,
    authorizer: NativeRpcStub<ObservationAuthorizer>,
    private observeCollections: ObserveCollections,
  ) {
    super();
    this.authority = "dup" in authority ? authority.dup() : authority;
    this.authorizer = authorizer.dup();
  }

  [Symbol.dispose](): void {
    if ("dup" in this.authority) this.authority[Symbol.dispose]();
    this.authorizer[Symbol.dispose]?.();
  }

  #collection(id: string): DurableObjectStub<ContextCollectionDurableObject> {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  async #assertAppAccess(): Promise<void> {
    await this.authority.assertAppAccess();
  }

  async #visibleCollections(): Promise<Map<string, EnabledCollectionInfo>> {
    let indexed = await this.registries.getByName(this.domain).listCollections();
    let visible = await mapWithConcurrency(indexed, MAX_COLLECTION_FANOUT, async summary => {
      try {
        return await this.#collection(summary.id).getAuthorizedSummary(this.authority);
      } catch (error) {
        if ((error as {code?: string})?.code === CONTEXT_NOT_FOUND) return null;
        throw error;
      }
    });
    return new Map(visible.filter(summary => summary !== null)
      .map(summary => [summary.id, summary]));
  }

  async #requireVisible(collectionId: string): Promise<EnabledCollectionInfo> {
    let summary = await this.#collection(collectionId).getAuthorizedSummary(this.authority);
    if (!summary) throw notFoundError();
    return summary;
  }

  async #authorize(
      collectionIds: string[], description: ObservationDescription): Promise<void> {
    let check = collectionIds.length > 0
      ? await this.observeCollections(collectionIds)
      : {pendingCollections: [], commit() {}};
    await this.authorizer.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  async search(query: string, opts?: {
    collectionId?: string;
    limit?: number;
  }): Promise<ContextSearchResult[]> {
    await this.#assertAppAccess();
    let limit = opts?.limit ?? 20;
    let direct = !!opts?.collectionId;
    let targetIds: string[];
    if (opts?.collectionId) {
      await this.#requireVisible(opts.collectionId);
      targetIds = [opts.collectionId];
    } else {
      targetIds = [...(await this.#visibleCollections()).keys()];
    }

    let perCollection = await mapWithConcurrency(
        targetIds, MAX_COLLECTION_FANOUT, async collectionId => {
          try {
            let hits = await this.#collection(collectionId).search(this.authority, query, limit);
            return hits.map((r): ContextSearchResult => ({
              docId: encodeDocId(collectionId, r.path),
              collectionId,
              title: r.name,
              path: r.path,
              description: r.description,
              snippet: r.snippet,
              score: r.score,
            }));
          } catch (err) {
            if (direct) throw err;
            logger.warn("failed to search collection", {
              event: "collection.search.failed", collectionId, error: err,
            });
            return [];
          }
        });

    let results = perCollection.flat();
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    results = results.slice(0, limit);
    if (results.length === 0) return results;
    let collectionIds = [
      ...new Set(results.map(r => r.collectionId).filter((id): id is string => !!id)),
    ];
    await this.#authorize(collectionIds, {
      title: `Context search: ${query}`,
      description:
        `Searched the Context Library for \`${query}\`. Returned ${results.length} result(s)` +
        (collectionIds.length ? ` across ${collectionIds.length} collection(s).` : "."),
    });
    return results;
  }

  async list(opts?: {
    collectionId?: string;
    path?: string;
  }): Promise<ContextListing> {
    await this.#assertAppAccess();
    let listing = await this.#fetchListing(opts);
    if (listing.entries.length === 0) return listing;
    let collectionIds = opts?.collectionId
      ? [opts.collectionId]
      : listing.entries
          .filter((entry): entry is Extract<ContextListingEntry, {type: "collection"}> =>
            entry.type === "collection")
          .map(entry => entry.id);
    await this.#authorize(collectionIds, {
      title: opts?.collectionId
        ? `Context listing: ${opts.collectionId}${opts.path ? "/" + opts.path : ""}`
        : "Context listing: collections",
      description: opts?.collectionId
        ? `Listed contents of Context Library collection \`${opts.collectionId}\`.`
        : "Listed the user's Context Library collections.",
    });
    return listing;
  }

  async read(docId: string): Promise<ContextReadResult | null> {
    await this.#assertAppAccess();
    let decoded = decodeDocId(docId);
    if (!decoded) return null;
    let {collectionId, path} = decoded;
    await this.#requireVisible(collectionId);

    let doc = await this.#collection(collectionId).getContextDocument(this.authority, path);
    if (!doc) return null;
    await this.#authorize([collectionId], {
      title: `Context read: ${doc.name}`,
      description: `Read Context Library document \`${docId}\`.`,
    });

    let content = isTextContentType(doc.contentType)
      ? doc.body
      : `data:${doc.contentType};base64,${doc.body}`;
    return {
      docId,
      title: doc.name,
      path: doc.path,
      description: doc.description,
      content,
    };
  }

  async #fetchListing(opts?: {collectionId?: string; path?: string}): Promise<ContextListing> {
    let enabled = await this.#visibleCollections();
    if (!opts?.collectionId) {
      let collectionEntries = await mapWithConcurrency(
          [...enabled.values()], MAX_COLLECTION_FANOUT, async summary => ({
            type: "collection" as const,
            id: summary.id,
            title: summary.title,
            description: summary.description,
            documentCount: await this.#collection(summary.id).listContextDocuments(
                this.authority).then(documents => documents.length),
          }));
      return {entries: collectionEntries};
    }

    if (!enabled.has(opts.collectionId)) throw notFoundError();
    let pathPrefix = opts.path ? opts.path + "/" : "";
    let docs = await this.#collection(opts.collectionId).listContextDocuments(
        this.authority, pathPrefix || undefined);
    let entries: ContextListingEntry[] = [];
    let seenDirs = new Set<string>();
    for (let doc of docs) {
      let relativePath = doc.path.slice(pathPrefix.length);
      let slashIdx = relativePath.indexOf("/");
      if (slashIdx >= 0) {
        let dirName = relativePath.slice(0, slashIdx);
        let dirPath = pathPrefix + dirName;
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          entries.push({type: "directory", path: dirPath, name: dirName});
        }
      } else {
        entries.push({
          type: "document",
          docId: encodeDocId(opts.collectionId, doc.path),
          path: doc.path,
          name: doc.name,
          description: doc.description,
          contentType: doc.contentType,
        });
      }
    }
    return {collectionId: opts.collectionId, path: opts.path, entries};
  }
}

async function mapWithConcurrency<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let results: R[] = Array.from({length: items.length});
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      let i = next++;
      results[i] = await fn(items[i]);
    }
  }
  let workers = Array.from({length: Math.min(limit, items.length)}, () => worker());
  await Promise.all(workers);
  return results;
}
