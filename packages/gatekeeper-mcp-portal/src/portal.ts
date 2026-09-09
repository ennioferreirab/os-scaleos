// The MCP Server Portals gatekeeper: connects the deployment's own MCP portal as a Gadgets
// capability. A portal is one endpoint fronting many upstream MCP servers; Cloudflare's MCP Server
// Portals is the case this is written against.
//
// A sibling of the generic MCP connector rather than a mode of it: the endpoint is a deployment
// setting rather than user input, and a grant is scoped to one upstream server. Everything else is
// shared via `@gadgets/mcp-shared`. See the README.
import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  matchesResourceUrlPattern,
  stripTrailingSlashes,
  type AccountDescription,
  type AppUiAuthority,
  type AppUiContext,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVerifierContext,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
  type VerifierAppAuthority,
} from "@gadgets/workshop-shared/gatekeeper";
import { isValidToolName, type ToolIndex } from "@gadgets/mcp-shared/client";
import { MAX_TOOLS_PER_SERVER, type ServerTrust } from "@gadgets/mcp-shared/tools";
import { bindingNameFragment, hostOf } from "@gadgets/mcp-shared/util";
import type { McpLog, McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { McpAccountBase, type ConnectedServer, type ConnectOutcome }
  from "@gadgets/mcp-shared/account";
import { generateNonce } from "@gadgets/mcp-shared/connect-nonce";
import {
  withClient,
  type ConnectionAccount,
  type McpConnection,
} from "@gadgets/mcp-shared/connection";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import {
  looksLikePortal,
  parsePortalServers,
  PORTAL_LIST_SERVERS_TOOL,
  reconcilePortalServers,
  type PortalServer,
  type PortalServerListing,
} from "@gadgets/mcp-shared/portal";
import {
  endpointOfResourceUrl,
  endpointTag,
  parseToolScope,
  sameEndpoint,
  validateToolScopeAgainstCatalog,
  type ToolScope,
} from "@gadgets/mcp-shared/scope";
import {
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
} from "@gadgets/mcp-shared/html";
import { handleMcpHttpRequest } from "@gadgets/mcp-shared/http";
import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
  type McpGatekeeperUserProps,
} from "@gadgets/mcp-shared/user";
import {
  isPortalServerHidden,
  portalAuthRequiresReconnect,
  portalCatalogValidationMode,
  portalResource,
  portalServer,
  portalTokenFor,
  portalTrust,
  readPortalConfig,
  requirePortalServerVisible,
  requirePortalServerScope,
  isPortalToolGrantable,
  toolGrantOptions,
} from "./config.js";
import type { ConfiguratorUIOption } from "@gadgets/configurator-ui";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import PORTAL_LOGO_SVG from "./portal-logo.svg";
import MCP_SERVER_CONFIGURATOR_HTML from "./generated/server-configurator-ui.txt";
import type { McpServerConfiguratorRpc } from "./configurator/server-configurator-types";
import {
  parseVaultTokenInput,
  vaultTokenFormHtml,
  type VaultTokenInput,
} from "./vault-token-form.js";

const VENDOR_ID = "mcp_portal";

// How many tools one survey of the portal may cover.
//
// Entries retain names only, maximizing how much of a large portal the 96 KiB listing budget can
// cover. This count cap independently bounds work when names are short; either cut is reported as
// `truncated`.
const MAX_PORTAL_TOOL_INDEX = 1000;

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.mcp-portal", vendorId: VENDOR_ID,
});


