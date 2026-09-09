# Local administrative audit history

The Workshop keeps its first administrative audit path locally, without an external log collector.
Changing **Allow new sign-ups** through `AdminApi.setSignupsEnabled()` commits the authoritative
`AdminSettings` value, its monotonic policy version, an idempotency receipt, and a durable outbox
record in one SQLite transaction. The RPC reports success only after the configuration KV mirror
and the singleton `OrganizationDirectoryDurableObject` audit copy are durable.

If mirroring or delivery fails, the call fails rather than claiming an audited success. The outbox
remains durable and is flushed before the next audited mutation or audit query. Retrying the same
operation with the same idempotency key returns its original receipt and cannot repeat the change or
event; reusing a key with different input is rejected. A process failure after directory delivery is
also safe because the directory deduplicates the complete event by idempotency key.

## Identity and access

For the retained signup-setting mutation, the browser supplies only the desired boolean and an
opaque idempotency key. For T03 directory mutations it supplies the bounded requested value,
explicit target Subject where applicable, and UUID `mutationId`. The actor and organization always
come from the verified session and configured directory; e-mail never selects an existing user.

Audit history is exposed only on the existing `AdminApi` capability. A non-admin receives `null`
from `AuthenticatedApi.getAdminApi()` and cannot select or enumerate an organization. Every method
on a retained admin capability rechecks access-token expiry and current active-admin status.

## Directory groups

The admin Groups panel uses the same `AdminApi` capability to create, rename, replace membership,
list, and delete groups. Every group read and mutation passes the Subject derived from the retained
session guard, and the directory rechecks current active-administrator authority in that same
Durable Object invocation. Group names are trimmed for display and indexed and sorted explicitly
with the `pt-BR` locale; group IDs are server-generated UUIDs and are never supplied by the browser.
Membership replacement is one directory transaction over the complete deduplicated, sorted Subject
set. A new member must be an existing active directory user; a user disabled after joining may
remain until an administrator removes that membership.

The panel retains a caller-generated mutation UUID per operation and identical normalized payload
when a response is uncertain. It blocks concurrent UI mutations while one is in flight and clears
the pending UUID only after a confirmed RPC response. RPC arrays, membership arrays, mutation
receipts, and compound create results are copied as needed and disposed in `finally` blocks.

`AuthenticatedApi.listAudienceTargets()` is the sharing-picker directory projection. The browser
supplies no Subject: the authenticated facade checks its session guard and passes the guard's
Subject to the directory, which rechecks that the actor is effective-active in the same invocation.
The response contains only `userId`/`displayName` for effective-active users and `groupId`/`name` for
existing groups. It includes no e-mail, role, status, membership, secret, or audit data. The richer
administrator listing remains available separately so an admin can remove a disabled existing
member later.

Group authorization is resolved inside `OrganizationDirectoryDurableObject` at the point of use.
`resolveAudience()` denies missing, pending, and disabled Subjects, then returns additive sources in
the stable order `everyone`, `user:<subject>`, and sorted `group:<groupId>` entries. Deleted groups
are not traversed, so stale audience references do not grant access. This helper remains an internal
capability for later resource owners; there is no public preview endpoint or test backdoor.

T04 is implemented but not accepted. Focused automated checks and review are supporting evidence
only; the required real containerized positive and denial scenarios are still pending. No UI
acceptance, session reset, or runtime restart is claimed here.

## Stored data and retention

Each event contains stable event, mutation-correlation, and idempotency identifiers; server time;
tenant and actor ids; resource and action; before/after resource-policy versions; result and reason;
and a bounded transition. T03 adds directory-local events for first-admin bootstrap, user
invitation, role changes, and user deactivation/reactivation. The directory also records group
creation, renames, complete membership replacements, and deletion as `directoryGroup` events.
Group membership audit changes record only before/after counts, never the member ID list. The
`AdminSettings` version and directory authorization version are intentionally separate clocks owned
by their respective transactional authorities; event versions are interpreted with the resource.
When another active admin resumes a provider mutation left pending, the single final event keeps
the original `actorUserId` and records the current executor in optional `resumedByUserId`.
No event stores invitation secrets, passwords, cookies, tokens, prompts, documents, connector
responses, e-mail addresses, or arbitrary configuration patches.

Events and matching idempotency receipts are retained for the lifetime of the deployment's Durable
Object storage. No automatic deletion is performed; the UI offers the newest 50 events by default (up
to 200 per query). This deliberate local retention keeps late retries idempotent. A future retention
or export policy must preserve retry detection separately before deleting event records.

`AdminSettings` mutations use its durable outbox because their authority is a different DO.
Directory-owned lifecycle mutations commit their state, receipt, and audit event directly in one
directory transaction. Neither path adds a central collector; retention/export remains future work.
