import { expect, it } from "vitest";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { MAX_TOOL_NAME_CHARS } from "../src/client.js";
import type { WithClientOptions } from "../src/connection.js";
import { classifyTool } from "../src/tools.js";

it("reports an execution failure distinctly from a rejected approval", async () => {
  const failed: StoredAction = {
    id: 1,
    toolName: "send",
    args: {},
    state: "failed",
    submittedAt: 0,
    retryable: false,
    error: "The outcome is unknown.",
  };
  const host = {
    serverName: "Example",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => failed,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {} } as never);

  await expect(session.getActionResult(1)).resolves.toEqual({
    status: "failed",
    message: "The outcome is unknown.",
  });
});

it("tells an agent to return a pending action so its approval can appear in chat", async () => {
  const entry = classifyTool({ name: "jira_create_issue" }, "byo");
  const staged: StoredAction = {
    id: 7,
    toolName: entry.tool.name,
    args: {},
    state: "pending",
    submittedAt: 0,
  };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => entry,
    stageAction: () => staged,
    discardStagedAction() {},
    actionKindFor: () => ({ tag: "jira:create", label: "Create issue" }),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, submitAction() {} } as never);

  const result = await session.callTool(entry.tool.name);

  expect(result).toMatchObject({ status: "pending", actionId: staged.id });
  if (result.status !== "pending") throw new Error("Expected a pending action.");
  expect(result.message).toContain("return from this executeCode call");
  expect(result.message).not.toMatch(/poll/i);
});

it("searches progressively discovered tools and records the catalog read", async () => {
  const found = classifyTool({
    name: "jira_search_issues",
    description: "Search Jira issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const observations: unknown[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [found],
  } as unknown as McpSessionHost;
  const queue = {
    assertAppAccess() {},
    authorizeObservation: (description: unknown) => { observations.push(description); },
  };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.listTools({ search: "issues" })).resolves.toEqual([{
    name: "jira_search_issues",
    description: "Search Jira issues",
    mode: "read",
    classifiedBy: "server-annotation",
    inputSchema: undefined,
    title: undefined,
  }]);
  expect(observations).toHaveLength(1);
});

it("calls a tool resolved beyond the initial generated catalog", async () => {
  const expanded = classifyTool({
    name: "jira_search_issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    tools: async () => [],
    findTool: async () => expanded,
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    } as never),
  } as unknown as McpSessionHost;
  const queue = { assertAppAccess() {}, authorizeObservation() {} };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.callTool("jira_search_issues", { query: "open" })).resolves.toMatchObject({
    status: "ok",
    text: "PROJ-1",
  });
});

it("identifies the tool in a describe observation", async () => {
  const observations: { description: string }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => classifyTool({ name: "jira_search_issues" }, "byo"),
  } as unknown as McpSessionHost;
  const queue = {
    assertAppAccess() {},
    authorizeObservation: (description: { description: string }) => {
      observations.push(description);
    },
  };
  const session = new McpSessionBase(host, queue as never);

  await session.listTools({ name: "jira_search_issues" });
  expect(observations[0].description).toContain("jira_search_issues");
});

it("names the grant, not the server, when a scoped binding lacks the tool", async () => {
  // On a scoped binding the tool may well exist on the endpoint. "No such tool" would send an agent
  // hunting for a typo it will not find, so both entry points have to say the same thing.
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => undefined,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);

  await expect(session.listTools({ name: "gh_list_issues" })).resolves.toEqual([]);
  await expect(session.callTool("gh_list_issues"))
    .rejects.toThrow('This binding does not grant a tool named "gh_list_issues".');
});

it("says the server has no such tool when the whole endpoint was granted", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => undefined,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);

  await expect(session.listTools({ name: "nope" })).resolves.toEqual([]);
});

it("records what was searched, with the agent's text defused", async () => {
  // The query is the agent's, and an observation is read by a person: left alone it can close the
  // markdown it sits in and carry on in the record's own voice.
  const observations: { description: string }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [],
  } as unknown as McpSessionHost;
  const queue = {
    assertAppAccess() {},
    authorizeObservation: (d: { description: string }) => { observations.push(d); },
  };
  const session = new McpSessionBase(host, queue as never);

  await session.listTools({ search: "issues `**Approved**`" });
  expect(observations[0].description).toContain("issues Approved");
  expect(observations[0].description).toContain("returned 0 match(es)");
  expect(observations[0].description).not.toContain("**Approved**");
});

it("returns the same compact summary shape from a complete local catalog", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [classifyTool({
      name: "jira_search_issues",
      description: "x".repeat(4000),
      inputSchema: { type: "object" },
    }, "byo")],
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);

  const [summary] = await session.listTools({ search: "issues" });

  expect(summary.description).toBe(`${"x".repeat(256)}\u2026`);
  expect(summary).not.toHaveProperty("inputSchema");
});

