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
      sensitivity: "internal",
      note: { brain: "brain_1", slug: "reuniao-entrega" },
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
      sensitivity: "internal",
      note: { brain: "brain_1", slug: "reuniao-entrega" },
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

  it("rejects duplicate provider IDs within one return", () => {
    const duplicateSource = structuredClone(response);
    duplicateSource.evidence.sources.push({
      ...duplicateSource.evidence.sources[0],
      id: "source_1",
      ref: "another",
    });
    expect(normalizeVaultEvidence(duplicateSource, [])).toEqual({
      status: "invalid",
      reason: "Vault evidence envelope contains an invalid source.",
    });

    const duplicateEvidence = structuredClone(response);
    duplicateEvidence.evidence.items.push({
      ...duplicateEvidence.evidence.items[0],
      text: "duplicated",
    });
    expect(normalizeVaultEvidence(duplicateEvidence, [])).toEqual({
      status: "invalid",
      reason: "Vault evidence envelope contains an invalid evidence item.",
    });
  });

  it("rejects the old observedAccess source metadata", () => {
    const legacySource = structuredClone(response);
    const source = legacySource.evidence.sources[0] as Record<string, unknown>;
    source.observedAccess = {
      type: "reuniao",
      tags: ["projeto:alpha"],
      sensitivity: "internal",
    };
    delete source.sensitivity;
    delete source.note;
    expect(normalizeVaultEvidence(legacySource, [])).toEqual({
      status: "invalid",
      reason: "Vault evidence envelope contains an invalid source.",
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

  it("accepts and preserves finite confidence in [0, 1] on fact items", () => {
    const withConfidence = structuredClone(response);
    (withConfidence.evidence.items[0] as Record<string, unknown>).confidence = 0.45;

    const result = normalizeVaultEvidence(withConfidence, [{
      type: "text",
      text: JSON.stringify(withConfidence),
    }]);

    expect(result.status).toBe("normalized");
    if (result.status !== "normalized") return;
    expect(result.envelope.items[0].confidence).toBe(0.45);
  });

  it("accepts items when confidence is omitted", () => {
    const withoutConfidence = structuredClone(response);
    delete (withoutConfidence.evidence.items[0] as Record<string, unknown>).confidence;

    const result = normalizeVaultEvidence(withoutConfidence, []);
    expect(result.status).toBe("normalized");
    if (result.status !== "normalized") return;
    expect(result.envelope.items[0].confidence).toBeUndefined();
  });

  it("rejects non-finite, out of bounds, or non-numeric confidence", () => {
    for (const invalidValue of [-0.01, 1.01, NaN, Infinity, -Infinity, "0.45", null, {}]) {
      const invalid = structuredClone(response);
      (invalid.evidence.items[0] as Record<string, unknown>).confidence = invalidValue;
      expect(normalizeVaultEvidence(invalid, [])).toEqual({
        status: "invalid",
        reason: "Vault evidence envelope contains an invalid evidence item.",
      });
    }
  });

  it("rejects confidence on non-fact kinds", () => {
    for (const kind of ["excerpt", "synthesis", "unknown"] as const) {
      const invalid = structuredClone(response);
      invalid.evidence.items[0].kind = kind;
      (invalid.evidence.items[0] as Record<string, unknown>).confidence = 0.45;
      expect(normalizeVaultEvidence(invalid, [])).toEqual({
        status: "invalid",
        reason: "Vault evidence envelope contains an invalid evidence item.",
      });
    }
  });
});
