# Central authentication and organization users

The T03 deployment mode uses one Supabase Auth project as the source of human credentials and
sessions. The stable identity is the verified Supabase `sub` UUID. E-mail is confirmed contact
data; it never selects an OS account, organization, or role. The OS keeps workspace and product
state in its existing Durable Objects.

This mode is enabled only by a complete backend configuration:
`AUTH_ISSUER`, `AUTH_PUBLIC_URL`, `AUTH_OS_CLIENT_ID`, `OS_PUBLIC_URL`, `ORG_ID`,
`BOOTSTRAP_ADMIN_SUB`, `SUPABASE_SECRET_KEY`, and `DIRECTORY_SERVICE_TOKEN`. Starting a Supabase
configuration without completing it fails closed. The secret and service token are backend-only.
The corresponding frontend values are compiled as `VITE_*` public settings; the publishable key is
not an administrative credential.

## Browser flow

The existing OS frontend hosts the central routes:

- `/auth/central` signs in through Supabase with e-mail and password and starts no local signup.
- `/auth/consent` loads the Supabase authorization request, permits only the configured OS and Vault
  client IDs with their exact configured callbacks, and invokes the provider approve/deny APIs.
- `/auth/recovery` completes an invitation or password recovery with `updateUser`, then starts a
  fresh OS authorization flow.
- `/auth/callback` is handled by `oidc-client-ts`; state, nonce, and PKCE verifier are validated by
  the library and the callback query is removed after processing.
- `/auth/logout?returnApp=os|vault` performs global Supabase logout and resolves the return target
  from that closed enum, never from a caller-provided URL.

OS is a public OAuth client using Authorization Code with PKCE S256 and scopes
`openid email profile`. Its user and request state use separate `sessionStorage` prefixes. The
central Supabase SDK session uses the `scaleos-central-auth` storage key. When refresh is absent or
silent renewal fails, OS clears its app session and returns to the central login.

The root route owns the central authentication lifecycle. Blueprint pages reuse its auth context
instead of authenticating the same RPC socket again. Callback processing is shared while in flight;
canceled React effects cannot install a capability or remove a newer OIDC session. Reloading the
Admin or blueprint page preserves a valid app session. RPC dependency failures do not erase that
OIDC session; invalid authentication still clears it. Cleanup disposes the old capability when the
socket changes or its owning effect unmounts.

The backend accepts only an access token issued for `AUTH_OS_CLIENT_ID`. It verifies the configured
issuer, ES256 signature through remote JWKS, `aud=authenticated`, expiry, UUID subject, and exact
`client_id`. Invalid credentials are `UNAUTHENTICATED`; unavailable or malformed provider/JWKS
responses are `DEPENDENCY_UNAVAILABLE`. A central Supabase token without the OS client ID and an ID
token do not authorize the OS API.

## Directory and bootstrap

`OrganizationDirectoryDurableObject` is a single, authoritative directory addressed by the fixed
singleton name. Its organization ID is the backend-configured `ORG_ID`. It stores:

- organization identity;
- users keyed by the Supabase Subject UUID, with `email`, `displayName`, `admin|member` role, and
  `active|disabled` status;
- the deterministic Subject-to-User-DO binding;
- invitation admission and first-acceptance timestamps;
- narrowly scoped pending invitation and lifecycle records;
- idempotency receipts and bounded administrative audit events.

On empty storage, only `BOOTSTRAP_ADMIN_SUB` may bootstrap. The directory confirms that UUID exists
in Supabase Auth and has a confirmed e-mail before atomically creating the organization, first
active admin, admission, OS binding, receipt version, and audit event. Restarts never recompute the
admin from configuration. A stored organization that differs from `ORG_ID` fails closed.

After bootstrap, every login requires an existing active directory admission. The User Durable
Object name is deterministic from `supabase:<sub>`; the first admitted login creates only a local
profile projection, never a password or alternate credential. Confirmed e-mail claims may refresh
the contact address. The existing self-service display-name edit is preserved and is not
overwritten by later logins.

## Invitations, roles, and lifecycle

