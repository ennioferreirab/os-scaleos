import { RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SlackApi } from "./slack-api";
import type { SlackConversationInfo } from "./types";
import type { ContextAuthority } from "@gadgets/workshop-shared/gatekeeper";
import type {
  ConversationConfiguratorRpc, ConfiguratorOption,
} from "./configurator/conversation-configurator-types";
import type { WorkspaceConfiguratorRpc } from "./configurator/workspace-configurator-types";
import type { ThreadConfiguratorRpc } from "./configurator/thread-configurator-types";

type ConfiguratorAuthority = RpcTarget & Pick<ContextAuthority, "assertAppAccess">;
const PICKER_MAX_PAGES = 5;
const PICKER_PAGE_SIZE = 200;
const PICKER_MAX_OPTIONS = 100;

// Keep the SlackApi (and thus the token getter) off the public RpcTarget surface.
const apiByTarget = new WeakMap<object, SlackApi>();
const authorityByTarget = new WeakMap<object, RpcStub<ConfiguratorAuthority>>();
const teamIdByTarget = new WeakMap<object, string>();

function apiFor(target: object): SlackApi {
  let api = apiByTarget.get(target);
  if (!api) throw new Error("Slack configurator is not initialized.");
  return api;
}

function authorityFor(target: object): RpcStub<ConfiguratorAuthority> {
  let authority = authorityByTarget.get(target);
  if (!authority) throw new Error("Slack configurator is not initialized.");
  return authority;
}

function optionMatches(parts: (string | undefined)[], query: string): boolean {
  let lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return true;
  let corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lowerQuery.split(/\s+/).every(term => corpus.includes(term));
}

@validateRpc()
export class WorkspaceConfiguratorUI extends RpcTarget implements WorkspaceConfiguratorRpc {
  constructor(api: SlackApi, authority: RpcStub<ConfiguratorAuthority>) {
    super();
    apiByTarget.set(this, api);
    authorityByTarget.set(this, authority);
  }

  [Symbol.dispose](): void {
    authorityFor(this)[Symbol.dispose]();
  }

  async getWorkspaceUrl(): Promise<string> {
    await authorityFor(this).assertAppAccess();
    let info = await apiFor(this).getWorkspaceInfo();
    return `https://app.slack.com/client/${info.teamId}`;
  }
}

@validateRpc()
export class ThreadConfiguratorUI extends RpcTarget implements ThreadConfiguratorRpc {
  constructor(authority: RpcStub<ConfiguratorAuthority>) {
    super();
    authorityByTarget.set(this, authority);
  }

  [Symbol.dispose](): void {
    authorityFor(this)[Symbol.dispose]();
  }

  async ping(): Promise<void> {
    await authorityFor(this).assertAppAccess();
  }
}

@validateRpc()
export class ConversationConfiguratorUI extends RpcTarget implements ConversationConfiguratorRpc {
  constructor(api: SlackApi, teamId: string, authority: RpcStub<ConfiguratorAuthority>) {
    super();
    apiByTarget.set(this, api);
    authorityByTarget.set(this, authority);
    teamIdByTarget.set(this, teamId);
  }

  [Symbol.dispose](): void {
    authorityFor(this)[Symbol.dispose]();
  }

  async getTeamId(): Promise<string> {
    await authorityFor(this).assertAppAccess();
    return teamIdByTarget.get(this) ?? "";
  }

  async listConversations(query: string): Promise<ConfiguratorOption[]> {
    await authorityFor(this).assertAppAccess();
    let api = apiFor(this);
    let items: SlackConversationInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PICKER_MAX_PAGES; page++) {
      if (page > 0) await authorityFor(this).assertAppAccess();
      let result = await api.listUserConversations(
          ["public_channel", "private_channel", "im", "mpim"], cursor, PICKER_PAGE_SIZE);
      items.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor || items.length >= PICKER_MAX_OPTIONS * 3) break;
    }

    return items
        .map(info => this.#toOption(info))
        .filter(option => optionMatches([option.title, option.subtitle], query))
        .slice(0, PICKER_MAX_OPTIONS);
  }

  #toOption(info: SlackConversationInfo): ConfiguratorOption {
    switch (info.kind) {
      case "public_channel":
        return { value: info.id, title: `#${info.name ?? info.id}`, subtitle: "Public channel" };
      case "private_channel":
        return { value: info.id, title: `#${info.name ?? info.id}`, subtitle: "Private channel" };
      case "mpim":
        return { value: info.id, title: info.name ?? "Group DM", subtitle: "Group direct message" };
      case "im": {
        let name = info.peer ? (info.peer.displayName || info.peer.username) : info.id;
        return { value: info.id, title: `@${name}`, subtitle: "Direct message" };
      }
    }
  }
}
