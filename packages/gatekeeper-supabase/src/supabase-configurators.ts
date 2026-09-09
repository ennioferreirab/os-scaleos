import { RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SupabaseApi, type OrganizationResponse, type ProjectResponse } from "./supabase-api";
import type { AppUiAuthority } from "@gadgets/workshop-shared/gatekeeper";
import type { SupabaseProjectConfiguratorRpc } from "./configurator/supabase-project-configurator-types";
import type { SupabaseOrganizationConfiguratorRpc } from "./configurator/supabase-organization-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const OPTION_LIMIT = 100;

// Token getters and the app authority are held off the RpcTarget surface.
const tokenGetters = new WeakMap<object, () => Promise<string>>();
const authorities = new WeakMap<object, RpcStub<AppUiAuthority>>();

// Supabase has no server-side project/org search, so we fetch the full list and filter locally.
// Cache the fetch per configurator instance so typing in the picker doesn't refetch on every
// keystroke. Keyed on the instance; cleared on failure so a transient error can be retried.
const projectListCache = new WeakMap<object, Promise<ProjectResponse[]>>();
const orgListCache = new WeakMap<object, Promise<OrganizationResponse[]>>();

function api(target: object): SupabaseApi {
  const getToken = tokenGetters.get(target);
  if (!getToken) throw new Error("Supabase configurator is not initialized.");
  return new SupabaseApi(getToken, () => authorityFor(target).requireAppAccess());
}

function authorityFor(target: object): RpcStub<AppUiAuthority> {
  const authority = authorities.get(target);
  if (!authority) throw new Error("Supabase configurator is not initialized.");
  return authority;
}

function cachedList<T>(
  target: object,
  cache: WeakMap<object, Promise<T[]>>,
  load: () => Promise<T[]>,
): Promise<T[]> {
  let pending = cache.get(target);
  if (!pending) {
    pending = load();
    cache.set(target, pending);
    pending.catch(() => cache.delete(target));
  }
  return pending;
}

function matches(parts: (string | undefined)[], query: string): boolean {
  const lower = query.trim().toLowerCase();
  if (!lower) return true;
  const corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lower.split(/\s+/).every(term => corpus.includes(term));
}

@validateRpc()
export class SupabaseProjectConfiguratorUI extends RpcTarget implements SupabaseProjectConfiguratorRpc {
  constructor(getToken: () => Promise<string>, authority: RpcStub<AppUiAuthority>) {
    super();
    tokenGetters.set(this, getToken);
    authorities.set(this, authority);
  }

  [Symbol.dispose](): void {
    authorityFor(this)[Symbol.dispose]();
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    await authorityFor(this).requireAppAccess();
    const projects = await cachedList(this, projectListCache, () => api(this).listProjects());
    return projects
      .filter(project => matches([project.name, project.ref, project.region], query))
      .slice(0, OPTION_LIMIT)
      .map(project => ({
        value: project.ref,
        title: project.name,
        subtitle: `${project.organization_slug} · ${project.region}`,
        meta: project.ref,
      }));
  }
}

@validateRpc()
export class SupabaseOrganizationConfiguratorUI extends RpcTarget implements SupabaseOrganizationConfiguratorRpc {
  constructor(getToken: () => Promise<string>, authority: RpcStub<AppUiAuthority>) {
    super();
    tokenGetters.set(this, getToken);
    authorities.set(this, authority);
  }

  [Symbol.dispose](): void {
    authorityFor(this)[Symbol.dispose]();
  }

  async listOrganizations(query: string): Promise<ConfiguratorOption[]> {
    await authorityFor(this).requireAppAccess();
    const organizations = await cachedList(this, orgListCache, () => api(this).listOrganizations());
    return organizations
      .filter(org => matches([org.name, org.slug], query))
      .slice(0, OPTION_LIMIT)
      .map(org => ({
        value: org.slug,
        title: org.name,
        subtitle: org.slug,
      }));
  }
}
