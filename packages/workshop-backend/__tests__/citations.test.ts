import { describe, expect, it, vi } from "vitest";
import type { Evidence, EvidenceSource, ToolReturn } from "@gadgets/workshop-shared/api";
import {
  toDocumentExportProjection,
  type CitationDocumentSnapshot,
} from "@gadgets/workshop-shared/citations";
import {
  deleteReturnFromStorage,
  getDocumentEvidenceFromStorage,
  readCitationDocumentFromFacet,
  setCitationModeInStorage,
  setDocumentCitationsInStorage,
  type OverseerStorage,
} from "../src/overseer.js";
import { makeActionStorage } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const CHAT_ID = 41;
const DOCUMENT_ID = 7;

function putChat(storage: OverseerStorage, chatId: number): void {
  storage.chatMeta.put({
    id: chatId,
    title: `Chat ${chatId}`,
    started: new Date(1700000000000 + chatId),
    lastActive: new Date(1700000000000 + chatId),
  });
}

function putEvidenceReturn(
    storage: OverseerStorage,
    returnId: string,
    chatId: number,
    evidenceId: string,
    text: string,
): void {
  const source: EvidenceSource = {
    id: `source-${returnId}`,
    ref: `vault://notes/${returnId}`,
    type: "note",
    title: `Note ${returnId}`,
  };
  const evidence: Evidence = {
    id: evidenceId,
    sourceIds: [source.id],
    text,
    kind: "fact",
  };
  const record: ToolReturn = {
    id: returnId,
    actionRecordId: Number(returnId.replace(/\D/g, "")) || 1,
    chatId,
    gatekeeperId: 1,
    connectionGeneration: 1,
    tool: "galeed_ask",
    calledAt: new Date(1700000000000 + chatId),
    executionState: "applied",
    captureState: "stored",
    payloadRef: returnId,
    byteCount: text.length,
    normalizationVersion: 1,
    coverage: {complete: true, reasons: []},
    redacted: false,
    observed: true,
    sourceProvider: "vault",
    sources: [source],
    evidence: [evidence],
    answerLinks: [],
    normalizationState: "normalized",
    normalizationByteCount: text.length,
  };
  storage.toolReturns.put(record);
}

function documentSnapshot(
    revision: number,
    blocks = [
      {id: "block-a", html: "<p>Quoted sentence</p>", version: 3},
      {id: "block-b", html: "<p>Other text</p>", version: 2},
    ],
): CitationDocumentSnapshot {
  return { gadgetId: DOCUMENT_ID, revision, title: "Cited document", blocks };
}

function citationInput(expectedDocumentRevision: number, expectedCitationRevision: number) {
  return {
    gadgetId: DOCUMENT_ID,
    expectedDocumentRevision,
    expectedCitationRevision,
    links: [{
      id: "citation-a",
      blockId: "block-a",
      evidence: [{returnId: "return-a", evidenceId: "evidence-a"}],
    }],
  };
}

