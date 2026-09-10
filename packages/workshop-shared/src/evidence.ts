export type VaultSourceEnvelope = {
  id: string;
  ref: string;
  type: string;
  title?: string;
  occurredAt?: string;
  sensitivity?: string;
  note?: {
    brain: string;
    slug: string;
  };
};

export type VaultEvidenceItemEnvelope = {
  id: string;
  sourceIds: string[];
  kind: "fact" | "excerpt" | "synthesis" | "unknown";
  text: string;
  locator?: string;
  confidence?: number;
};

export type NormalizedVaultEnvelope = {
  version: 1;
  executionId: string;
  sources: VaultSourceEnvelope[];
  items: VaultEvidenceItemEnvelope[];
  answerLinks: Array<{ claimIndex: number; evidenceIds: string[] }>;
  coverage: { complete: boolean; reasons: string[] };
  textConflict: boolean;
};

export type VaultNormalizationResult =
  | { status: "normalized"; envelope: NormalizedVaultEnvelope }
  | { status: "invalid"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isVaultNote(value: unknown): value is { brain: string; slug: string } {
  return isObject(value) && nonEmptyString(value.brain) && nonEmptyString(value.slug);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function textPayload(content: readonly unknown[]): string | undefined {
  const blocks = content.filter((block): block is { type: "text"; text: string } =>
    isObject(block) && block.type === "text" && typeof block.text === "string");
  if (blocks.length === 0) return undefined;
  return blocks.map(block => block.text).join("\n");
}

/**
 * Validates the versioned ScaleOS Vault evidence envelope. The caller must only invoke this for a
 * connector identified as Vault by trusted connector configuration; tool names and payload text are
 * not provider identity.
 */
export function normalizeVaultEvidence(
  structuredContent: unknown,
  content: readonly unknown[],
): VaultNormalizationResult {
  if (!isObject(structuredContent) || !isObject(structuredContent.evidence)) {
    return { status: "invalid", reason: "Vault response has no evidence envelope." };
  }
  const raw = structuredContent.evidence;
  if (raw.version !== 1 || !nonEmptyString(raw.executionId) || !Array.isArray(raw.sources)
      || !Array.isArray(raw.items) || !Array.isArray(raw.answerLinks) || !isObject(raw.coverage)
      || typeof raw.coverage.complete !== "boolean" || !isStringArray(raw.coverage.reasons)) {
    return { status: "invalid", reason: "Vault evidence envelope has an unsupported or invalid shape." };
  }

  const sourceIds = new Set<string>();
  const sources: VaultSourceEnvelope[] = [];
  for (const candidate of raw.sources) {
    if (!isObject(candidate) || !nonEmptyString(candidate.id) || sourceIds.has(candidate.id)
        || !nonEmptyString(candidate.ref) || !nonEmptyString(candidate.type)
        || "observedAccess" in candidate
        || (candidate.title !== undefined && typeof candidate.title !== "string")
        || (candidate.occurredAt !== undefined && typeof candidate.occurredAt !== "string")
        || (candidate.sensitivity !== undefined && typeof candidate.sensitivity !== "string")
        || (candidate.note !== undefined && !isVaultNote(candidate.note))) {
      return { status: "invalid", reason: "Vault evidence envelope contains an invalid source." };
    }
    sourceIds.add(candidate.id);
    sources.push({
      id: candidate.id,
      ref: candidate.ref,
      type: candidate.type,
      ...(candidate.title !== undefined ? { title: candidate.title } : {}),
      ...(candidate.occurredAt !== undefined ? { occurredAt: candidate.occurredAt } : {}),
      ...(candidate.sensitivity !== undefined ? { sensitivity: candidate.sensitivity } : {}),
      ...(isVaultNote(candidate.note)
        ? { note: { brain: candidate.note.brain, slug: candidate.note.slug } }
        : {}),
    });
  }

  const evidenceIds = new Set<string>();
  const items: VaultEvidenceItemEnvelope[] = [];
  for (const candidate of raw.items) {
    if (!isObject(candidate) || !nonEmptyString(candidate.id) || evidenceIds.has(candidate.id)
        || !isStringArray(candidate.sourceIds)
        || !candidate.sourceIds.every(sourceId => sourceIds.has(sourceId))
        || (candidate.kind !== "fact" && candidate.kind !== "excerpt"
          && candidate.kind !== "synthesis" && candidate.kind !== "unknown")
        || typeof candidate.text !== "string"
        || (candidate.locator !== undefined && typeof candidate.locator !== "string")
        || (candidate.confidence !== undefined
          && (typeof candidate.confidence !== "number"
            || !Number.isFinite(candidate.confidence)
            || candidate.confidence < 0
            || candidate.confidence > 1
            || candidate.kind !== "fact"))) {
      return { status: "invalid", reason: "Vault evidence envelope contains an invalid evidence item." };
    }
    evidenceIds.add(candidate.id);
    items.push({
      id: candidate.id,
      sourceIds: [...candidate.sourceIds],
      kind: candidate.kind,
      text: candidate.text,
      ...(candidate.locator !== undefined ? { locator: candidate.locator } : {}),
      ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
    });
  }

  const answerLinks: Array<{ claimIndex: number; evidenceIds: string[] }> = [];
  for (const candidate of raw.answerLinks) {
    if (!isObject(candidate) || !Number.isInteger(candidate.claimIndex)
        || (candidate.claimIndex as number) < 0 || !isStringArray(candidate.evidenceIds)
        || !candidate.evidenceIds.every(evidenceId => evidenceIds.has(evidenceId))) {
      return { status: "invalid", reason: "Vault evidence envelope contains an invalid answer link." };
    }
    answerLinks.push({
      claimIndex: candidate.claimIndex as number,
      evidenceIds: [...candidate.evidenceIds],
    });
  }

  const rendered = textPayload(content);
  let textConflict = false;
  if (rendered !== undefined) {
    try {
      textConflict = canonicalJson(JSON.parse(rendered)) !== canonicalJson(structuredContent);
    } catch {
      textConflict = true;
    }
  }

  return {
    status: "normalized",
    envelope: {
      version: 1,
      executionId: raw.executionId,
      sources,
      items,
      answerLinks,
      coverage: {
        complete: raw.coverage.complete,
        reasons: [...raw.coverage.reasons],
      },
      textConflict,
    },
  };
}