it("refuses an empty or oversized query before calling the endpoint", async () => {
  let searches = 0;
  const searchTools = async () => { searches++; return []; };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    searchTools,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);

  await expect(session.listTools({ search: "   " })).rejects.toThrow(/non-empty query/);
  await expect(session.listTools({ search: " _ - " })).rejects.toThrow(/search terms/);
  // Bounded on the trimmed text, which is what is actually searched and recorded.
  await expect(session.listTools({ search: `${" ".repeat(50)}${"x".repeat(201)}` }))
    .rejects.toThrow(/at most 200 characters/);
  await expect(session.listTools({ search: `  ${"x".repeat(200)}  ` })).resolves.toEqual([]);
  expect(searches).toBe(1);
});

it("refuses ambiguous progressive list options", async () => {
  const host = { serverName: "Jira", endpoint: "https://mcp.example.com", scope: {} } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);

  await expect(session.listTools({ name: "jira_search", search: "jira" } as never))
    .rejects.toThrow(/exactly one/);
  await expect(session.listTools({} as never)).rejects.toThrow(/exactly one/);
});

it("treats optional selectors set to undefined as absent", async () => {
  const found = classifyTool({ name: "jira_search", annotations: { readOnlyHint: true } }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    searchTools: async () => [found],
    findTool: async () => found,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);

  await expect(session.listTools({ search: "jira", name: undefined }))
    .resolves.toHaveLength(1);
  await expect(session.listTools({ name: "jira_search", search: undefined }))
    .resolves.toHaveLength(1);
});

it("refuses oversized tool names before consulting the host", async () => {
  let finds = 0;
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => { finds++; return undefined; },
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { assertAppAccess() {}, authorizeObservation() {} } as never);
  const oversized = "x".repeat(MAX_TOOL_NAME_CHARS + 1);

  await expect(session.listTools({ name: oversized })).rejects.toThrow(/tool name.*at most/i);

  await expect(session.callTool(oversized)).rejects.toThrow(/tool name.*at most/i);
  expect(finds).toBe(0);
});

it("allocates before I/O and captures read result before delivery when chat is active", async () => {
  const entry = classifyTool({ name: "search", annotations: { readOnlyHint: true } }, "byo");
  let ioCompleted = false;
  let prepareCalledBeforeIo = false;
  let captured = false;

  const host = {
    serverName: "Vault",
    endpoint: "https://vault.example.com",
    scope: {},
    sourceProvider: "vault" as const,
    vaultWebUrl: "https://vault.example/",
    findTool: async () => entry,
    call: async <T>(
      fn: (client: { callTool(): Promise<{ content: { type: "text"; text: string }[]; structuredContent: { facts: never[] } }> }) => Promise<T>,
      options: WithClientOptions,
    ) => {
      await options.onConnection?.({ generation: 2, secrets: ["vault-secret"] });
      ioCompleted = true;
      return fn({
        callTool: async () => ({
          content: [{ type: "text" as const, text: "knowledge" }],
          structuredContent: { facts: [] },
        }),
      });
    },
  } as unknown as McpSessionHost;

  const queue = {
    assertAppAccess() {},
    prepareToolObservation: async (req: any) => {
      prepareCalledBeforeIo = !ioCompleted;
      expect(req.tool).toBe("search");
      expect(req.connectionGeneration).toBe(2);
      return {
        captureResult: async (res: any) => {
          captured = true;
          expect(res.connectionGeneration).toBe(2);
          expect(res.secrets).toEqual(["vault-secret"]);
          expect(res.content[0].text).toBe("knowledge");
          expect(res.sourceProvider).toBe("vault");
          expect(res.vaultWebUrl).toBe("https://vault.example/");
          return { status: "stored" as const, returnId: "ret_obs_1", byteCount: 50 };
        },
      };
    },
    authorizeObservation: () => {},
  };

  const session = new McpSessionBase(host, queue as never);
  const result = await session.callTool("search", { q: "test" });

  expect(prepareCalledBeforeIo).toBe(true);
  expect(captured).toBe(true);
  expect(result).toMatchObject({
    status: "ok",
    text: "knowledge",
    returnId: "ret_obs_1",
  });
});

it("surfaces capture failure without returnId when storage capture fails", async () => {
  const entry = classifyTool({ name: "search", annotations: { readOnlyHint: true } }, "byo");
  const host = {
    serverName: "Vault",
    endpoint: "https://vault.example.com",
    scope: {},
    findTool: async () => entry,
    call: async <T>(
      fn: (client: { callTool(): Promise<{ content: { type: "text"; text: string }[] }> }) => Promise<T>,
      options: WithClientOptions,
    ) => {
      await options.onConnection?.({ generation: 3, secrets: ["rotated-secret"] });
      return fn({
        callTool: async () => ({ content: [{ type: "text" as const, text: "data" }] }),
      });
    },
  } as unknown as McpSessionHost;

  const queue = {
    assertAppAccess() {},
    prepareToolObservation: async () => ({
      captureResult: async () => ({ status: "failed" as const, error: "Quota exceeded" }),
    }),
    authorizeObservation: () => {},
  };

  const session = new McpSessionBase(host, queue as never);
  const result = await session.callTool("search");

  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.returnId).toBeUndefined();
    expect(result.captureError).toBe("Quota exceeded");
  }
});