An active administrator uses the **Users** tab or `AdminApi` to list users, invite by e-mail and
display name, change `admin|member`, and change `active|disabled`. Every administrative method
rechecks token expiry plus current active-admin status. New invitations call the Supabase Admin API
with `redirectTo=${OS_PUBLIC_URL}/auth/recovery`; OS never creates or stores an invitation bearer
secret. Directory state always uses the provider-returned Subject UUID.

Mutations carry a UUID `mutationId`. A retry by the same actor and operation with the same payload
returns the original receipt; reusing it with a different payload is a conflict. Invitation state
is reserved before provider I/O, so a retry can recover an already-created Auth user by provider ID
or confirmed e-mail without sending another invitation.

A lifecycle change is also reserved before provider I/O. While pending, the target's effective
status is disabled. Provider failure is not reported as success; the exact mutation can be retried
from the admin UI. `listPendingUserLifecycle` exposes the exact original target, status, mutation ID,
and initiating actor only to an active admin; `resumeUserStatus` treats that actor as selector data,
rechecks the current executor's admin authority, and applies only the matching stored operation.
Repeating resume after completion returns the original receipt. Completion atomically records the
local status, one audit event, one receipt, and removal of the pending record. The event preserves
the original actor and records a different current executor in optional `resumedByUserId`.

An administrator cannot disable their own account, even when another active admin exists; both the
ordinary mutation and resume path reject this with `FORBIDDEN`. At least one active administrator
must remain. An opposite operation conflicts while pending. Deactivation preserves the Subject,
OS content, history, and external grants; reactivation does not mint a session or recreate removed
grants.

## Session capability guard

A `HumanSessionGuard {subject, expiresAtMs}` is created only after token verification. Every public
`AuthenticatedApi` and `AdminApi` operation checks it. Workspace capabilities carry the same guard
through `Overseer`, derived gadget and gatekeeper clients, and the approval queue used by delegated
Context observations/actions. Each sensitive entry rejects at or after token expiry. Closing the
RPC/WebSocket at the deadline remains cleanup only; it is not the authorization check.

Current directory status is checked when entering the authenticated kernel and on every
`AuthenticatedApi`/`AdminApi` call. Already-issued access tokens may otherwise remain valid until
their standard expiry; there is no 60-second lease, polling, authorization snapshot, or push
invalidation protocol.

## Private directory lookup

Vault may validate an explicit sharing/admission target through:

`GET /api/internal/directory/users?userId=<subject-uuid>`

The endpoint requires `Authorization: Bearer <DIRECTORY_SERVICE_TOKEN>` and compares the token in
constant time. It returns only `{userId,email,displayName,status,role}` for one admitted user, 404
when absent, 400 for an invalid UUID, 401 for missing/invalid credentials, and 503 when the
directory is unavailable. Pending lifecycle state is returned as disabled. It is not a browser
administration endpoint and Vault must not use it as continuous human-session authorization.

See [admin-audit.md](admin-audit.md) for audit fields and retention.

## Verified scope and limits

On 2026-09-08 the containerized development stack demonstrated the real OS flow: central Supabase
login, OAuth consent, Authorization Code with PKCE callback, callback-query cleanup, first-admin
bootstrap/onboarding, and entry into the OS home. Reusing the same central browser session also
allowed the Vault entry flow to recover directory identity without asking for a second password.
The backend, frontend, and Context typechecks passed; the backend unit suite passed 534 tests, the
frontend suite passed 306 tests, and the focused process-tree tests passed in the runtime image.

Later that day, Ennio confirmed successful invitation e-mail/recovery, administrator role transfer,
denial of administrator self-deactivation, and another user's disable/reactivate cycle with stable
identity and blocked access while disabled. These are user-reported functional results. The
supervisor reproduced a session loss on Admin reload, then verified the focused frontend fix with
real central login, Admin reload, authenticated blueprint navigation and blueprint reload. The
session remained authenticated and no authentication error was observed in those exercised
transitions. Independent review approved the fix; the 10 existing focused frontend tests and
frontend typecheck passed. Refresh/expiry integration remains scoped to T08.

This T03 increment does not implement T04 authorization policies, connector-grant cleanup, a
central audit exporter, or immediate push revocation. Directory status and role are rechecked at
the documented OS entry points; opaque session expiry also closes the WebSocket and rejects later
transport messages. Cross-product business authorization remains the responsibility of later
tasks.
