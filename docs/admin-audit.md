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

The browser supplies only the desired boolean and an opaque idempotency key. The backend passes the
authenticated User Durable Object id to the directory, which assigns the installation's single MVP
tenant and a canonical opaque directory user id. Email, username, actor, tenant, role, and resource
identifiers are not accepted from the mutation or history-query arguments.

Audit history is exposed only on the existing `AdminApi` capability. A non-admin receives `null`
from `AuthenticatedApi.getAdminApi()` and cannot select or enumerate a tenant. The directory also
rejects internal reads for any tenant other than its own singleton tenant.

## Stored data and retention

Each event contains stable event, mutation-correlation, and idempotency identifiers; server time;
tenant and actor ids; installation resource; action; before/after policy versions; result and reason;
and the bounded `signupsEnabled` boolean transition. It does not store passwords, cookies, tokens,
prompts, documents, connector responses, or arbitrary configuration patches.

Events and matching idempotency receipts are retained for the lifetime of the deployment's Durable
Object storage. T02 performs no automatic deletion and offers the newest 50 events by default (up
to 200 per query). This deliberate local retention keeps late retries idempotent. A future retention
or export policy must preserve retry detection separately before deleting event records.

This is the reusable path for future administrative mutations: add a bounded action/change schema,
commit it with the mutation in the `AdminSettings` outbox transaction, and deliver it idempotently
to the organization directory. T02 does not add groups, invitations, user lifecycle, ACLs, a central
collector, or Vault auditing.
