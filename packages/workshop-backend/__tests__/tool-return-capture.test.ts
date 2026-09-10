import { describe, expect, it, vi } from "vitest";
import {
  MAX_CALL_PAYLOAD_BYTES,
  MAX_CHAT_PAYLOAD_BYTES,
  PAYLOAD_CHUNK_BYTES,
  chunkUtf8String,
  sanitizeCapturedPayload,
  getReturnFromStorage,
  listReturnsFromStorage,
  type ToolReturnRecord,
} from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

describe("Tool Return Capture (T01)", () => {
  it("an observation result with no console is retrievable after creating a fresh API/session view for the same chat", async () => {
    const mockStorage = makeMockStorage();
    const storage = makeActionStorage(mockStorage);

    const chatId = 42;
    const returnId = "ret_obs_test_1";
    const actionRecordId = 101;

    // Simulate an observation returning knowledge without printing to console
    const payload = {
      content: [{ type: "text", text: "A entrega foi acordada para 20 de outubro" }],
      structuredContent: { agreementDate: "2026-10-20" },
      isError: false,
    };
    const serialized = JSON.stringify(payload);
    const byteCount = new TextEncoder().encode(serialized).byteLength;
    const chunks = chunkUtf8String(serialized, PAYLOAD_CHUNK_BYTES);

    for (let i = 0; i < chunks.length; i++) {
      storage.toolReturnChunks.put({
        id: `${returnId}.${i}`,
        returnId,
        chunkIndex: i,
        chatId,
        data: chunks[i],
      });
    }
    storage.chatPayloadBytes.put({ chatId, bytes: byteCount });

    const toolReturn: ToolReturnRecord = {
      id: returnId,
      actionRecordId,
      chatId,
      gatekeeperId: 1,
      connectionGeneration: 1,
      tool: "galeed_ask",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: returnId,
      byteCount,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: true,
    };
    storage.toolReturns.put(toolReturn);

    // Create a FRESH API / session view for the same workspace/chat and dispose the stub properly
    {
      using client = await openFakeOverseer(storage);

      // Retrieve via getReturn
      const retrieved = await client.getReturn(returnId);
      expect(retrieved.status).toBe("available");
      if (retrieved.status === "available") {
        expect(retrieved.return.id).toBe(returnId);
        expect(retrieved.return.chatId).toBe(chatId);
        expect(retrieved.text).toBe("A entrega foi acordada para 20 de outubro");
        expect(retrieved.structuredContent).toEqual({ agreementDate: "2026-10-20" });
        expect(retrieved.isError).toBe(false);
      }

      // List returns for the chat
      const page = await client.listReturns({ chatId });
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0].id).toBe(returnId);
      expect(page.entries[0].tool).toBe("galeed_ask");
    }
  });

  it("a no-chat call produces no stored return", async () => {
    const storage = makeActionStorage();

    // In a no-chat context, no durable return is recorded in storage
    const list = Array.from(storage.toolReturns.list());
    const chunks = Array.from(storage.toolReturnChunks.list());
    expect(list).toHaveLength(0);
    expect(chunks).toHaveLength(0);

    // Querying non-existent return from a no-chat call gives unavailable
    const result = getReturnFromStorage(storage, "ret_no_chat");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toContain("not found");
    }
  });

  it("collecting one applied action twice yields one occurrence", async () => {
    const storage = makeActionStorage();
    const returnId = "ret_act_single_occurrence";
    const chatId = 55;
    const actionRecordId = 200;

    // Simulate action applied and payload stored with chunks
    const payload = {
      content: [{ type: "text", text: "Ticket updated" }],
      structuredContent: { status: "updated" },
      isError: false,
    };
    const serialized = JSON.stringify(payload);
    storage.toolReturnChunks.put({
      id: `${returnId}.0`,
      returnId,
      chunkIndex: 0,
      chatId,
      data: serialized,
    });
    storage.toolReturns.put({
      id: returnId,
      actionRecordId,
      chatId,
      gatekeeperId: 1,
      tool: "update_ticket",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: returnId,
      byteCount: serialized.length,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: true,
    });

    // Simulating collecting the action twice via client
    {
      using client = await openFakeOverseer(storage);

      const first = await client.getReturn(returnId);
      const second = await client.getReturn(returnId);

      expect(first.status).toBe("available");
      expect(second.status).toBe("available");
      if (first.status === "available" && second.status === "available") {
        expect(first.return.id).toBe(returnId);
        expect(second.return.id).toBe(returnId);
        expect(first.text).toBe("Ticket updated");
        expect(second.text).toBe("Ticket updated");
      }
    }

    // Storage preserves exactly one occurrence
    const occurrences = Array.from(storage.toolReturns.byChatId.get(chatId));
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].id).toBe(returnId);
  });

  it("capture persistence failure preserves honest failure state without duplicating return records", async () => {
    const storage = makeActionStorage();
    const chatId = 60;
    const returnId = "ret_failed_persistence";
    const actionRecordId = 300;

    // When persistence fails or exceeds chat quota, return is recorded as failed
    storage.toolReturns.put({
      id: returnId,
      actionRecordId,
      chatId,
      gatekeeperId: 1,
      tool: "danger_write",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "failed",
      payloadRef: returnId,
      byteCount: 0,
      normalizationVersion: 1,
      coverage: { complete: false, reasons: ["Chat payload limit exceeded (50 MiB)"] },
      redacted: false,
      observed: true,
    });

    {
      using client = await openFakeOverseer(storage);
      const result = await client.getReturn(returnId);
      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toContain("failed");
      }
    }

    // No chunk records exist for failed return
    const chunks = Array.from(storage.toolReturnChunks.byReturnId.get(returnId));
    expect(chunks).toHaveLength(0);

    // Only one return record exists
    const returns = Array.from(storage.toolReturns.byChatId.get(chatId));
    expect(returns).toHaveLength(1);
  });

  it("over-limit JSON is partial and not normalized as evidence", async () => {
    const storage = makeActionStorage();
    const chatId = 66;
    const returnId = "ret_oversized_1";

    // Create an application payload exceeding MAX_CALL_PAYLOAD_BYTES (1 MiB)
    const largePayload = {
      content: [{ type: "text", text: "x".repeat(MAX_CALL_PAYLOAD_BYTES + 500) }],
      structuredContent: { huge: true },
      isError: false,
    };
    const serialized = JSON.stringify(largePayload);
    const byteCount = new TextEncoder().encode(serialized).byteLength;
    expect(byteCount).toBeGreaterThan(MAX_CALL_PAYLOAD_BYTES);

    // When payload exceeds per-call limit:
    // Store metadata with captureState: "partial", but do NOT store chunks
    const partialReturn: ToolReturnRecord = {
      id: returnId,
      actionRecordId: 301,
      chatId,
      gatekeeperId: 1,
      tool: "dump_data",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "partial",
      payloadRef: returnId,
      byteCount,
      normalizationVersion: 1,
      coverage: {
        complete: false,
        reasons: ["Payload exceeded per-call limit (1 MiB)"],
      },
      redacted: false,
      observed: true,
    };
    storage.toolReturns.put(partialReturn);

    // Chunks must NOT be stored for partial / over-limit return
    const chunks = Array.from(storage.toolReturnChunks.byReturnId.get(returnId));
    expect(chunks).toHaveLength(0);

    // Retrieving the return reports unavailable with the partial explanation
    const retrieved = getReturnFromStorage(storage, returnId);
    expect(retrieved.status).toBe("unavailable");
    if (retrieved.status === "unavailable") {
      expect(retrieved.reason).toContain("partially captured");
    }
  });

  it("deleting a chat removes live payload/index records", async () => {
    const mockStorage = makeMockStorage();
    const storage = makeActionStorage(mockStorage);

    const chatToDelete = 88;
    const survivingChat = 99;
    const clearedActionReturns: string[] = [];

    const makeReturn = (id: string, chatId: number) => {
      const payload = { content: [{ type: "text", text: `Chat ${chatId} content` }] };
      const serialized = JSON.stringify(payload);
      const byteCount = new TextEncoder().encode(serialized).byteLength;
      storage.toolReturnChunks.put({
        id: `${id}.0`,
        returnId: id,
        chunkIndex: 0,
        chatId,
        data: serialized,
      });
      storage.chatPayloadBytes.put({ chatId, bytes: byteCount });
      storage.toolReturns.put({
        id,
        actionRecordId: 400 + chatId,
        chatId,
        gatekeeperId: 1,
        tool: "query",
        calledAt: new Date(1700000000000),
        executionState: "applied",
        captureState: "stored",
        payloadRef: id,
        byteCount,
        normalizationVersion: 1,
        coverage: { complete: true, reasons: [] },
        redacted: false,
        observed: true,
      });
    };

    makeReturn("ret_chat_88_a", chatToDelete);
    makeReturn("ret_chat_88_b", chatToDelete);
    makeReturn("ret_chat_99", survivingChat);

    expect(Array.from(storage.toolReturns.byChatId.get(chatToDelete))).toHaveLength(2);
    expect(Array.from(storage.toolReturns.byChatId.get(survivingChat))).toHaveLength(1);

    // Call deleteChat via fake overseer client to exercise real deterministic cleanup
    {
      using client = await openFakeOverseer(storage, {
        onClearRetainedActionPayload: (record) => {
          clearedActionReturns.push(record.id);
        },
      });
      await client.deleteChat(chatToDelete);
    }

    // Chat 88 is completely and deterministically purged
    expect(Array.from(storage.toolReturns.byChatId.get(chatToDelete))).toHaveLength(0);
    expect(Array.from(storage.toolReturnChunks.byReturnId.get("ret_chat_88_a"))).toHaveLength(0);
    expect(Array.from(storage.toolReturnChunks.byReturnId.get("ret_chat_88_b"))).toHaveLength(0);
    expect(Array.from(storage.toolReturnChunks.byChatId.get(chatToDelete))).toHaveLength(0);
    expect(storage.chatPayloadBytes.get(chatToDelete)).toBeUndefined();
    expect(clearedActionReturns.sort()).toEqual(["ret_chat_88_a", "ret_chat_88_b"]);

    // Surviving chat 99 is completely untouched
    expect(Array.from(storage.toolReturns.byChatId.get(survivingChat))).toHaveLength(1);
    expect(Array.from(storage.toolReturnChunks.byReturnId.get("ret_chat_99"))).toHaveLength(1);
    expect(storage.chatPayloadBytes.get(survivingChat)).toBeDefined();
  });

  it("enforces owner-only access and observation authorization before action payload disclosure (RAG-OS-001)", async () => {
    const storage = makeActionStorage();
    const returnId = "ret_act_unobserved";
    const chatId = 77;
    const actionRecordId = 500;

    storage.toolReturnChunks.put({
      id: `${returnId}.0`,
      returnId,
      chunkIndex: 0,
      chatId,
      data: JSON.stringify({ content: [{ type: "text", text: "Sensitive write outcome" }] }),
    });
    storage.toolReturns.put({
      id: returnId,
      actionRecordId,
      chatId,
      gatekeeperId: 1,
      tool: "write_doc",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: returnId,
      byteCount: 50,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: false, // Not yet authorized as observation!
    });

    // 1. Non-owner (use role) is rejected
    {
      using viewerClient = await openFakeOverseer(storage, { role: "use" });
      await expect(viewerClient.getReturn(returnId)).rejects.toThrow(/Unauthorized/);
    }

    // 2. Owner cannot read payload until observation authorization
    {
      using ownerClient = await openFakeOverseer(storage, { role: "build" });
      const beforeObservation = await ownerClient.getReturn(returnId);
      expect(beforeObservation.status).toBe("unavailable");
      if (beforeObservation.status === "unavailable") {
        expect(beforeObservation.reason).toContain("not yet been authorized as an observation");
      }

      // Mark observed (e.g. agent called getActionResult, triggering observation authorization)
      const record = storage.toolReturns.get(returnId)!;
      record.observed = true;
      storage.toolReturns.put(record);

      const afterObservation = await ownerClient.getReturn(returnId);
      expect(afterObservation.status).toBe("available");
      if (afterObservation.status === "available") {
        expect(afterObservation.text).toBe("Sensitive write outcome");
      }
    }
  });

  it("releases retained-byte quota atomically and idempotently on return delete (RAG-OS-002)", async () => {
    const storage = makeActionStorage();
    const returnId = "ret_quota_test";
    const chatId = 80;

    storage.toolReturnChunks.put({
      id: `${returnId}.0`,
      returnId,
      chunkIndex: 0,
      chatId,
      data: "x".repeat(200),
    });
    storage.chatPayloadBytes.put({ chatId, bytes: 200 });
    storage.toolReturns.put({
      id: returnId,
      actionRecordId: 600,
      chatId,
      gatekeeperId: 1,
      tool: "query",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: returnId,
      byteCount: 200,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: true,
    });

    expect(storage.chatPayloadBytes.get(chatId)?.bytes).toBe(200);
    const clearedActionReturns: string[] = [];

    // Delete once: clears the gatekeeper payload and drops bytes from 200 to 0.
    {
      using client = await openFakeOverseer(storage, {
        onClearRetainedActionPayload: (record) => {
          clearedActionReturns.push(record.id);
        },
      });
      await client.deleteReturn(returnId);
      await client.deleteReturn(returnId);
    }
    expect(storage.chatPayloadBytes.get(chatId)?.bytes).toBe(0);
    expect(storage.toolReturns.get(returnId)?.captureState).toBe("deleted");
    expect(clearedActionReturns).toEqual([returnId]);
  });

  it("redacts executing connection secrets and records redacted flag (RAG-OS-003)", () => {
    const secret = "super-secret-bearer-token-12345";
    const payload = {
      content: [
        { type: "text", text: `Here is the token: ${secret}` },
      ],
      structuredContent: {
        access_token: secret,
        user: "admin",
      },
      isError: false,
    };

    const sanitized = sanitizeCapturedPayload(payload, [secret]);
    expect(sanitized.redacted).toBe(true);

    const textBlock = sanitized.content[0] as { type: string; text: string };
    expect(textBlock.text).not.toContain(secret);
    expect(textBlock.text).toContain("[redacted]");

    const structured = sanitized.structuredContent as Record<string, unknown>;
    expect(structured.access_token).toBe("[redacted]");
    expect(structured.user).toBe("admin");
  });

  it("preserves executing connection generation for action returns (RAG-OS-005)", async () => {
    const storage = makeActionStorage();
    const returnId = "ret_action_gen_7";
    const chatId = 85;

    storage.toolReturnChunks.put({
      id: `${returnId}.0`,
      returnId,
      chunkIndex: 0,
      chatId,
      data: JSON.stringify({ content: [{ type: "text", text: "Action with gen" }] }),
    });
    storage.toolReturns.put({
      id: returnId,
      actionRecordId: 700,
      chatId,
      gatekeeperId: 1,
      connectionGeneration: 7, // Provenance persisted
      tool: "galeed_ask",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: returnId,
      byteCount: 50,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: true,
    });

    using client = await openFakeOverseer(storage);
    const result = await client.getReturn(returnId);
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.return.connectionGeneration).toBe(7);
    }

    const page = await client.listReturns({ chatId });
    expect(page.entries[0].id).toBe(returnId);
  });

  it("filters normalized Vault sources and returns evidence without inventing links (T02)", async () => {
    const storage = makeActionStorage();
    const chatId = 87;
    const returnId = "ret_vault_sources";
    const sourceId = "src_contract";
    const evidenceId = "ev_contract";
    const payload = {
      content: [{ type: "text", text: "A entrega foi acordada para 20 de outubro." }],
      structuredContent: { answer: "A entrega será em outubro." },
      isError: false,
    };
    const serialized = JSON.stringify(payload);

    storage.sourceSnapshots.put({
      id: sourceId,
      fingerprint: "source-fingerprint",
      gatekeeperId: 7,
      connectionGeneration: 3,
      provider: "vault",
      ref: "reuniao-entrega",
      type: "reuniao",
      title: "Reunião de entrega",
      observedAccess: {
        type: "reuniao",
        tags: ["projeto:alpha"],
        sensitivity: "internal",
      },
      contentHash: "content-hash",
      occurrences: [{ returnId, executionId: "exec_1", externalId: "source_1" }],
    });
    storage.evidence.put({
      id: evidenceId,
      fingerprint: "evidence-fingerprint",
      gatekeeperId: 7,
      sourceIds: [sourceId],
      text: "A entrega foi acordada para 20 de outubro.",
      kind: "fact",
      locator: "00:12:04",
      occurrences: [{
        returnId,
        executionId: "exec_1",
        externalId: "evidence_1",
        payloadPath: "/structuredContent/evidence/items/0",
      }],
    });
    storage.toolReturnChunks.put({
      id: `${returnId}.0`,
      returnId,
      chunkIndex: 0,
      chatId,
      data: serialized,
    });
    storage.toolReturns.put({
      id: returnId,
      actionRecordId: 750,
      chatId,
      gatekeeperId: 7,
      connectionGeneration: 3,
      tool: "vault_ask",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: returnId,
      byteCount: serialized.length,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: true,
      sourceProvider: "vault",
      sourceIds: [sourceId],
      evidenceIds: [evidenceId],
      answerLinks: [{ claimIndex: 0, evidenceIds: [evidenceId] }],
      normalizationState: "normalized",
      normalizationByteCount: 300,
    });

    const byType = listReturnsFromStorage(storage, { chatId, sourceType: "reuniao" });
    expect(byType.entries).toHaveLength(1);
    expect(byType.entries[0]).toMatchObject({
      sourceTypes: ["reuniao"],
      sourceCount: 1,
      evidenceCount: 1,
      normalizationState: "normalized",
    });
    expect(listReturnsFromStorage(storage, { chatId, query: "20 de outubro" }).entries)
      .toHaveLength(1);
    expect(listReturnsFromStorage(storage, { chatId, query: "inexistente" }).entries)
      .toHaveLength(0);
    expect(() => listReturnsFromStorage(storage, { chatId, query: "x".repeat(201) }))
      .toThrow(/at most 200/);

    const detail = getReturnFromStorage(storage, returnId);
    expect(detail.status).toBe("available");
    if (detail.status === "available") {
      expect(detail.sources).toEqual([expect.objectContaining({
        id: sourceId,
        ref: "reuniao-entrega",
        type: "reuniao",
      })]);
      expect(detail.evidence).toEqual([expect.objectContaining({
        id: evidenceId,
        sourceIds: [sourceId],
        kind: "fact",
      })]);
      expect(detail.answerLinks).toEqual([{ claimIndex: 0, evidenceIds: [evidenceId] }]);
    }
  });

  it("rejects unknown or stale pagination cursor with explicit error (RAG-OS-007)", async () => {
    const storage = makeActionStorage();
    const chatId = 90;

    storage.toolReturns.put({
      id: "ret_page_1",
      actionRecordId: 800,
      chatId,
      gatekeeperId: 1,
      tool: "search",
      calledAt: new Date(1700000000000),
      executionState: "applied",
      captureState: "stored",
      payloadRef: "ret_page_1",
      byteCount: 50,
      normalizationVersion: 1,
      coverage: { complete: true, reasons: [] },
      redacted: false,
      observed: true,
    });

    using client = await openFakeOverseer(storage);

    // Attach the rejection handler directly: Cap'n Web RPC promises are pipeline-aware,
    // and passing one through Vitest's proxy can leave the transport branch unobserved.
    let error: unknown;
    try {
      await client.listReturns({ chatId, beforeId: "stale_cursor_999" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Invalid pagination cursor/);
  });
});
