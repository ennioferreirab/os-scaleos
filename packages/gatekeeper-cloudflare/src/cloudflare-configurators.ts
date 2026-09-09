import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { listAccounts } from "./cloudflare-api.js";
import { CloudflareObservabilityApi } from "./observability-api.js";
import type { AppUiAuthority } from "@gadgets/workshop-shared/gatekeeper";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorRpc,
  CloudflareWorkerConfiguratorRpc,
} from "./configurator/cloudflare-configurator-types.js";

const OPTION_LIMIT = 100;
const DISCOVERY_LIMIT = 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const tokenGetters = new WeakMap<object, () => Promise<string | null>>();
const appAuthorities = new WeakMap<object, RpcStub<AppUiAuthority>>();

function tokenFor(target: object): Promise<string | null> {
  const getToken = tokenGetters.get(target);
  if (!getToken) throw new Error("Cloudflare configurator is not initialized.");
  return getToken();
}

function appAuthorityFor(target: object): RpcStub<AppUiAuthority> {
  const authority = appAuthorities.get(target);
  if (!authority) throw new Error("Cloudflare configurator is not initialized.");
  return authority;
}

function disposeConfigurator(target: object): void {
  tokenGetters.delete(target);
  const authority = appAuthorities.get(target);
  appAuthorities.delete(target);
  if (authority) {
    (authority as RpcStub<AppUiAuthority> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }
}

@validateRpc()
export class CloudflareAccountConfiguratorUI extends RpcTarget
    implements CloudflareAccountConfiguratorRpc {
  constructor(
    getToken: () => Promise<string | null>,
    authority: RpcStub<AppUiAuthority>,
  ) {
    super();
    tokenGetters.set(this, getToken);
    appAuthorities.set(this, authority.dup());
  }

  [Symbol.dispose](): void {
    disposeConfigurator(this);
  }

  async listAccounts(query: string): Promise<ConfiguratorUIOption[]> {
    const authority = appAuthorityFor(this);
    await authority.requireAppAccess();
    const token = await tokenFor(this);
    if (!token) return [];
    const needle = query.trim().toLowerCase();
    return (await listAccounts(token, () => authority.requireAppAccess()))
      .filter(account => !needle || account.accountName.toLowerCase().includes(needle))
      .slice(0, OPTION_LIMIT)
      .map(account => ({ value: account.accountId, title: account.accountName }));
  }
}

@validateRpc()
export class CloudflareWorkerConfiguratorUI extends CloudflareAccountConfiguratorUI
    implements CloudflareWorkerConfiguratorRpc {
  async listWorkers(accountId: string, query: string): Promise<ConfiguratorUIOption[]> {
    const authority = appAuthorityFor(this);
    await authority.requireAppAccess();
    const to = new Date();
    const values = await new CloudflareObservabilityApi(
      () => tokenFor(this), accountId,
    ).withBeforeRequest(() => authority.requireAppAccess())
      .listValues("$metadata.service", "string", {
        timeframe: { from: new Date(to.valueOf() - RETENTION_MS), to },
        limit: DISCOVERY_LIMIT,
      });
    const needle = query.trim().toLowerCase();
    return values
      .filter((value): value is typeof value & { value: string } =>
        typeof value.value === "string" && (!needle || value.value.toLowerCase().includes(needle)))
      .slice(0, OPTION_LIMIT)
      .map(value => ({ value: value.value, title: value.value }));
  }
}
