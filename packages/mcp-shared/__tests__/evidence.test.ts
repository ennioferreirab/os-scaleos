import { describe, expect, it } from "vitest";

import { normalizeVaultEvidence } from "@gadgets/workshop-shared/evidence";

const response = {
  answer: "A entrega será em outubro.",
  evidence: {
    version: 1,
    executionId: "exec_1",
    sources: [{
      id: "source_1",
      ref: "reuniao-entrega",
      type: "reuniao",
      title: "Reunião de entrega",
      observedAccess: {
        type: "reuniao",
        tags: ["projeto:alpha"],
        sensitivity: "internal",
      },
    }],
    items: [{
      id: "evidence_1",
      sourceIds: ["source_1"],
      kind: "fact",
      text: "A entrega foi acordada para 20 de outubro.",
      locator: "00:12:04",
    }],
    answerLinks: [{ claimIndex: 0, evidenceIds: ["evidence_1"] }],
    coverage: { complete: true, reasons: [] },
  },
};

describe("Vault evidence normalization", () => {
  it("accepts a valid envelope and preserves provider relationships", () => {
    const result = normalizeVaultEvidence(response, [{
      type: "text",
      text: JSON.stringify(response),
    }]);

    expect(result.status).toBe("normalized");
    if (result.status !== "normalized") return;
    expect(result.envelope.textConflict).toBe(false);
    expect(result.envelope.sources[0]).toMatchObject({
      id: "source_1",
      ref: "reuniao-entrega",
      type: "reuniao",
    });
    expect(result.envelope.items[0]).toMatchObject({
      id: "evidence_1",
      sourceIds: ["source_1"],
      kind: "fact",
    });
    expect(result.envelope.answerLinks).toEqual([
      { claimIndex: 0, evidenceIds: ["evidence_1"] },
    ]);
  });

  it("rejects dangling source and evidence references", () => {
    const danglingSource = structuredClone(response);
    danglingSource.evidence.items[0].sourceIds = ["missing"];
    expect(normalizeVaultEvidence(danglingSource, [])).toEqual({
      status: "invalid",
      reason: "Vault evidence envelope contains an invalid evidence item.",
    });

    const danglingEvidence = structuredClone(response);
    danglingEvidence.evidence.answerLinks[0].evidenceIds = ["missing"];
    expect(normalizeVaultEvidence(danglingEvidence, [])).toEqual({
      status: "invalid",
      reason: "Vault evidence envelope contains an invalid answer link.",
    });
  });

  it("flags textual JSON that diverges from structuredContent without merging it", () => {
    const result = normalizeVaultEvidence(response, [{
      type: "text",
      text: JSON.stringify({ ...response, answer: "Resposta diferente" }),
    }]);

    expect(result.status).toBe("normalized");
    if (result.status !== "normalized") return;
    expect(result.envelope.textConflict).toBe(true);
    expect(result.envelope.items[0].text)
      .toBe("A entrega foi acordada para 20 de outubro.");
  });
});
