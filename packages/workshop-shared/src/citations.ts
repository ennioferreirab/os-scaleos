import type {
  AuthorizedEvidence,
  CitationMode,
  CitationSet,
  CitationState,
  DocumentCitationInput,
  DocumentEvidenceView,
  EvidenceRef,
  EvidenceSource,
  WorkpieceId,
} from "./api";

const MAX_CITATION_LINKS = 1_000;
const MAX_EVIDENCE_REFS = 5_000;
const MAX_EVIDENCE_REFS_PER_LINK = 100;
const MAX_REFERENCE_ID_LENGTH = 256;


/** Stable RPC error used when a gadget does not publish the document-citation capability. */
export const DOCUMENT_CITATIONS_UNSUPPORTED_MESSAGE =
  "This gadget does not support document citations.";

/** Identify the explicit unsupported-capability result after it crosses an RPC boundary. */
export function isDocumentCitationsUnsupportedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "message" in error
    && error.message === DOCUMENT_CITATIONS_UNSUPPORTED_MESSAGE;
}
/** A document block snapshot used to resolve citation anchors. */
export type CitationDocumentBlock = {
  /** Stable document block ID. */
  id: string;
  /** Current block HTML. */
  html: string;
  /** Current block version. */
  version: number;
};

/** The document state against which citation anchors are resolved. */
export type CitationDocumentSnapshot = {
  /** Document gadget owning the blocks. */
  gadgetId: WorkpieceId;
  /** Current document content revision. */
  revision: number;
  /** Current document title. */
  title: string;
  /** Current document blocks. */
  blocks: readonly CitationDocumentBlock[];
};

/** Source details safe to expose for one explicitly linked evidence item. */
export type DocumentCitationProjectionSource = {
  ref: string;
  type: string;
  title?: string;
  href?: string;
};

/** Citation data sent to a document renderer, stripped to explicitly linked visible fields. */
export type DocumentCitationProjection = {
  gadgetId: WorkpieceId;
  documentRevision: number;
  citationRevision: number;
  mode: CitationMode;
  links: {
    id: string;
    blockId: string;
    blockVersion: number;
    blockHash: string;
    state: CitationState;
    evidence: EvidenceRef[];
  }[];
  evidence: (
    | {
        returnId: string;
        evidenceId: string;
        status: "available";
        text: string;
        kind: "fact" | "excerpt" | "synthesis" | "unknown";
        locator?: string;
        sources: DocumentCitationProjectionSource[];
      }
    | {
        returnId: string;
        evidenceId: string;
        status: "unavailable";
      }
  )[];
};

/** One immutable document-and-citation view consumed by a single export. */
export type DocumentExportProjection = {
  document: {
    revision: number;
    title: string;
    blocks: CitationDocumentBlock[];
  };
  citations: {
    documentRevision: number;
    citationRevision: number;
    mode: CitationMode;
    links: (
      | { blockId: string; state: "valid"; evidence: number[] }
      | { blockId: string; state: "unavailable" }
    )[];
    evidence: {
      text: string;
      kind: "fact" | "excerpt" | "synthesis" | "unknown";
      locator?: string;
      sources: DocumentCitationProjectionSource[];
    }[];
  };
};

/** Return a stable key for an evidence reference without conflating either component. */
export function evidenceRefKey(ref: EvidenceRef): string {
  return JSON.stringify([ref.returnId, ref.evidenceId]);
}