const PORTAL_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(PORTAL_LOGO_SVG)}`;
const PORTAL_AVATAR: AvatarImage = { url: PORTAL_LOGO_URL };
const SCALEOS_AVATAR: AvatarImage = {
  url: "/assets/scaleos/brand/scaleos-icon-40.png",
};

// Cloudflare orange, matching the Cloudflare Gateway glyph used as the mark. A deployment fronting
// some other aggregator should change both together.
const PORTAL_COLOR = "#f6821f";
const SCALEOS_COLOR = "#ffffff";

function portalAvatar(config: ReturnType<typeof readPortalConfig>): AvatarImage {
  return config?.auth === "vault-token" ? SCALEOS_AVATAR : PORTAL_AVATAR;
}

function portalColor(config: ReturnType<typeof readPortalConfig>): string {
  return config?.auth === "vault-token" ? SCALEOS_COLOR : PORTAL_COLOR;
}

// ---------------------------------------------------------------------------
// Helpers

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mcp-portal");
}

async function listPortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServerListing> {
  const result = await withClient(env, account, endpoint,
    client => client.callTool(PORTAL_LIST_SERVERS_TOOL, {}));
  if (result.isError) throw new Error("The portal could not list its upstream servers.");
  return parsePortalServers(result);
}

async function tryListPortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServerListing | null> {
  try {
    return await listPortalServers(env, account, endpoint);
  } catch (err) {
    logger.warn("could not list portal servers", {
      event: "portal.servers.list.failed",
      serverHost: hostOf(endpoint),
      error: err,
    });
    return null;
  }
}

/**
 * Validates one portal-scoped resource URL, returning the scope it grants together with the upstream
 * server that scope names, when the portal reported one. Throws if the scope is not grantable.
 *
 * The fragment records how much of the portal this binding may call; see `scope.ts`. A grant that
 * names no upstream server would reach every system behind the portal, so it is refused here rather
 * than only in the form that normally builds these URLs.
 *
 * The server-list result is advisory metadata, so failing to obtain it is not fatal on its own. But
 * the endpoint still has to prove it implements the portal capability before a portal-scoped binding
 * can be minted, which is what the `findTool` probe below establishes.
 *
 * Each mode then fetches only the names validation still needs. Named grants prove each selected
 * name. A reported server needs no catalog scan; an unreported server needs one prefixed tool as
 * fallback evidence.
 */
async function validatePortalScope(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
  requested: URL,
): Promise<{ scope: ToolScope & { serverId: string }; upstream: PortalServer | undefined }> {
  const scope = parseToolScope(requested);
  requirePortalServerScope(scope);
  requirePortalServerVisible(env, scope.serverId);

  const listing = await tryListPortalServers(env, account, endpoint);
  if (listing === null) {
    const portalTool = await withClient(env, account, endpoint,
      client => client.findTool(PORTAL_LIST_SERVERS_TOOL));
    if (!portalTool) {
      throw new Error("The configured MCP endpoint does not expose the portal server-list tool.");
    }
  }

  const servers = listing?.servers ?? [];
  const requestedTools = new Set(scope.tools ?? []);
  let catalog: ToolIndex;
  switch (portalCatalogValidationMode(scope, servers)) {
    case "named-tools":
      catalog = await withClient(env, account, endpoint,
        client => client.listMatchingToolIndex(
          requestedTools.size,
          tool => requestedTools.has(tool.name),
        ));
      break;
    case "reported-server":
      catalog = { tools: [], truncated: false };
      break;
    case "server-evidence":
      catalog = await withClient(env, account, endpoint,
        client => client.listMatchingToolIndex(
          1,
          tool => isPortalToolGrantable(tool.name, scope.serverId),
        ));
      break;
  }
  return { scope, upstream: validateToolScopeAgainstCatalog(scope, catalog, servers) };
}

/**
 * The servers behind the portal, for the configurator's picker. Returns an empty list when the
 * endpoint is not a portal at all, but throws when it is one whose server list could not be read
 * completely: an incomplete picker would silently hide servers the user is entitled to grant.
 */
async function listAvailablePortalServers(
  env: Env,
  account: DurableObjectStub<McpAccount>,
  endpoint: string,
): Promise<PortalServer[]> {
  const reported = await tryListPortalServers(env, account, endpoint);
  if (reported?.complete) return reported.servers;

  const index = await withClient(env, account, endpoint,
    client => client.listToolIndex(MAX_PORTAL_TOOL_INDEX));
  if (!looksLikePortal(
    index.tools, { truncated: index.truncated, cap: MAX_PORTAL_TOOL_INDEX })) return [];
  if (index.truncated) {
    throw new Error("Could not retrieve the portal's complete server list. Try again.");
  }
  return reconcilePortalServers(reported?.servers ?? [], index.tools);
}

// The endpoint always comes from deployment configuration. OAuth/static portals continue directly;
// ScaleOS Vault adds a nonce-bound form for the user's label and bearer token.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpHttpRequest(req, {
      baseUrl: getBaseUrl(env),
      accountForId: id => ctx.exports.McpAccount.get(
        ctx.exports.McpAccount.idFromString(id)),
      log: logger,
      connect: async (request, account, initiationNonce) => {
        if (readPortalConfig(env)?.auth === "vault-token") {
          return continueVaultTokenConnect(request, account, initiationNonce, env);
        }
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return continueConnect(account, initiationNonce, env);
      },
    });
  },
};

// Hands off to the account DO, which owns every credential. The target comes from configuration, so
// this is the same call for a first connect and a reconnect.
async function continueConnect(
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  env: Env,
): Promise<Response> {
  const config = readPortalConfig(env);
  if (!config) {
    return htmlResponse(errorPageHtml(
      "No MCP server portal is configured",
      "Ask an administrator to set this deployment's MCP server portal URL."), 503);
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginConnect(initiationNonce, portalServer(config));
  } catch (err) {
    logger.warn("connect failed", { event: "connect.failed", error: err });
    return htmlResponse(errorPageHtml(
      "Could not connect", err instanceof Error ? err.message : String(err)), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") return Response.redirect(outcome.url, 302);
  return htmlResponse(SELF_CLOSING_HTML);
}

async function continueVaultTokenConnect(
  request: Request,
  account: DurableObjectStub<McpAccount>,
  initiationNonce: string,
  env: Env,
): Promise<Response> {
  const config = readPortalConfig(env);
  if (!config || config.auth !== "vault-token") {
    return htmlResponse(errorPageHtml(
      "ScaleOS Vault não configurado",
      "Peça ao administrador para revisar a configuração deste conector."), 503);
  }

  if (!(await account.isAwaitingVaultToken(initiationNonce))) {
    return htmlResponse(INVALID_LINK_HTML, 400);
  }

  const current = await account.getVaultIdentity();
  if (request.method === "GET") {
    return htmlResponse(vaultTokenFormHtml({
      actionUrl: request.url,
      portalName: config.name,
      label: current?.label,
    }));
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(vaultTokenFormHtml({
      actionUrl: request.url,
      portalName: config.name,
      label: current?.label,
      error: "Não foi possível ler o formulário. Tente novamente.",
    }), 400);
  }

  const parsed = parseVaultTokenInput(form);
  if (!parsed.ok) {
    return htmlResponse(vaultTokenFormHtml({
      actionUrl: request.url,
      portalName: config.name,
      label: parsed.label,
      error: parsed.error,
    }), 400);
  }

  let outcome: ConnectOutcome;
  try {
    outcome = await account.beginVaultTokenConnect(
      initiationNonce, parsed.value);
  } catch (err) {
    logger.warn("vault token connect failed", {
      event: "connect.vault-token.failed",
      serverHost: hostOf(config.endpoint),
      error: err,
    });
    return htmlResponse(vaultTokenFormHtml({
      actionUrl: request.url,
      portalName: config.name,
      label: parsed.value.label,
      error: "O Vault recusou o token ou não respondeu. Confira o token e tente novamente.",
    }), 502);
  }

  if (outcome.kind === "invalid") return htmlResponse(INVALID_LINK_HTML, 400);
  if (outcome.kind === "redirect") {
    return htmlResponse(errorPageHtml(
      "Resposta inesperada",
      "O ScaleOS Vault deve autenticar diretamente pelo token informado."), 502);
  }
  return htmlResponse(SELF_CLOSING_HTML);
}

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    const config = readPortalConfig(this.env);
    return {
      displayName: config?.name ?? "Cloudflare MCP Server Portals",
      url: config?.auth === "vault-token"
        ? "https://scaleos.pro/"
        : "https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/",
      logo: portalAvatar(config),
      color: portalColor(config),
      tagline: config
        ? config.auth === "vault-token"
          ? "Conecte um ou mais Vaults com um token para cada Vault"
          : `Connect a server behind ${hostOf(config.endpoint)}`
        : "No MCP server portal is configured",
      description: config?.auth === "vault-token"
        ? "Conecte cada ScaleOS Vault com seu próprio token. Você decide quais Vaults ficam " +
          "disponíveis em cada sessão, e operações de escrita continuam exigindo aprovação."
        : "Use the MCP servers this organization has approved, through its MCP server portal. " +
          "Reads happen straight away. Anything that writes waits for your approval.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const accountId = this.ctx.exports.McpAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.McpAccount.get(accountId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${accountId.toString()}/${initiationNonce}` };
  }

  /**
   * The one resource this connector offers, or none when unconfigured. Returning nothing is how the
   * connector hides itself: the Workshop drops a vendor that advertises no resources.
   */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = readPortalConfig(this.env);
    return config ? [portalResource(config)] : [];
  }

  async getTypeScriptTypes(): Promise<string> {
    // Vendor-level types are the transport-neutral base only. The per-tool `callTool` overloads are
    // generated per resource, from the chosen upstream server's own catalog; see
    // `McpGatekeeperImpl.getTypeScriptTypes()`.
    return MCP_BASE_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Account DO — owns the endpoint choice and every credential for it.

type StoredVaultCredential = {
  accountKey: string;
  credentialGeneration: number;
  label: string;
  token: string;
};

type VaultIdentity = Omit<StoredVaultCredential, "token">;

const VAULT_CREDENTIAL_KEY = "vaultCredential";
const STAGED_VAULT_CREDENTIAL_KEY = "stagedVaultCredential";

/**
 * One connected portal, for one user. Nothing outside this object ever sees a credential.
 *
 * The endpoint is a deployment setting rather than user input. Static portal credentials still
 * come from deployment configuration; Vault-token accounts keep one user credential in this DO.
 */
export class McpAccount extends McpAccountBase<Env> {
  protected baseUrl(): string {
    return getBaseUrl(this.env);
  }

  protected log(): McpLog {
    return logger;
  }

  protected mintAccount(): Fetcher<GatekeeperUser> {
    const props: McpGatekeeperUserProps = { accountObjectId: this.ctx.id.toString() };
    return this.ctx.exports.GatekeeperUserImpl({ props });
  }

  override async beginConnect(
    initiationNonce: string,
    target: ConnectedServer | null,
  ): Promise<ConnectOutcome> {
    const outcome = await super.beginConnect(initiationNonce, target);
    if (outcome.kind === "done" && readPortalConfig(this.env)?.auth !== "vault-token") {
      this.deleteVaultCredentials();
    }
    return outcome;
  }

  override async acceptAuthCode(
    code: string,
    oauthNonce: string,
    issuer?: string,
  ): Promise<boolean> {
    const accepted = await super.acceptAuthCode(code, oauthNonce, issuer);
    if (accepted && readPortalConfig(this.env)?.auth !== "vault-token") {
      this.deleteVaultCredentials();
    }
    return accepted;
  }

  /** Whether a nonce-bound Vault token form may still be submitted. */
  async isAwaitingVaultToken(initiationNonce: string): Promise<boolean> {
    return this.awaitingSelection(initiationNonce);
  }

  /** Non-secret identity for account presentation and binding isolation. */
  async getVaultIdentity(): Promise<VaultIdentity | null> {
    const credential = this.ctx.storage.kv.get<StoredVaultCredential>(VAULT_CREDENTIAL_KEY);
    if (!credential) return null;
    return {
      accountKey: credential.accountKey,
      credentialGeneration: credential.credentialGeneration,
      label: credential.label,
    };
  }

  /** Connects or rotates one user-entered ScaleOS Vault token. */
  async beginVaultTokenConnect(
    initiationNonce: string,
    input: VaultTokenInput,
  ): Promise<ConnectOutcome> {
    const config = readPortalConfig(this.env);
    if (config?.auth !== "vault-token") {
      throw new Error("This deployment is not configured for user-entered Vault tokens.");
    }
    const server = portalServer(config);

    const active = this.ctx.storage.kv.get<StoredVaultCredential>(VAULT_CREDENTIAL_KEY);
    const staged: StoredVaultCredential = {
      accountKey: active?.accountKey ?? generateNonce().slice(0, 16),
      credentialGeneration: (active?.credentialGeneration ?? 0) + 1,
      label: input.label,
      token: input.token,
    };

    return this.beginConnectWithPreissuedCredential(initiationNonce, server, {
      stage: () => {
        this.ctx.storage.kv.put(STAGED_VAULT_CREDENTIAL_KEY, staged);
      },
      commit: () => {
        this.ctx.storage.kv.put(VAULT_CREDENTIAL_KEY, staged);
        this.ctx.storage.kv.delete(STAGED_VAULT_CREDENTIAL_KEY);
      },
      discard: () => {
        this.ctx.storage.kv.delete(STAGED_VAULT_CREDENTIAL_KEY);
      },
    });
  }

  override async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.delete(STAGED_VAULT_CREDENTIAL_KEY);
    await super.prepareReconnect(initiationNonce);
  }

  override async getConnection(endpoint: string): Promise<McpConnection> {
    if (this.ctx.storage.kv.get(STAGED_VAULT_CREDENTIAL_KEY) !== undefined) {
      throw new Error("This Vault token is being updated. Try again after reconnecting.");
    }
    return super.getConnection(endpoint);
  }

  async getVaultConnection(
    endpoint: string,
    credentialGeneration: number,
  ): Promise<McpConnection> {
    this.requireVaultCredentialGeneration(credentialGeneration);
    return this.getConnection(endpoint);
  }

  async assertVaultConnectionCurrent(
    endpoint: string,
    generation: number,
    credentialGeneration: number,
  ): Promise<void> {
    this.requireVaultCredentialGeneration(credentialGeneration);
    await super.assertConnectionCurrent(endpoint, generation);
  }

  async setVaultMcpSessionId(
    endpoint: string,
    generation: number,
    credentialGeneration: number,
    previousSessionId: string | null,
    sessionId: string | null,
  ): Promise<boolean> {
    this.requireVaultCredentialGeneration(credentialGeneration);
    return super.setMcpSessionId(endpoint, generation, previousSessionId, sessionId);
  }

  async noteVaultCredentialsExpired(
    endpoint: string,
    generation: number,
    credentialGeneration: number,
  ): Promise<void> {
    this.requireVaultCredentialGeneration(credentialGeneration);
    await super.noteCredentialsExpired(endpoint, generation);
  }

  private requireVaultCredentialGeneration(expected: number): void {
    const active = this.ctx.storage.kv.get<StoredVaultCredential>(VAULT_CREDENTIAL_KEY);
    if (!active || active.credentialGeneration !== expected) {
      throw new Error("This binding belongs to an older Vault token. Replace the binding.");
    }
  }

  private deleteVaultCredentials(): void {
    this.ctx.storage.kv.delete(VAULT_CREDENTIAL_KEY);
    this.ctx.storage.kv.delete(STAGED_VAULT_CREDENTIAL_KEY);
  }

  /**
   * Scoped to the endpoint this account is connected to, never merely to what configuration says
   * today. The rule lives beside the configuration it guards, in `portalTokenFor`.
   */
  protected override staticToken(server: ConnectedServer): string | null {
    const config = readPortalConfig(this.env);
    if (config?.auth === "vault-token" && sameEndpoint(config.endpoint, server.endpoint)) {
      return this.ctx.storage.kv.get<StoredVaultCredential>(STAGED_VAULT_CREDENTIAL_KEY)?.token
        ?? this.ctx.storage.kv.get<StoredVaultCredential>(VAULT_CREDENTIAL_KEY)?.token
        ?? null;
    }
    return portalTokenFor(this.env, server.endpoint);
  }
}

