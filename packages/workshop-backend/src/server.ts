import {
  RpcSession,
  RpcStub,
  RpcTarget,
  WebSocketTransport,
  newHttpBatchRpcResponse,
  type RpcSessionOptions,
  type RpcTransport,
} from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { JWTPayload } from "jose";
import { PublicApi, AuthenticatedApi, Overseer, GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, AiGatewayInfo, AiModelProvider, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, ObserverConfigCallback, BlueprintLibrarySummary, BlueprintPublicInfo, BlueprintUserSummary, BlueprintBindingAssignment, AgentSpawnerConfig, WorkpieceId, BLUEPRINT_SCREENSHOT_PATH_PREFIX, BLUEPRINT_SCREENSHOT_R2_PREFIX, blueprintScreenshotUrl, ServerConfig, CloudflareUsageInfo, CloudflareAccountOption, LoginAttempt, GatekeeperAppInfo, AdminApi, GatekeeperVendorInfo, OutputFormatOffer, ListOutputsResult, DirectoryAudienceTargets, createOpenGadgetError, getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, AUTH_ERROR_CODES, createAuthError } from '@gadgets/workshop-shared/api';
import type { UiFeatureFlags } from "@gadgets/workshop-shared/feature-flags";
import { getServerConfig } from "./deployment-config.js";
import { isPasswordAuthEnabled, getAuthGatekeeperAllowlist } from "./auth/config.js";
import { getAuthVendorBinding } from "./auth/auth-vendors.js";
import { HumanSessionGuard } from "./auth/human-session.js";
import {
  hasSupabaseAuthSettings,
  requireSubject,
  verifyHumanAccessToken,
} from "./auth/supabase.js";
import { getUsageInfo } from "./ai-gateway-billing/limits/usage-checker.js";
import { listConnectedAccounts, selectAccount } from "./ai-gateway-billing/cloudflare/connection-service.js";
import { PendingLogin, LoginConnectCallbackImpl } from "./auth/login-flow.js";
import { deploymentOutputForBlueprint, listFormatOffers, readAdminConfig } from "./admin-config.js";

