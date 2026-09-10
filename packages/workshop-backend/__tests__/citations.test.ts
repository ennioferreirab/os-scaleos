import { describe, expect, it, vi } from "vitest";
import type {
  Evidence,
  EvidenceSource,
  ToolReturn,
} from "@gadgets/workshop-shared/api";
import type { CitationDocumentSnapshot } from "@gadgets/workshop-shared/citations";
import {
  deleteReturnFromStorage,
  getDocumentEvidenceFromStorage,
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
  return {gadgetId: DOCUMENT_ID, revision, blocks};
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