// ---------------------------------------------------------------------------
// Account-facing interface

@validateRpc()
export class GatekeeperUserImpl
  extends McpGatekeeperUserBase<Env>
  implements GatekeeperUser {

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected [mcpGatekeeperUserContext]() {
    return {
      account: this.#account(),
      avatar: portalAvatar(readPortalConfig(this.env)),
      baseUrl: getBaseUrl(this.env),
    };
  }

  override async describe(): Promise<AccountDescription> {
    const config = readPortalConfig(this.env);
    if (config?.auth !== "vault-token") return super.describe();
    const identity = await this.#account().getVaultIdentity();
    if (!identity) {
      throw new Error("This ScaleOS Vault account needs to reconnect with its own token.");
    }
    return {
      displayName: identity.label,
      avatar: SCALEOS_AVATAR,
    };
  }

  /**
   * The portal as currently configured, not as it was when this account connected. Repointing the
   * deployment therefore surfaces as a reconnect, via `getGatekeeperClassFor` refusing the old
   * endpoint, rather than as a Gadget quietly talking to a portal nobody chose.
   */
  async getSupportedResources(): Promise<SupportedResource[]> {
    const config = readPortalConfig(this.env);
    return config ? [portalResource(config)] : [];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    const config = readPortalConfig(this.env);
    if (!config) {
      throw new Error("This deployment has no MCP server portal configured.");
    }
    const server = await this.#account().getServer();
    const resource = portalResource(config);
    const vaultIdentity = await this.#account().getVaultIdentity();

    // The account connected to one portal and the deployment now names one; a repoint between the
    // two must surface as a reconnect. Otherwise this facet would be minted against the endpoint
    // frozen on the account while the deployment believes it configured a different one.
    if (!sameEndpoint(server.endpoint, config.endpoint)) {
      throw new Error(
        `This connection is for ${hostOf(server.endpoint)}, but this deployment's portal is now ` +
        `${hostOf(config.endpoint)}. Reconnect the account.`);
    }
    if (portalAuthRequiresReconnect(server.auth, config.auth)) {
      throw new Error("This deployment's portal authentication changed. Reconnect the account.");
    }
    if ((config.auth === "vault-token") !== (vaultIdentity !== null)) {
      throw new Error("This portal authentication changed. Reconnect the account.");
    }

    // The account holds credentials for one portal, so a resource URL naming any other endpoint is
    // not this account's to grant. Compared in full rather than by origin: one host can front `/mcp`
    // and `/mcp-v2` as unrelated endpoints, and the facet always calls the endpoint recorded on the
    // account, so an origin-only test would honour a grant against a URL nobody connected to.
    const requested = new URL(url, server.endpoint);
    if (!sameEndpoint(requested.toString(), config.endpoint)) {
      throw new Error(
        `This connection is for ${config.endpoint}, not ` +
        `${endpointOfResourceUrl(requested)}.`);
    }
    if (!matchesResourceUrlPattern(resource.urlPattern, requested.toString())) {
      throw new Error(`"${url}" does not match this connection's resource type.`);
    }

    const account = this.#account();
    const { scope, upstream } = await validatePortalScope(
      this.env, account, server.endpoint, requested);

    const props: McpGatekeeperImplProps = {
      accountObjectId: this.ctx.props.accountObjectId,
      endpoint: server.endpoint,
      serverId: server.serverId,
      serverName: config.name,
      scopeServerName: upstream?.name ?? scope.serverId,
      scope,
      vaultIdentity: vaultIdentity ?? undefined,
    };
    return { class: this.ctx.exports.McpGatekeeperImpl({ props }), resource };
  }

  async startResourceConfigurator(
    _resourceUrlPattern: string,
    context: AppUiContext,
  ): Promise<ResourceConfiguratorFrame> {
    return {
      iframeHtml: MCP_SERVER_CONFIGURATOR_HTML,
      ui: new RpcStub(new McpServerConfiguratorUI(
        this.env, this.#account(), context.authority)),
    };
  }

  @skipRpcValidation()
  async getVerifier(
    context: GatekeeperVerifierContext,
  ): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.McpPortalVerifier({
      props: { authority: context.authority },
    });
  }
}

type McpCredentialAccountProps = {
  accountObjectId: string;
  credentialGeneration: number;
};

/**
 * Narrows the ordinary MCP connection API to the exact Vault credential generation captured by a
 * binding. A token replacement therefore invalidates old bindings instead of retargeting them.
 */
@validateRpc()
export class McpCredentialAccount
  extends WorkerEntrypoint<Env, McpCredentialAccountProps>
  implements ConnectionAccount {

  #account(): DurableObjectStub<McpAccount> {
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  async getConnection(endpoint: string): Promise<McpConnection> {
    return this.#account().getVaultConnection(
      endpoint, this.ctx.props.credentialGeneration);
  }

  async assertConnectionCurrent(endpoint: string, generation: number): Promise<void> {
    await this.#account().assertVaultConnectionCurrent(
      endpoint, generation, this.ctx.props.credentialGeneration);
  }

  async setMcpSessionId(
    endpoint: string,
    generation: number,
    previousSessionId: string | null,
    sessionId: string | null,
  ): Promise<boolean> {
    return this.#account().setVaultMcpSessionId(
      endpoint, generation,
      this.ctx.props.credentialGeneration,
      previousSessionId,
      sessionId,
    );
  }

  async noteCredentialsExpired(endpoint: string, generation: number): Promise<void> {
    await this.#account().noteVaultCredentialsExpired(
      endpoint, generation, this.ctx.props.credentialGeneration);
  }
}