describe("document citation capability", () => {
  it("normalizes a missing capability RPC while preserving real capability failures", async () => {
    const disposeMissing = vi.fn();
    await expect(
      readCitationDocumentFromFacet(
        {
          getDocumentCapabilities: async () => {
            throw new Error(
              'The RPC receiver does not implement the method "getDocumentCapabilities".',
            );
          },
          getDocument: async () => null,
          [Symbol.dispose]: disposeMissing,
        },
        DOCUMENT_ID,
      ),
    ).rejects.toThrow("This gadget does not support document citations.");
    expect(disposeMissing).toHaveBeenCalledOnce();

    const disposeBroken = vi.fn();
    await expect(
      readCitationDocumentFromFacet(
        {
          getDocumentCapabilities: async () => {
            throw new Error("capability storage failed");
          },
          getDocument: async () => null,
          [Symbol.dispose]: disposeBroken,
        },
        DOCUMENT_ID,
      ),
    ).rejects.toThrow("capability storage failed");
    expect(disposeBroken).toHaveBeenCalledOnce();
  });

  it("recognizes the explicit legacy state as citation-free until blocks initialize", async () => {
    const dispose = vi.fn();
    await expect(
      readCitationDocumentFromFacet(
        {
          getDocumentCapabilities: async () => ({
            documentVersion: 2,
            citationsVersion: 1,
          }),
          getDocument: async () => ({
            revision: 0,
            title: "Legacy document",
            blocks: null,
            legacyContent: "<p>Legacy content</p>",
          }),
          [Symbol.dispose]: dispose,
        },
        DOCUMENT_ID,
      ),
    ).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("document citation storage", () => {
  it("keeps CAS-protected links and derives validity across document changes", async () => {
    const storage = makeActionStorage();
    putChat(storage, CHAT_ID);
    putEvidenceReturn(storage, "return-a", CHAT_ID, "evidence-a", "Quoted sentence");

    const initial = documentSnapshot(1);
    const applied = await setDocumentCitationsInStorage(
        storage, citationInput(1, 0), initial);
    expect(applied).toMatchObject({
      status: "applied",
      citationRevision: 1,
      documentRevision: 1,
      mode: "inline",
    });

    const staleCitation = await setDocumentCitationsInStorage(
        storage, citationInput(1, 0), initial);
    expect(staleCitation).toEqual({
      status: "conflict",
      citationRevision: 1,
      documentRevision: 1,
      mode: "inline",
    });
    const staleDocument = await setDocumentCitationsInStorage(
        storage, citationInput(0, 1), initial);
    expect(staleDocument).toEqual({
      status: "conflict",
      citationRevision: 1,
      documentRevision: 1,
      mode: "inline",
    });
    expect((await getDocumentEvidenceFromStorage(storage, initial)).links[0].state)
        .toBe("valid");

    const moved = documentSnapshot(2, [initial.blocks[1], initial.blocks[0]]);
    expect((await getDocumentEvidenceFromStorage(storage, moved)).links[0].state)
        .toBe("valid");

    const edited = documentSnapshot(3, [
      {id: "block-a", html: "<p>Edited sentence</p>", version: 4},
      initial.blocks[1],
    ]);
    expect((await getDocumentEvidenceFromStorage(storage, edited)).links[0].state)
        .toBe("needs_review");

    const removed = documentSnapshot(4, [initial.blocks[1]]);
    expect((await getDocumentEvidenceFromStorage(storage, removed)).links[0].state)
        .toBe("orphaned");

    deleteReturnFromStorage(storage, undefined, "return-a");
    const unavailable = await getDocumentEvidenceFromStorage(storage, initial);
    expect(unavailable.links[0].state).toBe("unavailable");
    expect(unavailable.evidence[0]).toMatchObject({status: "unavailable"});
  });

  it("projects links and evidence in the document's current block order", async () => {
    const storage = makeActionStorage();
    putChat(storage, CHAT_ID);
    putEvidenceReturn(storage, "return-a", CHAT_ID, "evidence-a", "First evidence");
    putEvidenceReturn(storage, "return-b", CHAT_ID, "evidence-b", "Second evidence");
    const initial = documentSnapshot(1);

    await setDocumentCitationsInStorage(storage, {
      gadgetId: DOCUMENT_ID,
      expectedDocumentRevision: 1,
      expectedCitationRevision: 0,
      links: [
        {
          id: "citation-a",
          blockId: "block-a",
          evidence: [{returnId: "return-a", evidenceId: "evidence-a"}],
        },
        {
          id: "citation-b",
          blockId: "block-b",
          evidence: [{returnId: "return-b", evidenceId: "evidence-b"}],
        },
      ],
    }, initial);

    const moved = documentSnapshot(2, [initial.blocks[1], initial.blocks[0]]);
    const view = await getDocumentEvidenceFromStorage(storage, moved);
    expect(view.links.map(link => link.id)).toEqual(["citation-b", "citation-a"]);
    expect(view.evidence.map(item => item.ref)).toEqual([
      {returnId: "return-b", evidenceId: "evidence-b"},
      {returnId: "return-a", evidenceId: "evidence-a"},
    ]);
    const exportProjection = toDocumentExportProjection(moved, view);
    expect(exportProjection.citations.links).toEqual([
      { blockId: "block-b", state: "valid", evidence: [0] },
      { blockId: "block-a", state: "valid", evidence: [1] },
    ]);
    const serialized = JSON.stringify(exportProjection);
    expect(serialized).not.toContain('"returnId"');
    expect(serialized).not.toContain('"evidenceId"');
    expect(serialized).not.toContain('"blockHash"');
    expect(serialized).not.toContain('"citation-a"');
    const hiddenProjection = toDocumentExportProjection(moved, {...view, mode: "none"});
    expect(hiddenProjection.citations).toMatchObject({
      mode: "none",
      links: [],
      evidence: [],
    });
    expect(JSON.stringify(hiddenProjection)).not.toContain("First evidence");
    expect(JSON.stringify(hiddenProjection)).not.toContain("Second evidence");
  });

  it("rejects cross-chat references and protects citation mode with CAS", async () => {
    const storage = makeActionStorage();
    putChat(storage, CHAT_ID);
    putChat(storage, CHAT_ID + 1);
    putEvidenceReturn(storage, "return-a", CHAT_ID, "evidence-a", "First chat");
    putEvidenceReturn(storage, "return-b", CHAT_ID + 1, "evidence-b", "Other chat");

    const initial = documentSnapshot(1);
    await expect(setDocumentCitationsInStorage(
        storage,
        {
          ...citationInput(1, 0),
          links: [{
            id: "citation-cross-chat",
            blockId: "block-a",
            evidence: [
              {returnId: "return-a", evidenceId: "evidence-a"},
              {returnId: "return-b", evidenceId: "evidence-b"},
            ],
          }],
        },
        initial)).rejects.toThrow("one conversation");
    expect(storage.citationSets.get(DOCUMENT_ID)).toBeUndefined();

    const modeApplied = setCitationModeInStorage(storage, {
      gadgetId: DOCUMENT_ID,
      expectedCitationRevision: 0,
      mode: "endnotes",
    }, initial.revision);
    expect(modeApplied).toEqual({
      status: "applied",
      citationRevision: 1,
      documentRevision: 1,
      mode: "endnotes",
    });

    const modeConflict = setCitationModeInStorage(storage, {
      gadgetId: DOCUMENT_ID,
      expectedCitationRevision: 0,
      mode: "none",
    }, initial.revision);
    expect(modeConflict).toEqual({
      status: "conflict",
      citationRevision: 1,
      documentRevision: 1,
      mode: "endnotes",
    });
    expect((await getDocumentEvidenceFromStorage(storage, initial)).mode).toBe("endnotes");
  });
});
