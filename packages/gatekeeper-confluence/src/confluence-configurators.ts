import { RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AppUiAuthority } from "@gadgets/workshop-shared/gatekeeper";
import {
  ConfluenceApi,
  buildCql,
  type AccessibleResource,
} from "./confluence-api";
import type { ConfiguratorOption } from "./configurator/confluence-site-configurator-types";
import type { ConfluenceSpaceConfiguratorRpc } from "./configurator/confluence-space-configurator-types";
import type { ConfluencePageConfiguratorRpc } from "./configurator/confluence-page-configurator-types";
import type { ConfluenceSiteConfiguratorRpc } from "./configurator/confluence-site-configurator-types";

const OPTION_LIMIT = 50;

// Token/site getters and the live app authority are held off-instance so they aren't exposed as
// RPC-accessible properties.
type Context = {
  getSites: () => Promise<AccessibleResource[]>;
  getToken: () => Promise<string>;
  authority: RpcStub<AppUiAuthority>;
};
const contexts = new WeakMap<object, Context>();

function ctx(target: object): Context {
  const c = contexts.get(target);
  if (!c) throw new Error("Confluence configurator is not initialized.");
  return c;
}

function requireAppAccess(target: object): Promise<void> {
  return ctx(target).authority.requireAppAccess();
}

function disposeAuthority(authority: RpcStub<AppUiAuthority>): void {
  (authority as RpcStub<AppUiAuthority> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

const apiFor = (site: AccessibleResource, getToken: () => Promise<string>): ConfluenceApi =>
  new ConfluenceApi({ cloudId: site.id, webBase: `${site.url}/wiki`, getToken });

// Single capability backing all three configurator iframes (each calls only the method it needs).
@validateRpc()
export class ConfluenceConfiguratorUI extends RpcTarget
    implements ConfluenceSiteConfiguratorRpc, ConfluenceSpaceConfiguratorRpc, ConfluencePageConfiguratorRpc {
  constructor(
    getSites: () => Promise<AccessibleResource[]>,
    getToken: () => Promise<string>,
    authority: RpcStub<AppUiAuthority>,
  ) {
    super();
    contexts.set(this, { getSites, getToken, authority: authority.dup() });
  }

  [Symbol.dispose]() {
    disposeAuthority(ctx(this).authority);
  }

  async listSites(query: string): Promise<ConfiguratorOption[]> {
    await requireAppAccess(this);
    const { getSites } = ctx(this);
    const q = query.trim().toLowerCase();
    return (await getSites())
      .filter(site => !q || site.name.toLowerCase().includes(q) || site.url.toLowerCase().includes(q))
      .slice(0, OPTION_LIMIT)
      .map(site => ({ value: `${site.url}/wiki`, title: site.name, subtitle: site.url }));
  }

  async listSpaces(query: string): Promise<ConfiguratorOption[]> {
    await requireAppAccess(this);
    const { getSites, getToken } = ctx(this);
    const sites = await getSites();
    const q = query.trim().toLowerCase();
    const perSite = await Promise.all(sites.map(async site => {
      const { results } = await apiFor(site, getToken).listSpaces({ limit: OPTION_LIMIT });
      return results
        .filter(space => !q || space.name.toLowerCase().includes(q) || space.key.toLowerCase().includes(q))
        .map(space => ({
          value: `${site.url}/wiki/spaces/${space.key}`,
          title: space.name,
          subtitle: sites.length > 1 ? `${space.key} · ${site.name}` : space.key,
        }));
    }));
    return perSite.flat().slice(0, OPTION_LIMIT);
  }

  async listPages(query: string): Promise<ConfiguratorOption[]> {
    await requireAppAccess(this);
    const { getSites, getToken } = ctx(this);
    const sites = await getSites();
    const cql = buildCql({ text: query.trim() || undefined });
    const perSite = await Promise.all(sites.map(async site => {
      const { results } = await apiFor(site, getToken).search(cql, { limit: OPTION_LIMIT });
      return results.map(summary => ({
        value: summary.url,
        title: summary.title || "Untitled",
        subtitle: [summary.type === "blogpost" ? "Blog post" : "Page", sites.length > 1 ? site.name : undefined]
          .filter(Boolean)
          .join(" · "),
      }));
    }));
    return perSite.flat().slice(0, OPTION_LIMIT);
  }
}
