// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContextLibraryPage from "./ContextLibraryPage";
import { ContextApiProvider } from "./bridge";
import type {
  ContextApi,
  ContextCollectionMetadata,
  EnabledCollectionInfo,
} from "../src/context-types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const collection: EnabledCollectionInfo = {
  id: "test-skills",
  title: "Test Skills",
  description: "",
  role: "owner",
  sources: ["owner"],
  lastUpdated: new Date("2026-09-10T00:00:00Z"),
};

const metadata: ContextCollectionMetadata = {
  id: collection.id,
  title: collection.title,
  description: collection.description,
  visibility: "private",
  created: new Date("2026-09-10T00:00:00Z"),
  lastUpdated: collection.lastUpdated,
  documentCount: 0,
  content: { source: "web" },
};

function apiWithList(
  listEnabledContextCollections: () => Promise<EnabledCollectionInfo[]>,
): RpcStub<ContextApi> {
  return {
    listEnabledContextCollections,
    getContextCollectionMetadata: async () => metadata,
    listContextDocuments: async () => [],
    getMyAccess: async () => ({ role: "owner", sources: ["owner"] }),
    getViewerInfo: async () => ({ isAdmin: false, supportsGitCollections: false }),
  } as unknown as RpcStub<ContextApi>;
}

describe("ContextLibraryPage collection loading", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(api: RpcStub<ContextApi>) {
    await act(async () => {
      root.render(
        <ContextApiProvider value={api}>
          <TooltipProvider>
            <Toasty>
              <ContextLibraryPage />
            </Toasty>
          </TooltipProvider>
        </ContextApiProvider>,
      );
    });
  }

  it("settles a rejected collection request as a safe failure", async () => {
    const request = deferred<EnabledCollectionInfo[]>();
    await render(apiWithList(() => request.promise));

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => request.reject(new Error("private backend detail")));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain("private backend detail");
    expect(container.textContent).not.toContain("No collections yet");
  });

  it("keeps the newest failure when an older request resolves later", async () => {
    const olderRequest = deferred<EnabledCollectionInfo[]>();
    const newerRequest = deferred<EnabledCollectionInfo[]>();
    await render(apiWithList(() => olderRequest.promise));
    await render(apiWithList(() => newerRequest.promise));

    await act(async () => newerRequest.reject(new Error("newest request failed")));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    await act(async () => olderRequest.resolve([collection]));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(collection.title);
  });

  it("renders a successful empty collection list as empty", async () => {
    await render(apiWithList(async () => []));

    await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("No collections yet");
  });

  it("does not retain collection rows when a return-path reload fails", async () => {
    const listEnabledContextCollections = vi
      .fn<() => Promise<EnabledCollectionInfo[]>>()
      .mockResolvedValueOnce([collection])
      .mockRejectedValueOnce(new Error("list failed"));
    await render(apiWithList(listEnabledContextCollections));

    await vi.waitFor(() => expect(container.textContent).toContain(collection.title));
    const row = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((element) => element.textContent?.includes(collection.title));
    expect(row).toBeDefined();
    await act(async () => row!.click());

    const back = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Context & Skills"));
    expect(back).toBeDefined();
    await act(async () => back!.click());
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    expect(listEnabledContextCollections).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(collection.title);
  });
});
