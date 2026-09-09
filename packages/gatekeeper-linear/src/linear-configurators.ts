import { RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AppUiAuthority } from "@gadgets/workshop-shared/gatekeeper";
import { LinearApi, type RawConnection, type RawTeam } from "./linear-api";
import type { LinearWorkspaceConfiguratorRpc } from "./configurator/linear-workspace-configurator-types";
import type { LinearTeamConfiguratorRpc } from "./configurator/linear-team-configurator-types";
import type { LinearIssueConfiguratorRpc } from "./configurator/linear-issue-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const OPTION_LIMIT = 50;

// Keep the token getter and live app authority off the RpcTarget's public surface.
const tokenGetters = new WeakMap<object, () => Promise<string>>();
const authorities = new WeakMap<object, RpcStub<AppUiAuthority>>();

function api(target: object): LinearApi {
  const getToken = tokenGetters.get(target);
  const authority = authorities.get(target);
  if (!getToken || !authority) throw new Error("Linear configurator is not initialized.");
  return new LinearApi(getToken).withBeforeRequest(() => authority.requireAppAccess());
}

function requireAppAccess(target: object): Promise<void> {
  const authority = authorities.get(target);
  if (!authority) throw new Error("Linear configurator is not initialized.");
  return authority.requireAppAccess();
}

function disposeAuthority(authority: RpcStub<AppUiAuthority>): void {
  (authority as RpcStub<AppUiAuthority> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

// Per-instance cache of the workspace url key (the first path segment of linear.app URLs).
const urlKeyCache = new WeakMap<object, Promise<string>>();

function workspaceUrlKey(target: object): Promise<string> {
  const cached = urlKeyCache.get(target);
  if (cached) return cached;
  const pending = api(target).getOrganization().then(org => org.urlKey);
  urlKeyCache.set(target, pending);
  pending.catch(() => urlKeyCache.delete(target));
  return pending;
}

// Per-instance cache of the team list. listTeams filters client-side, so we fetch once per
// configurator session instead of on every autocomplete keystroke.
const teamsCache = new WeakMap<object, Promise<RawConnection<RawTeam>>>();

function allTeams(target: object): Promise<RawConnection<RawTeam>> {
  const cached = teamsCache.get(target);
  if (cached) return cached;
  const pending = api(target).listTeams({ first: 250 });
  teamsCache.set(target, pending);
  pending.catch(() => teamsCache.delete(target));
  return pending;
}

function matches(parts: (string | null | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every(term => corpus.includes(term));
}

@validateRpc()
export class LinearWorkspaceConfiguratorUI extends RpcTarget implements LinearWorkspaceConfiguratorRpc {
  constructor(getToken: () => Promise<string>, authority: RpcStub<AppUiAuthority>) {
    super();
    tokenGetters.set(this, getToken);
    authorities.set(this, authority.dup());
  }

  [Symbol.dispose]() {
    const authority = authorities.get(this);
    if (authority) disposeAuthority(authority);
  }

  async getWorkspaceUrlKey(): Promise<string> {
    await requireAppAccess(this);
    return await workspaceUrlKey(this);
  }

  async listWorkspaces(): Promise<ConfiguratorOption[]> {
    await requireAppAccess(this);
    // A Linear OAuth token is scoped to a single workspace, so there is exactly one option.
    const org = await api(this).getOrganization();
    return [{ value: org.urlKey, title: org.name, subtitle: `linear.app/${org.urlKey}` }];
  }
}

@validateRpc()
export class LinearTeamConfiguratorUI extends LinearWorkspaceConfiguratorUI implements LinearTeamConfiguratorRpc {
  async listTeams(query: string): Promise<ConfiguratorOption[]> {
    await requireAppAccess(this);
    const conn = await allTeams(this);
    return conn.nodes
      .filter(team => matches([team.key, team.name, team.description], query))
      .slice(0, OPTION_LIMIT)
      .map(team => ({
        value: team.key,
        title: `${team.key} · ${team.name}`,
        subtitle: team.description ?? undefined,
        meta: team.private ? "private" : undefined,
      }));
  }
}

@validateRpc()
export class LinearIssueConfiguratorUI extends LinearWorkspaceConfiguratorUI implements LinearIssueConfiguratorRpc {
  async listIssues(query: string): Promise<ConfiguratorOption[]> {
    await requireAppAccess(this);
    const trimmed = query.trim();
    const conn = trimmed
      ? await api(this).searchIssues({ term: trimmed, first: OPTION_LIMIT })
      : await api(this).listIssues({ first: OPTION_LIMIT, orderBy: "updatedAt" });
    const options = conn.nodes.map(issue => ({
      value: issue.identifier,
      title: `${issue.identifier} ${issue.title}`,
      subtitle: issue.assignee ? `Assigned to ${issue.assignee.displayName ?? issue.assignee.name}` : undefined,
      meta: issue.state?.name,
    }));

    // If the query looks like an exact identifier that didn't surface, try a direct lookup.
    const exact = trimmed.match(/^[A-Za-z][A-Za-z0-9]*-\d+$/);
    if (exact && !options.some(o => o.value.toLowerCase() === trimmed.toLowerCase())) {
      try {
        const issue = await api(this).getIssue(trimmed.toUpperCase());
        if (issue) {
          options.unshift({
            value: issue.identifier,
            title: `${issue.identifier} ${issue.title}`,
            subtitle: issue.assignee ? `Assigned to ${issue.assignee.displayName ?? issue.assignee.name}` : undefined,
            meta: issue.state?.name,
          });
        }
      } catch {
        // ignore failed exact lookups
      }
    }

    return options.slice(0, OPTION_LIMIT);
  }
}