/** Build the authenticated human-navigation URL for a retained Vault note identity. */
export function buildVaultNoteUrl(
  vaultWebUrl: string | undefined,
  note: EvidenceSource["note"],
): string | undefined {
  if (
    !vaultWebUrl ||
    !note ||
    typeof note !== "object" ||
    typeof note.brain !== "string" ||
    typeof note.slug !== "string"
  ) {
    return undefined;
  }
  const brain = note.brain.trim();
  const slug = note.slug.trim();
  if (!brain || !slug) return undefined;

  try {
    const url = new URL(vaultWebUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return undefined;
    url.pathname = "/app/notas";
    url.search = "";
    url.searchParams.set("brain", brain);
    url.searchParams.set("slug", slug);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Strip a resolved view to the fields a document renderer is allowed to observe. */
export function toDocumentCitationProjection(
  view: DocumentEvidenceView | null | undefined,
): DocumentCitationProjection | null {
  if (!view) return null;
  const linkedEvidence = new Set<string>();
  for (const link of view.links) {
    if (link.state !== "valid") continue;
    for (const ref of link.evidence) linkedEvidence.add(evidenceRefKey(ref));
  }
  return {
    gadgetId: view.gadgetId,
    documentRevision: view.documentRevision,
    citationRevision: view.citationRevision,
    mode: view.mode,
    links: view.links.map((link) => ({
      id: link.id,
      blockId: link.blockId,
      blockVersion: link.blockVersion,
      blockHash: link.blockHash,
      state: link.state,
      evidence: link.evidence.map((ref) => ({ ...ref })),
    })),
    evidence: view.evidence
      .filter((item) => linkedEvidence.has(evidenceRefKey(item.ref)))
      .map((item) =>
        item.status === "available"
          ? {
              returnId: item.ref.returnId,
              evidenceId: item.ref.evidenceId,
              status: "available" as const,
              text: item.evidence.text,
              kind: item.evidence.kind,
              ...(item.evidence.locator === undefined ? {} : { locator: item.evidence.locator }),
              sources: item.sources.map((source) => {
                const href = buildVaultNoteUrl(item.vaultWebUrl, source.note);
                return {
                  ref: source.ref,
                  type: source.type,
                  ...(source.title === undefined ? {} : { title: source.title }),
                  ...(href === undefined ? {} : { href }),
                };
              }),
            }
          : {
              returnId: item.ref.returnId,
              evidenceId: item.ref.evidenceId,
              status: "unavailable" as const,
            },
      ),
  };
}

/** Freeze the current document and its minimized citation projection for one export. */
export function toDocumentExportProjection(
  document: CitationDocumentSnapshot,
  view: DocumentEvidenceView,
): DocumentExportProjection {
  if (view.gadgetId !== document.gadgetId || view.documentRevision !== document.revision) {
    throw new Error("Document export projection revisions do not match.");
  }
  const evidence: DocumentExportProjection["citations"]["evidence"] = [];
  const links: DocumentExportProjection["citations"]["links"] = [];
  if (view.mode !== "none") {
    const evidenceByRef = new Map(view.evidence.map((item) => [evidenceRefKey(item.ref), item]));
    const evidenceIndexes = new Map<string, number>();
    for (const link of view.links) {
      if (link.state === "unavailable") {
        links.push({ blockId: link.blockId, state: "unavailable" });
        continue;
      }
      if (link.state !== "valid") continue;
      const indexes = link.evidence.map((ref) => {
        const key = evidenceRefKey(ref);
        const existing = evidenceIndexes.get(key);
        if (existing !== undefined) return existing;
        const item = evidenceByRef.get(key);
        if (item?.status !== "available") {
          throw new Error("A valid document citation has no available evidence.");
        }
        const index = evidence.length;
        evidenceIndexes.set(key, index);
        evidence.push({
          text: item.evidence.text,
          kind: item.evidence.kind,
          ...(item.evidence.locator === undefined ? {} : { locator: item.evidence.locator }),
          sources: item.sources.map((source) => {
            const href = buildVaultNoteUrl(item.vaultWebUrl, source.note);
            return {
              ref: source.ref,
              type: source.type,
              ...(source.title === undefined ? {} : { title: source.title }),
              ...(href === undefined ? {} : { href }),
            };
          }),
        });
        return index;
      });
      links.push({ blockId: link.blockId, state: "valid", evidence: indexes });
    }
  }
  return {
    document: {
      revision: document.revision,
      title: document.title,
      blocks: document.blocks.map((block) => ({ ...block })),
    },
    citations: {
      documentRevision: view.documentRevision,
      citationRevision: view.citationRevision,
      mode: view.mode,
      links,
      evidence,
    },
  };
}

/** Validate bounded evidence references before storage lookup or persistence. */
export function validateEvidenceRefs(refs: readonly EvidenceRef[]): void {
  if (!Array.isArray(refs)) throw new Error("Evidence references must be an array.");
  if (refs.length > MAX_EVIDENCE_REFS) {
    throw new Error(`A citation request may contain at most ${MAX_EVIDENCE_REFS} evidence references.`);
  }
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null
        || typeof ref.returnId !== "string" || ref.returnId.length === 0
        || ref.returnId.length > MAX_REFERENCE_ID_LENGTH
        || typeof ref.evidenceId !== "string" || ref.evidenceId.length === 0
        || ref.evidenceId.length > MAX_REFERENCE_ID_LENGTH) {
      throw new Error("Citation evidence references must contain bounded return and evidence IDs.");
    }
  }
}

/** Validate the shape of citation links before reading or mutating document state. */
export function validateCitationLinks(links: readonly DocumentCitationInput[]): void {
  if (!Array.isArray(links)) throw new Error("Citation links must be an array.");
  if (links.length > MAX_CITATION_LINKS) {
    throw new Error(`A document may contain at most ${MAX_CITATION_LINKS} citation links.`);
  }
  const linkIds = new Set<string>();
  for (const link of links) {
    if (typeof link !== "object" || link === null) {
      throw new Error("Each citation link must be an object.");
    }
    if (typeof link.blockId !== "string" || link.blockId.length === 0
        || link.blockId.length > MAX_REFERENCE_ID_LENGTH) {
      throw new Error(
        `Citation block IDs must be non-empty strings of at most ${MAX_REFERENCE_ID_LENGTH} characters.`,
      );
    }
    if (link.id !== undefined) {
      if (typeof link.id !== "string" || link.id.length === 0
          || link.id.length > MAX_REFERENCE_ID_LENGTH) {
        throw new Error(
          `Citation IDs must be non-empty strings of at most ${MAX_REFERENCE_ID_LENGTH} characters.`,
        );
      }
      if (linkIds.has(link.id)) throw new Error("Citation IDs must be unique.");
      linkIds.add(link.id);
    }
    if (!Array.isArray(link.evidence) || link.evidence.length === 0) {
      throw new Error("Each citation link must reference at least one evidence item.");
    }
    if (link.evidence.length > MAX_EVIDENCE_REFS_PER_LINK) {
      throw new Error(
        `Each citation link may reference at most ${MAX_EVIDENCE_REFS_PER_LINK} evidence items.`,
      );
    }
    validateEvidenceRefs(link.evidence);
    const refs = new Set<string>();
    for (const ref of link.evidence) {
      const key = evidenceRefKey(ref);
      if (refs.has(key)) throw new Error("Citation evidence references must be unique per link.");
      refs.add(key);
    }
  }
}

/** Compute the lowercase SHA-256 digest used for document block anchors. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Resolve saved citation anchors and evidence under the current document and access state. */
export async function resolveCitationSet(
  document: CitationDocumentSnapshot,
  set: CitationSet | undefined,
  evidence: readonly AuthorizedEvidence[],
): Promise<DocumentEvidenceView> {
  const blockOrder = new Map(document.blocks.map((block, index) => [block.id, index]));
  const currentBlocks = new Map(document.blocks.map(block => [block.id, block]));
  const evidenceByRef = new Map(evidence.map(item => [evidenceRefKey(item.ref), item]));
  const links = [...(set?.links ?? [])]
    .map((link, index) => ({link, index}))
    .sort((a, b) =>
      (blockOrder.get(a.link.blockId) ?? Number.MAX_SAFE_INTEGER)
        - (blockOrder.get(b.link.blockId) ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index)
    .map(({link}) => link);
  const resolvedLinks = [];
  const resolvedEvidence: AuthorizedEvidence[] = [];
  const seenEvidence = new Set<string>();

  for (const link of links) {
    let state: CitationState = "valid";
    for (const ref of link.evidence) {
      const resolved = evidenceByRef.get(evidenceRefKey(ref));
      if (resolved?.status !== "available") {
        state = "unavailable";
        break;
      }
    }
    const block = currentBlocks.get(link.blockId);
    if (state !== "unavailable" && !block) state = "orphaned";
    if (state !== "unavailable" && state !== "orphaned" && block) {
      if (block.version !== link.blockVersion || await sha256Hex(block.html) !== link.blockHash) {
        state = "needs_review";
      }
    }
    resolvedLinks.push({...link, evidence: link.evidence.map(ref => ({...ref})), state});

    for (const ref of link.evidence) {
      const key = evidenceRefKey(ref);
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      resolvedEvidence.push(evidenceByRef.get(key) ?? {
        status: "unavailable",
        ref: {...ref},
        reason: "Evidence is no longer available.",
      });
    }
  }

  return {
    gadgetId: document.gadgetId,
    documentRevision: document.revision,
    citationRevision: set?.citationRevision ?? 0,
    mode: set?.mode ?? ("inline" satisfies CitationMode),
    links: resolvedLinks,
    evidence: resolvedEvidence,
  };
}
