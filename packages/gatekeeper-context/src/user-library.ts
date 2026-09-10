// Per-connection index of the collections created by this Context account. The collection DO owns
// authorization; this object is only an owner-summary and creation-reservation projection.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionSummary, ContextMutationReceipt, OwnedCollectionRecord,
} from "./context-types.js";

type OwnedRecord = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  lastUpdated: Date;
};

export type CollectionCreationReservation = {
  key: string;
  ownerSubject: string;
  mutationId: string;
  collectionId: string;
  payloadHash: string;
  reservedAt: string;
  status: "pending" | "complete";
  receipt?: ContextMutationReceipt;
};

function makeUserLibraryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      ownedCollections: collection<OwnedRecord>()({primaryKey: "id"}),
      collectionCreations: collection<CollectionCreationReservation>()({primaryKey: "key"}),
    },
    singletons: {},
  });
}

type UserLibraryStorage = ReturnType<typeof makeUserLibraryStorage>;

export class UserLibraryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserLibraryStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeUserLibraryStorage(ctx.storage);
  }

  /** Refresh the denormalized owned record. */
  updateOwnedCollection(id: string, summary: ContextCollectionSummary): void {
    let record = this.storage.ownedCollections.get(id);
    if (!record) return;
    this.storage.ownedCollections.put({
      ...record,
      title: summary.title,
      description: summary.description,
      icon: summary.icon,
      lastUpdated: summary.lastUpdated,
    });
  }

  removeOwnedCollection(id: string): void {
    this.storage.ownedCollections.delete(id);
  }

  listOwnedCollections(): OwnedCollectionRecord[] {
    let result = [...this.storage.ownedCollections.list()].map(record => ({
      id: record.id,
      title: record.title,
      description: record.description,
      icon: record.icon,
      lastUpdated: record.lastUpdated,
    }));
    result.sort((left, right) => right.lastUpdated.valueOf() - left.lastUpdated.valueOf());
    return result;
  }

  /**
   * Reserve a collection UUID before the Collection DO is initialized. The key is explicitly
   * ownerSubject + mutationId so a crashed create can be resumed without minting a new UUID.
   */
  reserveCollectionCreation(
      ownerSubject: string, mutationId: string, payloadHash: string): CollectionCreationReservation {
    let key = `${ownerSubject}:${mutationId}`;
    return this.storage.transaction(() => {
      let existing = this.storage.collectionCreations.get(key);
      if (existing) {
        if (existing.ownerSubject !== ownerSubject || existing.payloadHash !== payloadHash) {
          throw Object.assign(
              new Error("mutationId was already used with a different collection payload."),
              {code: "CONFLICT"});
        }
        return existing;
      }

      let reservation: CollectionCreationReservation = {
        key,
        ownerSubject,
        mutationId,
        collectionId: crypto.randomUUID(),
        payloadHash,
        reservedAt: new Date().toISOString(),
        status: "pending",
      };
      this.storage.collectionCreations.put(reservation);
      return reservation;
    });
  }


  /** Mark a reservation complete only after the Registry projection is confirmed. */
  completeCollectionCreation(
      ownerSubject: string, mutationId: string,
      summary: ContextCollectionSummary): CollectionCreationReservation {
    let key = `${ownerSubject}:${mutationId}`;
    return this.storage.transaction(() => {
      let reservation = this.storage.collectionCreations.get(key);
      if (!reservation || reservation.ownerSubject !== ownerSubject) {
        throw Object.assign(new Error("Collection creation reservation was not found."), {
          code: "NOT_FOUND",
        });
      }
      if (summary.id !== reservation.collectionId) {
        throw Object.assign(new Error("Collection summary does not match the creation reservation."), {
          code: "CONFLICT",
        });
      }
      if (reservation.status === "complete") {
        if (!reservation.receipt) {
          throw Object.assign(new Error("Completed collection reservation has no receipt."), {
            code: "CONFLICT",
          });
        }
        return reservation;
      }

      let receipt: ContextMutationReceipt = {
        version: 1,
        accessVersion: 0,
        mutationId,
        actorSubject: ownerSubject,
        action: "createCollection",
        collectionId: reservation.collectionId,
        confirmedAt: new Date().toISOString(),
      };
      let completed = {...reservation, status: "complete" as const, receipt};
      this.storage.ownedCollections.put({
        id: summary.id,
        title: summary.title,
        description: summary.description,
        icon: summary.icon,
        lastUpdated: summary.lastUpdated,
      });
      this.storage.collectionCreations.put(completed);
      return completed;
    });
  }

}
