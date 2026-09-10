// Per-domain registry of all Context collection summaries. This is a discovery/projection index,
// never an authorization authority; every caller resolves the live role in Collection DO.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { ContextCollectionSummary } from "./context-types.js";

function makeRegistryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      collections: collection<ContextCollectionSummary>()({
        primaryKey: "id",
      }),
    },
    singletons: {},
  });
}

export class LibraryRegistryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeRegistryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeRegistryStorage(ctx.storage);
  }

  /** Return every known summary for this domain; callers must filter through Collection DO roles. */
  listCollections(): ContextCollectionSummary[] {
    return [...this.storage.collections.list()]
        .toSorted((left, right) =>
          left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }

  /** Upsert a summary after the Collection DO has committed it. */
  upsertCollection(summary: ContextCollectionSummary): void {
    this.storage.collections.put({...summary, visibility: "private"});
  }

  removeCollection(collectionId: string): void {
    this.storage.collections.delete(collectionId);
  }
}