// ---------------------------------------------------------------------------
// Verifier

type McpPortalVerifierProps = {
  authority: Fetcher<VerifierAppAuthority>;
};

@validateRpc()
export class McpPortalVerifier
  extends WorkerEntrypoint<Env, McpPortalVerifierProps>
  implements GatekeeperUserVerifier
{
  async verify(): Promise<void> {
    await this.ctx.props.authority.requireAppAccess();
  }
}

// ---------------------------------------------------------------------------
// Resource configurator

@validateRpc()
class McpServerConfiguratorUI extends RpcTarget implements McpServerConfiguratorRpc {
  #env: Env;
  #account: DurableObjectStub<McpAccount>;
  #authority: RpcStub<AppUiAuthority>;
  #serverPromise: Promise<ConnectedServer> | undefined;
  #portalServersPromise: Promise<PortalServer[]> | undefined;

  constructor(
    env: Env,
    account: DurableObjectStub<McpAccount>,
    authority: RpcStub<AppUiAuthority>,
  ) {
    super();
    this.#env = env;
    this.#account = account;
    this.#authority = authority.dup();
  }

  async getEndpoint(): Promise<string> {
    await this.#authority.requireAppAccess();
    return (await this.#server()).endpoint;
  }

  #server(): Promise<ConnectedServer> {
    return this.#serverPromise ??= this.#account.getServer();
  }

