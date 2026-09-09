import { RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ContextAuthority } from "@gadgets/workshop-shared/gatekeeper";
import { NotionApi, itemResponseToSummary } from "./notion-api";
import type {
  ConfiguratorOption,
  NotionItemConfiguratorRpc,
} from "./configurator/notion-item-configurator-types";
import type { NotionWorkspaceConfiguratorRpc } from "./configurator/notion-workspace-configurator-types";

type ConfiguratorAuthority = RpcTarget & Pick<ContextAuthority, "assertAppAccess">;
const OPTION_LIMIT = 100;


// Token getter and live app authority are held off-instance so they aren't exposed as RPC-accessible
// properties.
type Context = {
  getToken: () => Promise<string>;
  authority: RpcStub<ConfiguratorAuthority>;
};
const contexts = new WeakMap<object, Context>();

function ctx(target: object): Context {
  const context = contexts.get(target);
  if (!context) throw new Error("Notion configurator is not initialized.");
  return context;
}

function notionApi(target: object): NotionApi {
  const context = ctx(target);
  return new NotionApi(context.getToken).withBeforeRequest(
    () => context.authority.assertAppAccess());
}

function assertAppAccess(target: object): Promise<void> {
  return ctx(target).authority.assertAppAccess();
}

function disposeAuthority(authority: RpcStub<ConfiguratorAuthority>): void {
  authority[Symbol.dispose]();
}

// Capability exposed to the page/database configurator iframe.
@validateRpc()
export class NotionItemConfiguratorUI extends RpcTarget implements NotionItemConfiguratorRpc {
  constructor(getToken: () => Promise<string>, authority: RpcStub<ConfiguratorAuthority>) {
    super();
    contexts.set(this, { getToken, authority: authority.dup() });
  }

  [Symbol.dispose]() {
    disposeAuthority(ctx(this).authority);
  }

  async listItems(query: string): Promise<ConfiguratorOption[]> {
    await assertAppAccess(this);
    const trimmed = query.trim();
    const result = await notionApi(this).search({
      query: trimmed || undefined,
      page_size: OPTION_LIMIT,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
    return result.results.map(item => {
      const summary = itemResponseToSummary(item);
      const option: ConfiguratorOption = {
        value: summary.url,
        title: summary.title || "Untitled",
        subtitle: summary.kind === "database" ? "Database" : "Page",
      };
      if (summary.icon) option.meta = summary.icon;
      return option;
    });
  }
}

// Capability exposed to the whole-workspace configurator iframe.
@validateRpc()
export class NotionWorkspaceConfiguratorUI extends RpcTarget implements NotionWorkspaceConfiguratorRpc {
  constructor(getToken: () => Promise<string>, authority: RpcStub<ConfiguratorAuthority>) {
    super();
    contexts.set(this, { getToken, authority: authority.dup() });
  }

  [Symbol.dispose]() {
    disposeAuthority(ctx(this).authority);
  }

  async getWorkspaceName(): Promise<string | null> {
    await assertAppAccess(this);
    try {
      const bot = await notionApi(this).getBotUser();
      return bot.workspaceName ?? null;
    } catch {
      return null;
    }
  }
}