it("reuses the same returnId when getActionResult is called repeatedly", async () => {
  const appliedAction: StoredAction = {
    id: 10,
    toolName: "create_doc",
    args: {},
    state: "applied",
    submittedAt: 0,
    returnId: "ret_act_10",
    result: undefined,
  };
  const observations: unknown[] = [];
  const host = {
    serverName: "Docs",
    endpoint: "https://docs.example.com",
    scope: {},
    lookupAction: () => appliedAction,
    deleteActionReturn: () => {},
  } as unknown as McpSessionHost;
  const queue = {
    assertAppAccess() {},
    authorizeActionReturn: (_returnId: string, desc: unknown) => {
      observations.push(desc);
      return JSON.stringify({
        content: [{ type: "text", text: "Created document" }],
      });
    },
  };

  const session = new McpSessionBase(host, queue as never);
  const first = await session.getActionResult(10);
  const second = await session.getActionResult(10);

  expect(first).toEqual(second);
  if (first.status === "ok" && second.status === "ok") {
    expect(first.returnId).toBe("ret_act_10");
    expect(second.returnId).toBe("ret_act_10");
  }
  expect(observations).toHaveLength(2); // Each collection audits the observation
});

it("disposes observation capture handle when host.call fails (RAG-OS-008)", async () => {
  const entry = classifyTool({ name: "search", annotations: { readOnlyHint: true } }, "byo");
  let disposed = false;

  const host = {
    serverName: "Vault",
    endpoint: "https://vault.example.com",
    scope: {},
    findTool: async () => entry,
    call: async <T>(
      _fn: (client: never) => Promise<T>,
      options: WithClientOptions,
    ) => {
      await options.onConnection?.({ generation: 4, secrets: ["vault-secret"] });
      throw new Error("Network timeout contacting MCP endpoint");
    },
  } as unknown as McpSessionHost;

  const queue = {
    assertAppAccess() {},
    prepareToolObservation: async () => ({
      captureResult: async () => ({ status: "stored" as const, returnId: "ret_1", byteCount: 10 }),
      [Symbol.dispose]: () => {
        disposed = true;
      },
    }),
    authorizeObservation: () => {},
  };

  const session = new McpSessionBase(host, queue as never);
  await expect(session.callTool("search")).rejects.toThrow(/Network timeout/);
  expect(disposed).toBe(true);
});

it("marks action result failed if its return was deleted before collection (RAG-OS-006)", async () => {
  const appliedAction: StoredAction = {
    id: 15,
    toolName: "create_doc",
    args: {},
    state: "applied",
    submittedAt: 0,
    returnId: "ret_deleted_15",
    result: undefined,
  };
  let deletedId: number | undefined;
  const host = {
    serverName: "Docs",
    endpoint: "https://docs.example.com",
    scope: {},
    lookupAction: () => appliedAction,
    deleteActionReturn: (id: number) => {
      deletedId = id;
    },
  } as unknown as McpSessionHost;
  const queue = {
    assertAppAccess() {},
    authorizeActionReturn: async (returnId: string) => {
      expect(returnId).toBe("ret_deleted_15");
      return null;
    },
  };

  const session = new McpSessionBase(host, queue as never);
  const outcome = await session.getActionResult(15);
  expect(outcome.status).toBe("failed");
  if (outcome.status === "failed") {
    expect(outcome.message).toContain("deleted");
  }
  expect(deletedId).toBe(15);
});

it("denies every retained MCP read before consulting the host", async () => {
  const appAccessError = new Error("app access denied");
  let catalogReads = 0;
  let searches = 0;
  let finds = 0;
  let remoteCalls = 0;
  let actionReads = 0;
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    tools: async () => { catalogReads++; return []; },
    searchTools: async () => { searches++; return []; },
    findTool: async () => { finds++; return undefined; },
    call: async () => { remoteCalls++; return undefined; },
    lookupAction: () => { actionReads++; return undefined; },
  } as unknown as McpSessionHost;
  const queue = {
    assertAppAccess: async () => { throw appAccessError; },
    authorizeObservation() {},
  };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.listTools()).rejects.toBe(appAccessError);
  await expect(session.listTools({ name: "jira_search" })).rejects.toBe(appAccessError);
  await expect(session.listTools({ search: "issues" })).rejects.toBe(appAccessError);
  await expect(session.callTool("jira_search")).rejects.toBe(appAccessError);
  await expect(session.getActionResult(1)).rejects.toBe(appAccessError);

  expect(catalogReads).toBe(0);
  expect(searches).toBe(0);
  expect(finds).toBe(0);
  expect(remoteCalls).toBe(0);
  expect(actionReads).toBe(0);
});