  #portalServers(): Promise<PortalServer[]> {
    return this.#portalServersPromise ??= (async () => {
      const server = await this.#server();
      return listAvailablePortalServers(this.#env, this.#account, server.endpoint);
    })();
  }

  // Ask the portal for its server index without first loading every upstream tool. Empty for an
  // endpoint that does not implement the portal contract or currently fronts nothing; either case
  // leaves the form unsubmittable.
  async listServerOptions(): Promise<ConfiguratorUIOption[]> {
    await this.#authority.requireAppAccess();
    return (await this.#portalServers())
      .filter(upstream => !isPortalServerHidden(this.#env, upstream.id))
      .map(upstream => ({
        value: upstream.id,
        title: upstream.name,
        // A server can be configured but switched off for this session, making a grant onto it valid
        // but presently empty, which the person choosing should see.
        meta: upstream.enabled ? undefined : "disabled in portal",
      }));
  }

  // Tools the grant may cover within one portal upstream server. The survey is checked before the
  // detailed catalog is fetched, and `toolGrantOptions` decides what each source says.
  async listToolOptions(serverId: string): Promise<ConfiguratorUIOption[]> {
    await this.#authority.requireAppAccess();
    if (!isValidToolName(serverId) || isPortalServerHidden(this.#env, serverId)) return [];
    if (!(await this.#portalServers()).some(server => server.id === serverId)) return [];
    const server = await this.#server();
    const tools = await withClient(this.#env, this.#account, server.endpoint,
      client => client.listMatchingToolSummaries(
        MAX_TOOLS_PER_SERVER,
        tool => isPortalToolGrantable(tool.name, serverId),
      ));
    return toolGrantOptions({
      serverId,
      tools,
      trust: portalTrust(this.#env),
    });
  }

  [Symbol.dispose](): void {
    this.#authority[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper facet

// Props identifying which server (and how much of it) a gatekeeper facet governs. The trust tier is
// absent: it is deployment configuration, read from `portalTrust(this.env)` at each point of use,
// since baking it into props would pin every binding to the setting on the day it was created.
type McpGatekeeperImplProps = {
  accountObjectId: string;
  endpoint: string;
  serverId: string;
  serverName: string;
  // Optional for facets minted before catalog-backed validation persisted the upstream display name.
  scopeServerName?: string;
  // How much of one upstream server this binding may call.
  scope: ToolScope & { serverId: string };
  // Present only for per-Vault user tokens. Every field is non-secret presentation or version data.
  vaultIdentity?: VaultIdentity;
};

export class McpGatekeeperImpl
  extends McpFacetBase<Env, McpGatekeeperImplProps, McpSessionImpl> {

  protected get log() {
    return logger.with({
      serverId: this.ctx.props.serverId,
      serverHost: hostOf(this.ctx.props.endpoint),
      trust: portalTrust(this.env),
    });
  }

  protected account(): ConnectionAccount {
    if (this.ctx.props.vaultIdentity) {
      return this.ctx.exports.McpCredentialAccount({
        props: {
          accountObjectId: this.ctx.props.accountObjectId,
          credentialGeneration: this.ctx.props.vaultIdentity.credentialGeneration,
        },
      });
    }
    return this.ctx.exports.McpAccount.get(
      this.ctx.exports.McpAccount.idFromString(this.ctx.props.accountObjectId));
  }

  protected get trust(): ServerTrust {
    return portalTrust(this.env);
  }

  protected get sessionClass() {
    return McpSessionImpl;
  }

  protected get observerName(): string {
    return this.#scopeLabel();
  }

  // How this binding's breadth reads to a human, for approval prompts and the bindings list.
  #scopeLabel(): string {
    const { scope, serverName, scopeServerName, vaultIdentity } = this.ctx.props;
    if (vaultIdentity) return `${serverName} / ${vaultIdentity.label}`;
    return `${serverName} / ${scopeServerName ?? scope.serverId}`;
  }

  async describe(): Promise<ResourceDescription> {
    const tools = await this.tools();
    const reads = tools.filter(entry => entry.mode === "read").length;
    const { scope } = this.ctx.props;
    const label = this.#scopeLabel();

    const counts = `${reads} read-only, ${tools.length - reads} requiring approval`;
    const plural = tools.length === 1 ? "" : "s";
    const snippet = scope.tools
      ? `${scope.tools.length} named MCP tool${scope.tools.length === 1 ? "" : "s"} on ` +
        `${label} \u2014 ${counts}. Other tools are refused.`
      : `All tools of the ${this.ctx.props.scopeServerName ?? scope.serverId} server on ` +
        `${this.ctx.props.serverName}; ${tools.length} tool definition${plural} shown here ` +
        `(${counts}). Use listTools({ search }) for others. Other servers are refused.`;

    return {
      url: this.resourceUrl,
      title: scope.tools?.length === 1 ? `${label}: ${scope.tools[0]}` : label,
      snippet,
      suggestedBindingName: `MCP_${bindingNameFragment(this.#bindingId())}`,
      tsType: sessionTypeName(this.#bindingId(), this.resourceUrl),
    };
  }

  // Identifies this binding's shape for naming. Server-scoped bindings get their own suggested name
  // and session type, so two bindings onto different servers of one portal do not collide and the
  // agent's type for the GitHub half of a portal is named after GitHub.
  //
  // This is a readable label, not an identity: two grants pinning different tools of one upstream
  // server produce the same id. `sessionTypeName` is what separates them, from the scoped resource
  // URL.
  #bindingId(): string {
    const { scope, serverId, vaultIdentity } = this.ctx.props;
    if (vaultIdentity) return `vault-${vaultIdentity.accountKey}`;
    return `${serverId}-${scope.serverId}`;
  }

  /**
   * Namespaces persistent approval policy by both the readable binding shape and the exact portal
   * endpoint. A deployment repoint must not carry an always-approve decision to a different system
   * merely because both portals expose a tool with the same name.
   */
  protected get actionScopeTag(): string {
    const generation = this.ctx.props.vaultIdentity?.credentialGeneration;
    const credential = generation === undefined ? "" : `:${generation}`;
    return `mcp-portal:${endpointTag(this.ctx.props.endpoint)}:${this.#bindingId()}${credential}`;
  }

  async getTypeScriptTypes(): Promise<string> {
    return generateSessionTypes({
      baseTypes: MCP_BASE_TYPES,
      serverId: this.#bindingId(),
      serverName: this.#scopeLabel(),
      endpoint: this.ctx.props.endpoint,
      discriminator: this.resourceUrl,
      trust: portalTrust(this.env),
      tools: await this.tools(),
    });
  }

  /**
   * The upstream server as the user should see it, not the portal's own name. The same label
   * `describe()` shows, so an approval prompt names the system being written to.
   */
  get serverName(): string {
    return this.#scopeLabel();
  }
}

// ---------------------------------------------------------------------------
// Session — the capability handed to the Gadget

// Subclassed rather than used directly so `@validateRpc()` is applied in the file that hands the
// class to a Gadget, where it can be seen.
@validateRpc()
class McpSessionImpl extends McpSessionBase {}