// Re-export the optional-feature Durable Objects + entrypoints so they can be bound in wrangler.
export { PendingLogin, LoginConnectCallbackImpl };
import type { ContextAuthority, GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import { LanguageModelGatekeeper } from "./ai-models";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { AdminSettings, AdminApiImpl } from "./admin-settings.js";
import { OrganizationDirectoryDurableObject } from "./organization-directory.js";
import { BlueprintKvRecord, buildBlueprintArchiveStream, sanitizeBlueprintOutput, listFeaturedBlueprintsFromKv, parseBlueprintArchive, randomBlueprintId, readBlueprintContent, readBlueprintKvRecord } from "./blueprint-archive.js";
import { GatekeeperConnectCallbackImpl, GatekeeperVerifierAuthority, normalizeUsername, UserDurableObject, CLOUDFLARE_VENDOR_ID } from "./user";
import { DurableContextAuthority, ContextAuthorityImpl } from "./context-authority.js";
import { OverseerDurableObject, GatekeeperLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper, GatekeeperHookLoopback, GadgetTailLoopback, AgentSelfLoopback, TransientStubLoopback } from "./overseer";
import { ExternalMessageGateway } from "./external-message-gateway";
import { RpcStub as NativeRpcStub, type RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { recordAnalytics } from "./analytics";
import { handleClientErrorRequest } from "./client-errors.js";
import { verifyCfAccessJwt } from "./access.js";
import { resolveUiFeatureFlags } from "./feature-flags";
import { serveSiteLogo, SITE_LOGO_PATH } from "./site-logo.js";
import { createWorkshopLogger } from "./observability";
import { retryOnDoReset, wrapDoStubForTelemetry } from "./do-retry";

const logger = createWorkshopLogger("workshop.server");

// Set once we've asked the AdminSettings DO to install the bundled format blueprints (see the
// fetch handler), so later requests skip the call. The DO holds the real answer.
let formatBlueprintInstallStarted = false;

function publicBlueprintInfo(id: string, metadata: BlueprintPublicInfo['metadata']): BlueprintPublicInfo {
  return {
    id,
    metadata,
    screenshotUrl: blueprintScreenshotUrl(id, metadata),
  };
}

// Re-export entrypoint types from ai-models.ts.
export { LanguageModelGatekeeper };

// Re-export entrypoint types from admin-settings.ts.
export { AdminSettings };

// Re-export the deployment organization directory and audit entrypoint.
export { OrganizationDirectoryDurableObject };

// Re-export entrypoint types from user.ts.
export { UserDurableObject, GatekeeperConnectCallbackImpl, GatekeeperVerifierAuthority };
export { DurableContextAuthority };

// Re-export entrypoint types from overseer.ts.
export { OverseerDurableObject, GatekeeperLoopback, GatekeeperHookLoopback,
    CodeModeTailLoopback, AgentSpawnerGatekeeper, GadgetTailLoopback,
    AgentSelfLoopback, TransientStubLoopback };

// Re-export service-binding entrypoint for external channel integrations.
export { ExternalMessageGateway };

// Declare optional environment variables here since they may be omitted from wrangler.jsonc.
type Env = Cloudflare.Env & {
  // Set these if using Cloudflare Access for authentication, otherwise username/password is used.
  CF_ACCESS_AUD?: string,  // audience
  CF_ACCESS_ISS?: string,  // team URL, i.e. https://<team>.cloudflareaccess.com
  DEV?: boolean;
  FLAGS?: Flagship;
}

const DIRECTORY_USER_PATH = "/api/internal/directory/users";

async function serviceTokensEqual(provided: string, expected: string): Promise<boolean> {
  let encoder = new TextEncoder();
  let [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  let left = new Uint8Array(providedHash);
  let right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function handleDirectoryUserRequest(
    request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", {status: 405});
  let expectedToken = env.DIRECTORY_SERVICE_TOKEN;
  if (!expectedToken) {
    return Response.json({error: "Directory service is unavailable."}, {status: 503});
  }
  let authorization = request.headers.get("Authorization") ?? "";
  let providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!providedToken || !(await serviceTokensEqual(providedToken, expectedToken))) {
    return Response.json({error: "Unauthorized"}, {status: 401});
  }
  let userId: string;
  try {
    userId = requireSubject(new URL(request.url).searchParams.get("userId") ?? "");
  } catch {
    return Response.json({error: "Invalid userId."}, {status: 400});
  }
  try {
    const user = await ctx.exports.OrganizationDirectoryDurableObject.getByName("")
        .getDirectoryUser(userId);
    if (!user) return Response.json({error: "Not found."}, {status: 404});
    return Response.json({
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      role: user.role,
    });
  } catch {
    return Response.json({error: "Directory service is unavailable."}, {status: 503});
  }
}

// =======================================================================================


@validateRpc()
class AuthenticatedApiImpl extends RpcTarget implements AuthenticatedApi {
  constructor(private ctx: ExecutionContext, private env: Env,
      userId: DurableObjectId,
      private abortSession: (reason: Error) => void,
      private guard: HumanSessionGuard,
      private centralAuthMode: boolean) {
    super();

    this.#userId = userId;
    this.overseers = this.ctx.exports.OverseerDurableObject;
    this.adminSettings = this.ctx.exports.AdminSettings;
    this.users = this.ctx.exports.UserDurableObject;
    this.organizationDirectory = this.ctx.exports.OrganizationDirectoryDurableObject;
  }

  private overseers: DurableObjectNamespace<OverseerDurableObject>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;
  private users: DurableObjectNamespace<UserDurableObject>;
  private organizationDirectory: DurableObjectNamespace<OrganizationDirectoryDurableObject>;

  #userId: DurableObjectId;

  // Get a stub pointing at the user DO. We create a new stub for every request so that we don't
  // have to worry about detecting when a stub has become broken.
  get #user(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(this.users.get(this.#userId));
  }

  async #requireActive(): Promise<void> {
    this.guard.assertValid();
    if (!this.centralAuthMode) return;
    await this.organizationDirectory.getByName("").requireActiveUser(this.guard.subject);
  }

  async #isAdmin(): Promise<boolean> {
    if (!this.centralAuthMode) {
      let admins = this.env.ADMINS;
      if (typeof admins === "string") admins = JSON.parse(admins);
      return Array.isArray(admins) && !!this.#userId.name && admins.includes(this.#userId.name);
    }
    try {
      this.guard.assertValid();
      await this.organizationDirectory.getByName("").requireAdminUser(this.guard.subject);
      return true;
    } catch {
      return false;
    }
  }

  /** Mint the single subject-bound authority shared by bound vendor/app UI capabilities. */
  #contextAuthority(
      vendorId: string | undefined,
      assertAdditionalAccess: () => Promise<void>): NativeRpcStub<NativeRpcTarget & ContextAuthority> {
    return new NativeRpcStub(new ContextAuthorityImpl({
      subject: this.guard.subject,
      vendorId,
      directory: this.organizationDirectory.getByName(""),
      centralAuthMode: this.centralAuthMode,
      sessionGuard: this.guard,
      assertAdditionalAccess,
    }));
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    await this.#requireActive();
    // Pure-read delegations retry once across a user-DO reset (see retryOnDoReset); writes never do.
    return retryOnDoReset(() => this.#user.whoami());
  }
  async setOwnDisplayName(name: string): Promise<void> {
    await this.#requireActive();
    await this.#user.setOwnDisplayName(name);
    if (this.centralAuthMode) {
      await this.organizationDirectory.getByName("").setOwnDisplayName(this.guard.subject, name);
    }
  }
  async listModels(): Promise<AiChatAuthorInfo[]> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.listModels());
  }
  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    await this.#requireActive();
    return this.#user.addModel(profile, config);
  }
  async deleteModel(id: string): Promise<void> {
    await this.#requireActive();
    return this.#user.deleteModel(id);
  }
  async setQuickModel(id: string | null): Promise<void> {
    await this.#requireActive();
    return this.#user.setQuickModel(id);
  }
  async getQuickModel(): Promise<null | string> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.getQuickModel());
  }

  async getPreferredModel(): Promise<string | null> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.getPreferredModel());
  }
  async setPreferredModel(id: string | null): Promise<void> {
    await this.#requireActive();
    return this.#user.setPreferredModel(id);
  }
  async isOnboardingCompleted(): Promise<boolean> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.isOnboardingCompleted());
  }
  async completeOnboarding(): Promise<void> {
    await this.#requireActive();
    return this.#user.completeOnboarding();
  }

  async getCloudflareUsage(): Promise<CloudflareUsageInfo> {
    await this.#requireActive();
    return getUsageInfo(this.env, this.#user);
  }

  async listCloudflareAccounts(): Promise<CloudflareAccountOption[]> {
    await this.#requireActive();
    return listConnectedAccounts(this.env, this.#user);
  }

  async selectCloudflareAccount(accountId: string): Promise<void> {
    await this.#requireActive();
    return selectAccount(this.env, this.#user, accountId);
  }

  async setAvatar(data: Uint8Array | null): Promise<void> {
    await this.#requireActive();
    if (data) {
      if (data.byteLength > 100 * 1024) {
        throw new Error("Avatar too large (max 100 KB)");
      }
      // Verify the data starts with a known image magic-byte header.
      let isJpeg = data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;
      let isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47;
      if (!isJpeg && !isPng) {
        throw new Error("Avatar must be a JPEG or PNG image");
      }
    }
    // Avatar data lives in KV (global), not the user's DO storage, so we
    // read/write it directly here to avoid routing through the DO location.
    let userId = this.#userId.name!;
    if (data) {
      await this.env.AVATARS.put(userId, data);
    } else {
      await this.env.AVATARS.delete(userId);
    }
  }
  async getAvatar(userId: string): Promise<Uint8Array | null> {
    await this.#requireActive();
    let result = await this.env.AVATARS.get(userId, "arrayBuffer");
    if (!result) return null;
    return new Uint8Array(result);
  }

  async getAiConfig(): Promise<AiGatewayInfo> {
    await this.#requireActive();
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      return {
        enabled: true,
        enabledProviders: [...gwConfig.providers] as AiModelProvider[],
      };
    } else {
      return { enabled: false };
    }
  }

  async getUiFeatureFlags(): Promise<UiFeatureFlags> {
    await this.#requireActive();
    return resolveUiFeatureFlags(this.env, this.guard.subject);
  }

  async #openGadgetInternal(id: string, shareKey?: string,
                            configureObservers?: RpcStub<ObserverConfigCallback>)
      : Promise<NativeRpcStub<Overseer>> {
    await this.#requireActive();
    let userId = this.#userId.toString();
    let profileId = this.guard.subject;
    let overseerId;
    try {
      overseerId = this.overseers.idFromString(id);
    } catch {
      throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
    }
    let overseer = this.overseers.get(overseerId);

    // HACK: Detect loss of the connection to the DO by:
    // - Pass a callback to overseer.open() which it should call when the session is disposed.
    // - Detect if the callback itself is disposed before being called, suggesting the connection
    //   was lost.
    // If the connection is lost, we abort this I/O context, which kills the WebSocket from the
    // client, forcing it to engage its reconnect logic, which should recover.
    // TODO: Implement onRpcBroken() in the built-in RPC system, matching Cap'n Web, and use that
    //   instead.
    // TODO: Consider how to reconnect to one DO without resetting the whole WebSocket. Probably
    //   needs new code on the client side. However, typically a client only ever opens one
    //   gadget at a time (since each tab is a separate client), so it's probably fine for now.
    let closed = false;
    let started = false;
    let notifyClosed = () => {
      closed = true;
    };
    (notifyClosed as any)[Symbol.dispose] = () => {
      if (started && !closed) {
        // this.ctx.abort() would be nicer here, but it is still marked experimental in the
        // workers runtime.
        this.abortSession(new Error(`lost connection to workspace DO (gadget ${id})`));
      }
    }

    let result;
    try {
      result = await overseer.open(
          userId, profileId, notifyClosed, this.guard.expiresAtMs, shareKey, configureObservers);
    } catch (err) {
      // A denial proves this user's listing for the workspace is stale: revocation tries to drop it
      // (refreshAffectedCollaboratorListings), but that push is best-effort. Only catches entries
      // they click; others stay frozen at revocation, as a disconnected collaborator gets no pushes.
      if (getOpenGadgetErrorCode(err) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied) {
        await this.#user.forgetSharedGadget(id);
      }
      throw err;
    }
    started = true;
    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_opened",
      user_id: userId,
      gadget_id: id,
      source: shareKey ? "share_key" : "direct",
    });
    return result;
  }

  async openGadget(id: string, shareKey?: string,
                   configureObservers?: RpcStub<ObserverConfigCallback>)
      : Promise<RpcStub<Overseer>> {
    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return this.#openGadgetInternal(id, shareKey, configureObservers);
  }

  async newGadget(): Promise<RpcStub<Overseer>> {
    await this.#requireActive();
    let id = this.overseers.newUniqueId().toString();
    await this.#user.newGadget(id, "Untitled Workspace");
    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_created",
      user_id: this.#userId.toString(),
      gadget_id: id,
      source: "blank",
    });
    let result = await this.openGadget(id);
    if (!result) {
      throw new Error("Open failed despite newly-created workspace?");
    }
    return result;
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.listGadgets());
  }

  async listOutputs(): Promise<ListOutputsResult> {
    await this.#requireActive();
    return this.#user.listOutputs();
  }

  async listOutputFormats(): Promise<OutputFormatOffer[]> {
    await this.#requireActive();
    let offers = await listFormatOffers(this.env, await readAdminConfig(this.env));
    // Neither the agent's hint nor the binding details are part of what a user is offered here.
    return offers.map(({agentHint: _agentHint, bindings: _bindings, ...offer}) => offer);
  }

  async listGatekeeperVendors(filter?: GatekeeperVendorFilter): Promise<GatekeeperVendorInfo[]> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.listGatekeeperVendors(filter));
  }

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<{url: string}> {
    await this.#requireActive();
    return this.#user.connectAccount(vendorId, resourceUrlPatterns);
  }

  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[]): Promise<{url?: string}> {
    await this.#requireActive();
    return this.#user.ensureAccountResources(accountId, resourceUrlPatterns);
  }

  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.listAddableGatekeepers());
  }

  async provisionAmbientAccount(vendorId: string): Promise<void> {
    await this.#requireActive();
    return this.#user.provisionAmbientAccount(vendorId);
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    await this.#requireActive();
    return this.#user.subscribeConnectedAccounts(subscriber, filter);
  }

  async disconnectAccount(accountId: number): Promise<void> {
    await this.#requireActive();
    return this.#user.disconnectAccount(accountId);
  }

  async reconnectAccount(accountId: number): Promise<{url: string}> {
    await this.#requireActive();
    return this.#user.reconnectAccount(accountId);
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string) {
    await this.#requireActive();
    return this.#user.startResourceConfigurator(accountId, resourceUrlPattern, {
      authority: this.#contextAuthority(
          undefined, () => this.#user.requireOptionalConnectedAccountAccess(accountId)),
    });
  }

  async dismissSharedGadget(gadgetId: string): Promise<void> {
    await this.#requireActive();
    return this.#user.forgetSharedGadget(gadgetId);
  }

  async listOwnBlueprints(): Promise<BlueprintUserSummary[]> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.listBlueprints());
  }

  async getOwnBlueprint(blueprintId: string): Promise<BlueprintUserSummary | null> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.getBlueprint(blueprintId));
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.listLibraryBlueprints());
  }

  async setBlueprintPinned(blueprintId: string, pinned: boolean): Promise<void> {
    await this.#requireActive();
    return this.#user.setBlueprintPinned(blueprintId, pinned);
  }

  async isBlueprintPinned(blueprintId: string): Promise<boolean> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.isBlueprintPinned(blueprintId));
  }

  async listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]> {
    await this.#requireActive();
    return (await listFeaturedBlueprintsFromKv(this.env)).map(
        blueprint => publicBlueprintInfo(blueprint.id, blueprint.metadata));
  }

  async addBlueprintToLibrary(blueprintId: string): Promise<void> {
    await this.#requireActive();
    return this.#user.addBlueprintToLibrary(blueprintId);
  }

  async removeBlueprintFromLibrary(blueprintId: string): Promise<void> {
    await this.#requireActive();
    return this.#user.removeBlueprintFromLibrary(blueprintId);
  }

  async isBlueprintInLibrary(blueprintId: string): Promise<{ uploaded: boolean } | null> {
    await this.#requireActive();
    return retryOnDoReset(() => this.#user.isBlueprintInLibrary(blueprintId));
  }

  async importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string> {
    await this.#requireActive();
    let { metadata, contentLength, content } = await parseBlueprintArchive(archive);
    delete metadata.screenshot;
    let blueprintId = randomBlueprintId();
    let r2Key = `${blueprintId}/${metadata.version}`;

    try {
      let fixedLengthStream = new FixedLengthStream(contentLength);

      await Promise.all([
        content.pipeTo(fixedLengthStream.writable),
        this.env.BLUEPRINT_CONTENT.put(r2Key, fixedLengthStream.readable),
      ]);

      let kvRecord: BlueprintKvRecord = {
        metadata,
        ownerId: this.#userId.toString(),
      };

      await this.env.BLUEPRINTS.put(blueprintId, JSON.stringify(kvRecord));

      await this.#user.importBlueprint(blueprintId, metadata);

      recordAnalytics(this.ctx, this.env, {
        event_name: "blueprint_imported",
        user_id: this.#userId.toString(),
        blueprint_id: blueprintId,
      });

      return blueprintId;
    } catch (err) {
      // Try to delete what we uploaded, but don't wait for results becasue there's nothing we
      // can do if they fail, and we already have an error to throw.
      this.env.BLUEPRINTS.delete(blueprintId);
      this.env.BLUEPRINT_CONTENT.delete(r2Key);
      throw err;
    }
  }

  async newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>
  ): Promise<RpcStub<Overseer>> {
    await this.#requireActive();
    // 1. Read blueprint from KV.
    let kvRecord = await readBlueprintKvRecord(this.env, blueprintId);
    if (!kvRecord) throw new Error("Blueprint not found.");

    // 2. Read gzip-compressed Yjs doc from R2 and decompress.
    let codeBytes = await readBlueprintContent(this.env, blueprintId, kvRecord.metadata.version);
    if (!codeBytes) throw new Error("Blueprint content not found in R2.");

    // 3. Create new Overseer DO (same as newGadget()).
    let id = this.overseers.newUniqueId().toString();
    await this.#user.newGadget(id, kvRecord.metadata.title);
    let overseerResult = await this.#openGadgetInternal(id);

    // 4. Initialize from blueprint code.
    let overseerDo = this.overseers.get(this.overseers.idFromString(id));
    await overseerDo.initializeFromBlueprint(codeBytes, kvRecord.metadata.title,
        deploymentOutputForBlueprint(await readAdminConfig(this.env), blueprintId,
            sanitizeBlueprintOutput(kvRecord.metadata.output)));

    // 5. Create gatekeepers from assignments and bind them into the workspace's (only) gadget.
    let metadata = await overseerResult.getMetadata();
    using gadget = await overseerResult.getGadget(metadata.defaultGadgetId!);

    // Defensively put blueprint bindings into a map (not a raw object) until we've had a chance to
    // validate the names.
    let blueprintBindings = new Map(Object.entries(kvRecord.metadata.bindings));
    let gadgetId = metadata.defaultGadgetId!;

    // Create gatekeepers in two phases: first every non-spawner binding (binding the
    // non-spawnerOnly ones into the gadget, and recording each created gatekeeper's id by
    // binding name), then the agent spawners, whose configs reference the phase-one results
    // symbolically (see SpawnerEnvTarget).
    let createdIds = new Map<string, WorkpieceId>();
    let gkPromises: Promise<void>[] = [];

    for (let [bindingName, assignment] of Object.entries(bindings)) {
      let blueprintBinding = blueprintBindings.get(bindingName);
      if (!blueprintBinding) {
        throw new Error(`Unknown binding name: ${bindingName}`);
      }

      gkPromises.push((async () => {
        let gk;
        if (assignment.type === "gatekeeper") {
          gk = await overseerResult.newGatekeeper(assignment.accountId, assignment.resourceUrl);
          if (!gk) {
            throw new Error(`Failed to create gatekeeper for binding "${bindingName}".`);
          }
        } else if (assignment.type === "aiModel") {
          gk = await overseerResult.newAiModelGatekeeper(assignment.modelId);
        } else {
          return;  // agent spawners are created in phase two
        }
        try {
          let id = await gk.getId();
          createdIds.set(bindingName, id);
          // A spawnerOnly binding exists purely to feed some spawner's env; it is not bound
          // into the gadget itself.
          if (!blueprintBinding.spawnerOnly) {
            await gadget.bind(bindingName, id);
          }
        } finally {
          gk[Symbol.dispose]();
        }
      })());
    }

    await Promise.all(gkPromises);

    // Phase two: agent spawners, with the full AgentSpawnerConfig reconstructed -- displayName
    // from the binding's title, modelId from the assignment, and env resolved against the
    // phase-one gatekeepers and the new gadget.
    for (let [bindingName, assignment] of Object.entries(bindings)) {
      if (assignment.type !== "agentSpawner") continue;
      let blueprintBinding = blueprintBindings.get(bindingName);
      if (blueprintBinding?.type !== "agentSpawner") {
        throw new Error(`Binding "${bindingName}" type mismatch.`);
      }

      let env: Record<string, WorkpieceId> = {};
      for (let [envName, target] of Object.entries(blueprintBinding.env)) {
        if (target.type === "gadget") {
          env[envName] = gadgetId;
        } else {
          let id = createdIds.get(target.name);
          if (id === undefined) {
            throw new Error(`Agent spawner binding "${bindingName}" references binding ` +
                `"${target.name}", which was not assigned.`);
          }
          env[envName] = id;
        }
      }

      let config: AgentSpawnerConfig = {
        displayName: blueprintBinding.title,
        modelId: assignment.modelId,
        env,
      };
      using gk = await overseerResult.newAgentSpawnerGatekeeper(config);
      await gadget.bind(bindingName, await gk.getId());
    }

    recordAnalytics(this.ctx, this.env, {
      event_name: "gadget_created",
      user_id: this.#userId.toString(),
      gadget_id: id,
      blueprint_id: blueprintId,
      source: "blueprint",
    });

    // @ts-expect-error Cap'n Web RPC stubs and native RPC stubs are compatible but the type
    //     system doesn't know this.
    return overseerResult;
  }

  async deleteOrphanedBlueprint(blueprintId: string): Promise<void> {
    await this.#requireActive();
    return this.#user.deleteOwnedBlueprint(blueprintId);
  }

  // --- Gatekeeper management apps ---

  // The management apps available to the current user: their connected accounts that declare a
  // top-level UI (AccountDescription.providesUi). The app id is the gatekeeper's routing id (its
  // vendor id, e.g. "context"), so each app is hosted at /gatekeepers/<vendorId>. UI-providing
  // accounts are auto-provisioned singletons (one per vendor), so the vendor id identifies them.
  async listGatekeeperApps(): Promise<GatekeeperAppInfo[]> {
    await this.#requireActive();
    // listProvidedAccounts provisions auto-provisioned accounts first (idempotent), so their apps
    // appear in the nav even before the user opens a gadget — in a single round trip.
    let accounts = await this.#user.listProvidedAccounts();
    let apps: GatekeeperAppInfo[] = [];
    for (let account of accounts) {
      let providesUi = account.description.providesUi;
      if (!providesUi) continue;
      if (this.centralAuthMode) {
        let access = await this.organizationDirectory.getByName("")
            .resolveAppAccess(this.guard.subject, account.vendorId);
        if (!access.allowed) continue;
      }
      apps.push({
        id: account.vendorId,
        title: providesUi.title,
        icon: providesUi.icon,
      });
    }
    return apps;
  }

  async getGatekeeperApp(id: string): Promise<GatekeeperUiFrame | null> {
    await this.#requireActive();
    if (this.centralAuthMode) {
      let access = await this.organizationDirectory.getByName("")
          .resolveAppAccess(this.guard.subject, id);
      if (!access.allowed) return null;
    }
    // Self-sufficient: listProvidedAccounts provisions auto-provisioned accounts first (idempotent),
    // so a direct URL load of /gatekeepers/$id works without racing the Header's listGatekeeperApps.
    let user = this.#user;  // one stub for both calls
    let accounts = await user.listProvidedAccounts();
    let app = accounts.find((account: (typeof accounts)[number]) => account.vendorId === id && account.description.providesUi);
    if (!app) return null;
    return user.startAccountAppUi(app.accountId, {
      authority: this.#contextAuthority(
          id, () => user.requireAccountAppUiAccess(app.accountId, id)),
    });
  }

  // --- Directory audiences ---

  async listAudienceTargets(): Promise<DirectoryAudienceTargets> {
    this.guard.assertValid();
    return this.organizationDirectory.getByName("")
        .listAudienceTargets(this.guard.subject);
  }

  // --- Deployment admin ---

  async amIAdmin(): Promise<boolean> {
    await this.#requireActive();
    return this.#isAdmin();
  }

  async getAdminApi(): Promise<RpcStub<AdminApi> | null> {
    await this.#requireActive();
    if (!(await this.#isAdmin())) return null;
    // #isAdmin() guarantees a non-empty user id name. Forwarded to gatekeepers when listing the
    // resource catalog so RBAC-gated ones still surface for this admin.
    let adminUserId = this.guard.subject;
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return new AdminApiImpl(this.adminSettings.getByName(""),
        this.organizationDirectory.getByName(""), adminUserId, this.#userId.toString(), this.guard);
  }

}

async function serveBlueprintScreenshot(env: Env, blueprintId: string): Promise<Response> {
  let object = await env.BLUEPRINT_CONTENT.get(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${blueprintId}`);
  if (!object) return new Response("Not Found", {status: 404});

  let contentType = object.httpMetadata?.contentType;
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    contentType = "image/jpeg";
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// Returned by startGatekeeperLogin(). Wraps the PendingLogin DO so the client awaits the login
// result through a capability (this stub) rather than a guessable id — no login id is ever exposed
// to the client. Disposing the stub (e.g. when the pop-up closes or the component unmounts) cancels
// the in-flight wait and lets the DO be evicted.
@validateRpc()
class LoginAttemptImpl extends RpcTarget implements LoginAttempt {
  constructor(private pending: DurableObjectStub<PendingLogin>) {
    super();
  }

  async wait(): Promise<string> {
    return await this.pending.awaitResult();
  }
}

@validateRpc()
class PublicApiImpl extends RpcTarget implements PublicApi {
  users: DurableObjectNamespace<UserDurableObject>;
  #humanSessionGuard: HumanSessionGuard | undefined;
  #authenticatingHuman = false;

  constructor(private ctx: ExecutionContext, private env: Env,
      private abortSession: (reason: Error) => void,
      private publishHumanSessionGuard: (guard: HumanSessionGuard) => void,
      private accessPayload?: JWTPayload) {
    super();
    this.users = this.ctx.exports.UserDurableObject;
  }

  async ping(): Promise<void> {}

  async getServerConfig(): Promise<ServerConfig> {
    return getServerConfig(this.env);
  }

  async startGatekeeperLogin(vendorId: string)
      : Promise<{ url: string; attempt: RpcStub<LoginAttempt> }> {
    if (hasSupabaseAuthSettings(this.env)) throw createAuthError(AUTH_ERROR_CODES.forbidden);
    if (!getAuthGatekeeperAllowlist(this.env).includes(vendorId)) {
      throw new Error(`Sign-in via "${vendorId}" is not enabled on this deployment.`);
    }
    const vendor = getAuthVendorBinding(this.env, vendorId);
    if (!vendor) throw new Error(`No such auth gatekeeper: ${vendorId}`);
    const desc = await vendor.describe();
    if (!desc.providesAuth) throw new Error(`"${vendorId}" does not provide authentication.`);

    // The PendingLogin DO is the rendezvous between this request and the (separate) OAuth-callback
    // invocation. The client never sees its id — we hand back an `attempt` stub instead.
    const pendingId = this.ctx.exports.PendingLogin.newUniqueId();
    const pending = this.ctx.exports.PendingLogin.get(pendingId);
    const callback = this.ctx.exports.LoginConnectCallbackImpl({
      props: {pendingId: pendingId.toString(), vendorId},
    });
    // For most providers, sign-in needs only minimal scopes to verify the user's email (the grant is
    // transient); capability scopes are requested later via an explicit connectAccount. Cloudflare is
    // the exception: signing in with Cloudflare also links AI Gateway billing, so it requests and
    // persists the billing-only scope set up front.
    const options = vendorId === CLOUDFLARE_VENDOR_ID
      ? { scopes: "full" as const, resourceUrlPatterns: [] }
      : { scopes: "auth" as const };
    const { url } = await vendor.connectAccount(callback, options);
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return { url, attempt: new LoginAttemptImpl(pending) };
  }

  async authenticate(token: string): Promise<AuthenticatedApi> {
    if (hasSupabaseAuthSettings(this.env)) {
      if (this.#humanSessionGuard || this.#authenticatingHuman) {
        throw createAuthError(AUTH_ERROR_CODES.unauthenticated);
      }
      this.#authenticatingHuman = true;
      try {
        const identity = await verifyHumanAccessToken(token, this.env);
        const guard = new HumanSessionGuard(identity.subject, identity.expiresAtMs);
        guard.assertValid();
        const userId = this.users.idFromName(`supabase:${identity.subject}`);
        const user = await this.ctx.exports.OrganizationDirectoryDurableObject.getByName("")
            .authenticateHuman(identity.subject, userId.toString(), identity.verifiedEmail);
        await this.users.get(userId).loginFromSupabase(user);
        this.#humanSessionGuard = guard;
        this.publishHumanSessionGuard(guard);
        const remaining = Math.max(0, identity.expiresAtMs - Date.now());
        if (remaining <= 2_147_483_647) {
          setTimeout(() => {
            this.abortSession(createAuthError(AUTH_ERROR_CODES.unauthenticated));
          }, remaining);
        }
        recordAnalytics(this.ctx, this.env, {
          event_name: "user_authenticated",
          user_id: identity.subject,
          source: "supabase_oauth",
        });
        return new AuthenticatedApiImpl(
            this.ctx, this.env, userId, this.abortSession, guard, true);
      } finally {
        this.#authenticatingHuman = false;
      }
    }

    let split = token.split(':');
    if (split.length !== 2) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }

    let userId = this.users.idFromName(split[0]);
    await this.users.get(userId).authenticate(split[1]);
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "session_token",
    });
    return new AuthenticatedApiImpl(this.ctx, this.env, userId, this.abortSession,
        new HumanSessionGuard(split[0], Number.MAX_SAFE_INTEGER), false);
  }

  async authenticateFromCfAccess(): Promise<AuthenticatedApi> {
    if (hasSupabaseAuthSettings(this.env)) throw createAuthError(AUTH_ERROR_CODES.forbidden);
    if (!this.accessPayload) {
      throw createAuthError(AUTH_ERROR_CODES.notAuthenticatedWithAccess);
    }

    let email = this.accessPayload.email as string;
    let userId = this.users.idFromName(email);
    let signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
    let accountCreated = await this.users.get(userId).authenticateFromCfAccess(
        email, signupsEnabled);
    if (accountCreated) {
      recordAnalytics(this.ctx, this.env, {
        event_name: "account_created",
        user_id: userId.toString(),
        source: "cf_access",
      });
    }
    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: userId.toString(),
      source: "cf_access",
    });
    return new AuthenticatedApiImpl(this.ctx, this.env, userId, this.abortSession,
        new HumanSessionGuard(email, Number.MAX_SAFE_INTEGER), false);
  }

  async login(username: string, passwordHash: Uint8Array): Promise<string | null> {
    if (hasSupabaseAuthSettings(this.env)) throw createAuthError(AUTH_ERROR_CODES.forbidden);
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }
    if (!isPasswordAuthEnabled(this.env)) {
      throw new Error("Password login is disabled on this deployment. Use a sign-in option.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let token = await this.users.get(id).login(passwordHash);
    if (!token) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "user_authenticated",
      user_id: id.toString(),
      source: "password",
    });

    return `${username}:${token}`;
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (hasSupabaseAuthSettings(this.env)) throw createAuthError(AUTH_ERROR_CODES.forbidden);
    if (this.env.CF_ACCESS_AUD) {
      throw new Error("This deployment requires Cloudflare Access authentication.");
    }
    if (!isPasswordAuthEnabled(this.env)) {
      throw new Error("Password signup is disabled on this deployment. Use a sign-in option.");
    }
    if (!(await readAdminConfig(this.env)).signupsEnabled) {
      throw new Error("New signups are currently disabled on this deployment.");
    }

    username = normalizeUsername(username);

    let id = this.users.idFromName(username);
    let user = this.users.get(id);

    let token = await user.createAccount(username, displayName, passwordHash);
    if (!token) return null;

    recordAnalytics(this.ctx, this.env, {
      event_name: "account_created",
      user_id: id.toString(),
      source: "password",
    });

    return `${username}:${token}`;
  }

  async getBlueprint(id: string): Promise<BlueprintPublicInfo | null> {
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) return null;

    return publicBlueprintInfo(id, kvRecord.metadata);
  }

  async downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>> {
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) throw new Error("Blueprint not found.");

    let r2Object = await this.env.BLUEPRINT_CONTENT.get(`${id}/${kvRecord.metadata.version}`);
    if (!r2Object) throw new Error("Blueprint content not found in R2.");

    let metadata = { ...kvRecord.metadata };
    delete metadata.screenshot;

    return buildBlueprintArchiveStream(metadata, r2Object.body, r2Object.size);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);

    if (url.pathname === DIRECTORY_USER_PATH) {
      return handleDirectoryUserRequest(req, env, ctx);
    }

    if (url.pathname === SITE_LOGO_PATH) {
      return serveSiteLogo(req, env.BLUEPRINT_CONTENT);
    }

    if (url.pathname.startsWith(BLUEPRINT_SCREENSHOT_PATH_PREFIX)) {
      let blueprintId = url.pathname.slice(BLUEPRINT_SCREENSHOT_PATH_PREFIX.length);
      return serveBlueprintScreenshot(env, blueprintId);
    }

    // Sign-in via authentication gatekeepers happens entirely within each gatekeeper Worker (the
    // OAuth redirect lands on `/gatekeeper/<name>/oauth`); the result is bridged back to the waiting
    // browser via the `attempt` stub from PublicApi.startGatekeeperLogin(). So the backend no longer
    // hosts /auth/* callbacks.

    if (url.pathname === "/api/client-errors") {
      return handleClientErrorRequest(req, env, ctx);
    }

    if (url.pathname === "/api") {
      // Make sure the bundled format blueprints are installed. The AdminSettings DO doesn't wake
      // merely because someone deployed, so the install needs a trigger; hanging it off API
      // traffic means a fresh deployment is provisioned by its first visitor. Fire-and-forget,
      // and the DO is idempotent.
      if (!formatBlueprintInstallStarted) {
        formatBlueprintInstallStarted = true;
        ctx.waitUntil(ctx.exports.AdminSettings.getByName("").ensureFormatBlueprintsInstalled()
            .then((complete: boolean) => {
              // A partial install resolves rather than throwing, and nothing else will call the DO
              // from here, so clearing this is the whole retry: one bad archive would otherwise
              // leave the deployment half-provisioned for as long as the isolate lives.
              if (!complete) formatBlueprintInstallStarted = false;
            })
            .catch((err: unknown) => {
              // Likewise let the next request try again. The DO coalesces concurrent callers, so a
              // retry costs one comparison once it succeeds.
              formatBlueprintInstallStarted = false;
              logger.warn("failed to install bundled format blueprints", {
                event: "formats.install.trigger.failed", error: err,
              });
            }));
      }

      let accessPayload: JWTPayload | undefined;

      if (env.CF_ACCESS_AUD) {
        if (req.headers.get("Origin") !== url.origin) {
          return new Response("Cross-origin API access not allowed.", { status: 403 });
        }

        const payload = await verifyCfAccessJwt(req, env);
        if (!payload) return new Response("Invalid CF access JWT.", { status: 403 });

        if (!payload.email) {
          return new Response("Access JWT didn't specify email address.", { status: 403 });
        }

        accessPayload = payload;
      }

      // HACK: Implement `abortSession` callback by closing the websocket.
      // TODO: When ctx.abort() becomes non-experimental, consider using that instead.
      let abortController = new AbortController();
      let abortSession = (reason: Error) => {
        // Closing the socket fails no invocation, so nothing else logs this.
        logger.warn("aborting api session", { event: "session.abort", error: reason });
        abortController.abort(reason);
      };
      let humanSessionGuard: HumanSessionGuard | undefined;

      return await newWorkersRpcResponse(req,
          new PublicApiImpl(ctx, env, abortSession, guard => {
            humanSessionGuard ??= guard;
          }, accessPayload),
          {
            abortSignal: abortController.signal,
            getHumanSessionGuard: () => humanSessionGuard,
          });
    }

    return new Response("Not Found", {status: 404});
  }
} satisfies ExportedHandler<Env>;

// Extend Cap'n Web's RpcSessionOptions with an AbortSignal.
//
// TODO: Consider adding this feature to Cap'n Web. However, we might not actually need it for
//   long: ctx.abort() will soon be available non-experimentally, in which case we can just use
//   that instead.
type ExtendedRpcSessionOptions = RpcSessionOptions & {
  // Abort WebSocket sessions when this AbortSignal is aborted. (No effect on HTTP batch sessions.)
  abortSignal: AbortSignal;
  /** Current immutable human authority for this socket, once authenticate() succeeds. */
  getHumanSessionGuard?: () => HumanSessionGuard | undefined;
};

class GuardedWebSocketTransport implements RpcTransport {
  readonly #transport: WebSocketTransport;

  constructor(webSocket: WebSocket,
      private getHumanSessionGuard?: () => HumanSessionGuard | undefined) {
    this.#transport = new WebSocketTransport(webSocket);
  }

  send(message: string): void | Promise<void> {
    return this.#transport.send(message);
  }

  async receive(): Promise<string> {
    const message = await this.#transport.receive();
    this.getHumanSessionGuard?.()?.assertValid();
    return message;
  }

  abort(reason: unknown): void {
    this.#transport.abort(reason);
  }
}

// Clone of newWorkersRpcResponse() from Cap'n Web, except the `options` has been extended with
// `abortSignal`.
async function newWorkersRpcResponse(
    request: Request, localMain: any, options?: ExtendedRpcSessionOptions) {
  if (request.method === "POST") {
    let response = await newHttpBatchRpcResponse(request, localMain, options);
    // Since we're exposing the same API over WebSocket, too, and WebSocket always allows
    // cross-origin requests, the API necessarily must be safe for cross-origin use (e.g. because
    // it uses in-band authorization, as recommended in the readme). So, we might as well allow
    // batch requests to be made cross-origin as well.
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain, options);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}

function newWorkersWebSocketRpcResponse(
    request: Request, localMain?: any, options?: ExtendedRpcSessionOptions): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
  }

  let pair = new WebSocketPair();
  let server = pair[0];
  server.accept()
  const transport = new GuardedWebSocketTransport(server, options?.getHumanSessionGuard);
  const stub = new RpcSession(transport, localMain, options).getRemoteMain();

  // -- ADDED FOR GADGETS --
  if (options?.abortSignal) {
    if (options.abortSignal.aborted) {
      stub[Symbol.dispose]();
    } else {
      options.abortSignal.addEventListener("abort", () => {
        stub[Symbol.dispose]();
      });
    }
  }
  // -- END ADDED FOR GADGETS --

  return new Response(null, {
    status: 101,
    webSocket: pair[1],
  });
}
