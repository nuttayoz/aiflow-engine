# Microsoft SharePoint Entry Contract v1

Status: Phase 0B proposal for Phase 4 implementation.

This contract defines how AiFlow Engine discovers new documents in Microsoft SharePoint Online, stages their bytes in engine-managed object storage, and starts the same provider-neutral execution used by direct upload. It covers Microsoft Graph connection and permission boundaries, workflow configuration, shared subscriptions, webhook handling, delta reconciliation, source-version deduplication, renewal, recovery, and scaling.

It does not add a SharePoint execution state, send documents through an API, or implement a SharePoint destination action. A future destination action needs its own write/idempotency contract.

## Legacy evidence and target

The inspected legacy runtime has no SharePoint implementation. Its Google Drive trigger is embedded in an n8n workflow and passes a base64 document to downstream nodes. That shape is migration evidence only; it is not a target contract.

The target is:

```text
SharePoint document library
  -> Microsoft Graph basic change notification
  -> AiFlow provider callback (durable wake-up hint)
  -> drive delta reconciliation
  -> source-version ingestion intent
  -> Graph-to-S3 streaming worker
  -> DOCUMENT_STAGED + execution + outbox
  -> existing EXTRACT -> MAP -> optional REVIEW -> DELIVER flow
```

Evidence was inspected at:

- `devportal` `2fc93d8ba136`;
- `devportal-backend` `c546a2fdedf2`;
- `n8n-service` `05e6c32cfe1c`;
- `aiflow-trigger-handler` `7d5f9633af44`;
- `aiflow-webhook-processor` `85d2d46e78fd`.

## Fixed decisions

- The connector ID is `microsoft-sharepoint`; its initial entry capability version is immutable and uses `MANAGED` provisioning.
- SharePoint Online through Microsoft Graph v1.0 is the initial target. SharePoint Server/on-premises is not silently treated as the same product.
- Background operation uses Microsoft Entra service-to-service authentication. It never depends on a human refresh token or a signed-in user remaining active.
- Microsoft Graph basic notifications are wake-up hints. Delta is authoritative for what changed.
- One tenant connection and drive share one Graph drive-root watch. Workflow bindings select folders beneath that watch. Watches are never shared across engine tenants or connections.
- Graph drive-root subscriptions use `changeType: updated`, `includeResourceData: false`, resource `drives/{driveId}/root`, and no security-event preference.
- The initial product accepts new or changed file versions after activation. Activation does not import existing documents. A future backfill is an explicit operation, not a hidden activation option.
- A full metadata-only drive baseline is required before first activation. It creates the item inventory and delta cursor without downloading or executing existing files.
- A provider item version is effectively once per workflow binding. Duplicate notifications, delta replay, worker restart, and manual recovery cannot create a second ingestion for that version.
- The provider stream goes directly through an entry worker into S3 with bounded memory and backpressure. No complete file is buffered, sent through the API, or placed in PostgreSQL/RabbitMQ.
- Source deletion never deletes an already staged engine document or cancels an accepted execution. Engine retention remains authoritative.
- The callback, sync, and ingestion paths are separate workloads in the same repository/image. They may scale as separate Kubernetes deployments and RabbitMQ queue groups without becoming separate repositories or services.
- Google Drive or another future provider implements the same connector/provisioning/storage ports; it does not reuse Microsoft configuration or change the workflow envelope.

The provider-neutral lifecycle remains defined by [`workflow-provisioning-v1.md`](workflow-provisioning-v1.md), [`storage-v1.md`](storage-v1.md), and [`execution-lifecycle.md`](execution-lifecycle.md).

## Confirmed Microsoft Graph behavior

The design relies on these current Microsoft Graph v1.0 facts:

- OneDrive for Business/SharePoint driveItem notifications support only the drive root and the `updated` change type. Microsoft lists `/drives/{id}/root` as the supported resource path in its [change-notification overview](https://learn.microsoft.com/en-us/graph/change-notifications-overview) and documents the root-only limitation in [create subscription](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0).
- Duplicate subscriptions with the same `changeType` and `resource` return `409 Conflict`. A shared drive watch is therefore a correctness requirement, not only an optimization.
- A driveItem subscription can live at most 42,300 minutes. The engine must renew using the expiration returned by Graph, as documented by the [subscription resource](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0).
- Webhook delivery is considered successful after a 2xx response within three seconds. Graph retries failed delivery for up to four hours and may delay or drop notifications from slow endpoints; the [webhook guidance](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks) recommends persisting work and returning `202 Accepted`.
- Delta returns paged changes followed by an opaque `@odata.deltaLink`; items can repeat and their last occurrence wins. IDs, not paths, must be tracked because folder renames do not return every descendant. These rules come from [driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0).
- Downloading content returns a short-lived preauthenticated redirect. The worker follows it immediately without forwarding the Graph authorization header, per [driveItem content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).
- Graph throttling returns `429` and normally supplies `Retry-After`; Microsoft recommends honoring it and using exponential backoff only when the header is absent in its [throttling guidance](https://learn.microsoft.com/en-us/graph/throttling).

These provider facts are verified again by connector contract tests before every supported capability version is released. A provider behavior change does not silently alter an active connector version.

## Connection and permission contract

A SharePoint `Connection` is tenant-owned safe configuration plus approved platform identity/secret references. Connector-owned fields are conceptually:

| Field                            | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `externalTenantId`               | Exact Microsoft Entra customer tenant                                  |
| `identityMode`                   | Approved SaaS multi-tenant app or customer-owned app identity mode     |
| `credentialRef`                  | External certificate/federated-identity/secret configuration reference |
| `consentState`                   | `PENDING`, `AUTHORIZED`, `REVOKED`, or `FAILED` safe projection        |
| `permissionProfile`              | Exact approved Graph permission set and capability version             |
| `servicePrincipalId`             | Safe external service-principal reference when needed for support      |
| `lastValidatedAt`, `nextCheckAt` | Permission and health verification timing                              |

Rules:

- Acquire app-only tokens just in time for the exact customer tenant and Graph audience.
- Tokens, private keys, client secrets, authorization headers, and callback client-state values never enter workflow definitions, PostgreSQL, RabbitMQ, logs, traces, Sentry, or API responses.
- Customer administrator consent is an explicit onboarding step with visible requested permissions and revocation instructions.
- The entry connector requests read access only. It never requests a Graph write permission merely because a broader permission would also work.
- The worker verifies the token tenant and stored external tenant before accepting provider data. A connection cannot be redirected to a tenant supplied in a message or callback.

Microsoft currently documents application `Files.Read.All` for creating a OneDrive for Business driveItem subscription and for drive delta/content. This permission can read files across the customer tenant and therefore requires explicit product/security approval.

Microsoft also offers selected SharePoint permissions, including `Sites.Selected`, with an explicit site assignment, as described in its [selected-permissions overview](https://learn.microsoft.com/en-us/graph/permissions-selected-overview). However, the driveItem subscription documentation does not currently list `Sites.Selected` as a supported subscription permission. AiFlow Engine must not advertise selected-site onboarding until a production-equivalent sandbox proves subscription create/list/renew/delete, delta, metadata, and content download with the exact selected permission. If it cannot be proven, `Files.Read.All` is the honest initial requirement; broader permission is never hidden from customers.

Site URL resolution/resource browsing can have a different documented permission requirement from drive access. The initial onboarding UX and exact least-privilege combination remain confirmation `SP-01`; the implementation cannot quietly add `Sites.Read.All`.

## Resource discovery and workflow configuration

The DevPortal uses the provider-neutral connection resource API to browse only resources accessible through the selected connection:

```text
site -> document library/drive -> folder
```

Discovery returns opaque IDs, safe labels, hierarchy hints, and selection capability. It does not return access tokens, Graph URLs, raw provider payloads, web URLs containing tenant data, or secret references. The connector uses stable IDs after selection; display names and paths are never authority.

The initial connector descriptor is proposed as:

```text
connectorId: microsoft-sharepoint
capability: entry
capabilityVersion: 1
provisioningMode: MANAGED
interaction: AUTOMATIC
config: { siteId, driveId, folderId, includeSubfolders }
existingDocumentPolicy: IGNORE_BASELINE
```

Example workflow entry:

```json
{
  "connectorId": "microsoft-sharepoint",
  "connectionId": "connection-id",
  "config": {
    "siteId": "site-id",
    "driveId": "document-library-id",
    "folderId": "folder-id",
    "includeSubfolders": true
  }
}
```

`siteId`, `driveId`, and `folderId` are mandatory opaque Graph IDs in v1. Selecting the drive root is represented by its resolved root item ID; a missing folder does not mean root. `includeSubfolders` is an explicit boolean and defaults are not guessed after persistence.

Version creation validates shape and tenant-owned connection references without Graph writes. Activation reauthorizes and confirms the external tenant, site, drive, folder, folder facet, read capability, permission profile, supported connector version, and resource consistency. A folder path or label change does not invalidate a binding because identity is ID-based. A missing/deleted selected folder blocks activation or degrades an active binding.

File type, size, and document-policy filters belong to the versioned connector descriptor or shared product policy. They are not arbitrary regular expressions or executable user logic.

## Shared drive watch

Graph rejects duplicate subscriptions for the same app/change type/resource, while several workflows can select folders in one library. The adapter therefore owns one `sharepoint_drive_watches` record for:

```text
(tenantId, connectionId, driveId)
```

The watch is reference-owned by one or more provider-neutral `connector_provisioning_bindings`. Sharing is allowed only inside the same engine tenant and connection. The same external drive reached through another engine connection is not merged because its authorization, consent, identity, and lifecycle can differ.

Conceptual watch fields are:

| Field                                                 | Meaning                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `watchId`, `tenantId`, `connectionId`                 | Internal identity and ownership                                   |
| `externalTenantId`, `siteId`, `driveId`, `rootItemId` | Frozen validated Graph resource identity                          |
| `resource`, `changeType`                              | Exact subscription input (`drives/{id}/root`, `updated`)          |
| `subscriptionId`, `subscriptionExpiresAt`             | Safe external subscription identity and server-returned expiry    |
| `clientStateKeyVersion`                               | Root-secret version used to derive expected callback client state |
| `committedDeltaCursor`, `scanNextCursor`              | Confidential opaque Graph cursor state                            |
| `baselineStatus`, `subscriptionStatus`, `health`      | Guarded lifecycle and safe health projection                      |
| `notificationGeneration`, `syncCommandPending`        | Burst coalescing and no-lost-wakeup guard                         |
| `stateVersion`, lease/retry/due timestamps            | Concurrency and durable recovery                                  |
| safe failure/correlation timestamps                   | Bounded diagnostics only                                          |

Delta/next links are confidential opaque provider capabilities. They are encrypted or protected through the approved confidential-field mechanism, are never exposed through APIs/messages/telemetry, and are followed only after validating the expected Graph HTTPS origin. Query tokens are always redacted.

`clientState` is derived as a bounded base64url HMAC from `watchId` using a versioned root key held in the approved secret manager. Only the key version and a verification digest are persisted. This makes create/reconciliation deterministic without storing one callback secret per watch in PostgreSQL. Key rotation supports overlap and controlled subscription replacement; it never accepts an unversioned fallback.

The exact database migration belongs to Phase 4. Provider records are owned by `packages/connectors/microsoft-sharepoint`; the workflow and document packages access them through public ports/use cases rather than importing adapter persistence internals.

## Activation and baseline

The first binding for a drive performs a durable, resumable metadata baseline:

1. Validate the connection, IDs, folder, descriptor, callback endpoint, and permission profile.
2. Create or reconcile the drive-root Graph subscription using the stable watch identity and derived client state.
3. Call drive-root delta without a token and enumerate all pages. Upsert bounded item metadata and hierarchy by stable item ID; do not download or create ingestions for baseline files.
4. Persist each page and resumable `scanNextCursor`. Persist `committedDeltaCursor` only after the complete baseline reaches a final delta link.
5. Revalidate the selected folder against the complete inventory and catch delta up to a current cursor.
6. Atomically mark the binding eligible, switch the workflow active version, finish the provisioning operation, and publish an immediate watch reconcile command.
7. Changes after the committed baseline cursor create ingestion intents. Existing baseline files do not.

The baseline can cover an entire large drive because Graph subscriptions and authoritative delta operate at drive root. It is durable asynchronous provisioning with progress, bounded page work, retry, cancellation-by-deactivation rules, and an approved maximum library size/activation deadline. It never holds an API request, database transaction, RabbitMQ delivery, or worker lease across the whole scan.

When a healthy watch already exists, activation first brings its cursor current, validates the selected folder in its inventory, then attaches the new binding and immediately reconciles again. No second Graph subscription or baseline is created.

### Version handover

Replacing a version on the same watch brings delta current, then switches the binding generation and active-version pointer atomically. Replayed observations use the stored binding generation and ingestion uniqueness, so one source version cannot enter both versions accidentally.

When replacement moves to another drive/watch, the target watch is prepared first. At cutover the old binding becomes `DRAINING` rather than immediately ineligible. One bounded old-watch delta pass that reaches a cursor obtained after cutover may still create old-version ingestions; then the old binding retires. This small provider-defined overlap prevents the pre-cutover notification/delta gap. The new watch accepts from its baseline cursor immediately. Source identity deduplication makes replay safe.

A draining binding is not a general second active version. It accepts only observations from its recorded handover generation until the post-cutover cursor barrier is committed. A deadline failure sets `cleanupRequired`/degraded health and requires reconciliation rather than leaving intake open indefinitely.

## Callback boundary

Microsoft Graph calls a separate public provider boundary:

```text
POST /provider-callbacks/v1/microsoft-graph/sharepoint
```

This endpoint does not accept an end-user bearer token, tenant header, project ID, workflow ID, provider URL, document bytes, or resource data.

### Validation challenge

For a bounded `validationToken` query, the endpoint URL-decodes the opaque token and returns it as `200 text/plain` within ten seconds. It performs no database/provider mutation. The token has a hard length limit, is never interpreted as HTML/JavaScript, and is never logged. Missing, duplicate, malformed, or oversized parameters fail safely.

### Change and lifecycle notification

For each notification in a bounded collection, the callback:

1. validates content type, body size, JSON shape, collection count, and bounded fields;
2. finds the watch by exact stored `subscriptionId` without trusting a tenant hint;
3. derives and constant-time compares expected `clientState`;
4. verifies external tenant, resource, change type/lifecycle type, and subscription context against the watch;
5. inserts a small append-only notification event using provider event ID or a deterministic bounded fallback hash;
6. increments the watch notification generation, marks sync due, and creates at most one coalesced outbox command;
7. commits, then returns `202 Accepted` within three seconds.

The event stores allow-listed identifiers, hashes, timestamps, and safe type/status only. Raw callback bodies are not persisted. Unknown subscriptions or failed client-state checks are discarded with a uniform safe response and security telemetry; they never reveal tenant/resource existence or wake work.

Graph lifecycle notifications support `reauthorizationRequired` for driveItem subscriptions, but not `missed` or `subscriptionRemoved` for this resource at the time of this contract. The engine still configures a lifecycle URL, handles any documented supported event, and relies on scheduled delta as the recovery backstop. It never assumes lifecycle delivery is complete.

## Delta sync and inventory

`sharepoint_drive_items` is the adapter-owned metadata inventory for the life of a watch. It stores tenant/watch, item ID, parent ID, file/folder/deleted facet, bounded name/content metadata, current provider version tag, last observed scan generation, and safe timestamps. It stores no content, download URL, token, user profile, sharing details, or raw Graph object.

Sync rules:

- Acquire one guarded lease per watch. Replica count cannot create concurrent scans for the same drive.
- Start from `committedDeltaCursor`; use `scanNextCursor` only for the same verified in-progress generation.
- Validate every next/delta URL as the expected Graph HTTPS origin and API family before following it.
- Upsert every occurrence in provider order; a later occurrence of the same item wins.
- For each page, atomically update inventory, create unique ingestion intents/outbox commands for matching active/draining bindings, and persist resumable scan state.
- Advance `committedDeltaCursor` only after all pages and page effects are durable. Crash before final commit causes safe replay.
- Clear `syncCommandPending` only if the captured notification generation is still current. Otherwise commit a new outbox wake-up so no callback is lost during a scan.
- Run a jittered scheduled backstop even without callbacks. The initial proposal is every 15 minutes, subject to `SP-04` load/latency confirmation.

If Graph invalidates a delta cursor, the connector performs a full resumable reconciliation against the retained inventory. Existing unchanged baseline items remain ignored; unseen/new or changed source versions create normal ingestion intents, and deleted items become tombstones. Inventory rows are not evicted while a live watch depends on them, because eviction would make safe rebaseline impossible.

Folder membership is evaluated from stable item/parent IDs, not path text. Direct scope requires `parentId == folderId`; recursive scope walks the bounded inventory ancestry. Folder moves that can change subtree membership create a bounded scope-reconciliation job over indexed descendants. Moving a populated folder into scope can therefore ingest its current file versions; moving it out prevents future ingestion but does not delete engine documents.

The selected folder being deleted, becoming inaccessible, or changing from a folder is a permanent binding health failure until corrected. Ordinary file deletion is an inventory tombstone only.

## Source-version ingestion

`packages/documents` owns a provider-neutral `document_ingestions` record. SharePoint contributes bounded source identity through the connector port.

One ingestion is unique for:

```text
(tenantId, connectorProvisioningBindingId, driveId, itemId, sourceVersionKind, sourceVersion)
```

For a file, `cTag` is preferred when a metadata read returns it because it represents content change. The adapter falls back to `eTag` when `cTag` is unavailable, accepting conservative reprocessing after metadata-only changes. Tags are untrusted bounded opaque strings and never used as authorization.

V1 processes the latest stable file state observed by delta, not every historical SharePoint version. Multiple changes collapsed by Graph before a sync produce one ingestion of the latest state. Moving the same unchanged item out of and back into the same binding does not create a second ingestion; another workflow binding can intentionally process it once for that binding.

The ingestion worker:

1. claims the ingestion lease and loads tenant-scoped binding, watch, workflow version, inventory item, connection, and storage reservation;
2. rechecks binding eligibility, scope membership, file facet, source version, descriptor filters, and admission limits;
3. fetches current item metadata and chooses the exact bounded source-version identity;
4. reserves an immutable `SOURCE_DOCUMENT` storage object before transfer;
5. requests Graph content, manually validates the HTTPS preauthenticated redirect, strips the Graph authorization header, and follows it immediately without persisting/logging the URL;
6. streams bytes through hard size/checksum limits directly to conditional S3 upload with backpressure;
7. fetches metadata again and abandons/retries if the provider version changed during transfer;
8. verifies the exact S3 version, checksum, size, content type, and encryption;
9. rechecks binding/version eligibility and atomically commits storage `AVAILABLE`, immutable document/source metadata, execution `QUEUED`, extraction outbox, ingestion success, and audit facts.

An unsupported type, policy-rejected file, or provider-declared oversize item becomes a terminal skipped/failed ingestion with a safe code and no execution. The streaming transform still enforces the hard size cap because provider metadata is not trusted.

A failed or changed transfer abandons its exact storage reservation and schedules cleanup. It cannot publish ambiguous bytes. Provider calls and S3 transfer never run inside a database transaction.

## Subscription lifecycle and recovery

Creation uses one stable watch/resource/client-state input. Graph has no idempotency key for subscription creation, so after timeout, connection loss, or `409`, the adapter lists subscriptions created by the same application and adopts only an exact resource/change type/notification URL plus matching derived client-state value. It never parses an error string as authority or adopts another app/service's subscription. Multiple conflicting matches are a permanent integrity alert requiring operator cleanup.

The scheduler requests renewal at least seven days before the server-returned expiry, with per-watch jitter. Renewal uses `PATCH /subscriptions/{id}` and persists the returned expiration. A no-effect failure retries with bounded backoff; `429` honors `Retry-After`. Unknown renewal outcome is reconciled with `GET /subscriptions/{id}` before another mutation.

If a subscription expires or is authoritatively absent, the adapter recreates it safely and continues delta from the committed cursor. Notifications may be absent during repair, but delta prevents document loss. Permission revocation/deleted drive stops provider calls, degrades affected bindings, and exposes an actionable reconnection failure without deleting provider identity/cursor state.

Deactivation closes the workflow binding locally first. If other eligible bindings still reference the watch, no Graph deletion occurs. When the last reference retires, the adapter deletes the subscription and retains the watch/inventory until absence is confirmed. A timeout enters reconciliation; `404`/confirmed absence is idempotent success.

## Messaging, runtime placement, and scaling

Two connector-specific commands are sufficient:

```text
aiflow.connector.microsoft-sharepoint.watch.reconcile.requested.v1
  data: { watchId, expectedStateVersion, expectedNotificationGeneration }

aiflow.document.ingest.connector.microsoft-sharepoint.requested.v1
  data: { ingestionId, connectorId, expectedStateVersion }
```

The first handles delta, subscription health/renewal, and bounded scope reconciliation. The second performs document streaming. Both use the standard envelope, outbox/inbox, manual acknowledgment, leases, bounded retries, and inspectable DLQ. Messages contain identifiers and guards only.

Initial queue groups are:

| Queue                                               | Scaling reason                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `aiflow.q.connector.microsoft-sharepoint.sync.v1`   | Graph metadata calls, notification bursts, and per-watch serialization |
| `aiflow.q.connector.microsoft-sharepoint.ingest.v1` | Network/S3 streaming, large documents, and memory/concurrency limits   |

Provisioning creation/removal remains on the provider-neutral workflow-provisioning queue. The scheduler only creates due outbox commands; it never calls Graph or downloads files.

Kubernetes may deploy separate worker roles from the same image, for example:

```text
aiflow-engine worker --queues=sharepoint-sync
aiflow-engine worker --queues=sharepoint-ingest
```

Scaling is bounded by database connection budget, RabbitMQ prefetch, pod memory, S3 multipart concurrency, and Graph admission—not queue depth alone. Limits exist per external tenant, engine tenant, connection, watch, and provider app. A hot tenant cannot consume all worker permits. Graph `Retry-After` creates durable delayed work rather than sleeping with a worker/lease/delivery occupied.

No queue, deployment, database, bucket, endpoint, or credential is created per workflow or customer.

## Security and network

- The Graph callback is a public security-review boundary with strict request/body/collection limits, TLS, replay/deduplication, rate limits, and optional documented Graph source filtering as defense in depth.
- `clientState` plus exact stored subscription/tenant/resource correlation authenticates basic notifications. Validation challenges are not evidence of a subscription or authorization.
- Callback and Graph metadata are untrusted confidential provider data. Persist and expose only allow-listed bounded projections.
- Graph base URL, token endpoint, notification/lifecycle URLs, and accepted redirect policy are deployment/connector configuration. Workflow/callback/message input cannot supply an arbitrary URL.
- Preauthenticated download redirects are short-lived bearer URLs. They are validated, never logged/stored, and receive no Graph authorization header. Redirect count is bounded; downgrade, loopback, link-local, metadata, unexpected scheme/port, and DNS-rebinding targets are rejected.
- Document filenames, paths, site labels, user identities, sharing data, content, tags, cursor tokens, and provider bodies are excluded from logs, Sentry, metrics labels, and DLQ inspection.
- API, sync worker, ingestion worker, and scheduler have separate least-privilege network/IAM/runtime permissions.
- Implementation requires the security review mandated by [`SECURITY.md`](../../SECURITY.md), including permission consent, HMAC/key rotation, callback behavior, redirect validation, and document transfer.

## Observability and product status

Safe metrics include:

- watch/subscription count and health, renewal lead time, baseline/delta duration and page/item count;
- notification validation result, acknowledgement latency, coalescing ratio, callback-to-sync lag;
- cursor age, backstop lag, reset/rebaseline count, scope-reconciliation backlog;
- ingestion queue age, admitted concurrency, bytes streamed, duration, retry/failure category;
- Graph request class, throttling duration, permission failure, and redirect rejection;
- handover drain age and orphan-watch cleanup backlog.

Tenant, connection, watch, subscription, item, workflow, ingestion, and execution IDs are trace/log fields—not metric labels. Provider request IDs may be stored as bounded safe correlation fields.

Workflow activation health remains `HEALTHY`, `DEGRADED`, or `UNKNOWN`. Safe failure codes distinguish consent/permission, missing resource, baseline limit, subscription expiry, cursor reset, callback integrity, throttling, source changed, unsupported file, oversize, transfer integrity, and internal recovery. Raw Graph messages are never returned to DevPortal.

Alerts cover imminent expiry, failed renewal/recreation, stale delta cursor, sustained callback rejection, baseline/rebaseline deadline, permission revocation, repeated 429/5xx, hot-tenant fairness, ingestion/DLQ backlog, selected-folder deletion, handover deadline, and subscription/inventory integrity conflict.

## Retention

- Notification-event rows are short-lived deduplication/audit hints; the initial proposal is 30 days.
- Item inventory and source-version tombstones live while a watch or its recovery window needs them. They are deleted only after subscription absence, binding cleanup, and the approved recovery period.
- Ingestion metadata follows document/execution/audit retention and keeps the small source-version tombstone needed to prevent replay.
- SharePoint deletion does not shorten S3/document retention. Engine retention/deletion jobs remain authoritative.
- No retention job deletes an unresolved watch, cursor, binding, ingestion, or provider identity required for reconciliation.

Exact values require product/privacy confirmation and a Phase 4 migration/cleanup plan.

## Required implementation evidence

1. App-only sandbox tests prove the approved permission profile for site/drive/folder discovery, subscription create/list/get/renew/delete, delta, metadata, and content.
2. Two workflows on one tenant connection/drive create one Graph subscription and independent folder bindings.
3. Duplicate, reordered, forged, oversized, unknown-subscription, and stale-client-state callbacks cannot duplicate work or disclose tenant existence.
4. Callback persistence/acknowledgement remains below three seconds during burst load, and coalescing cannot lose a wake-up racing with sync completion.
5. Initial baseline ignores existing files, then a file created after the cursor creates one ingestion/execution.
6. Delta page replay, repeated item occurrences, worker crash, cursor invalidation, and scheduled backstop recover without duplicate ingestion or missed changed versions.
7. Folder rename/move/subtree scope changes use stable IDs and bounded scope reconciliation.
8. Version replacement on the same/different watch proves the cursor handover barrier and bounded old-binding drain.
9. Subscription create/renew/delete timeouts reconcile authoritatively; expiry/recreation continues from the committed cursor.
10. Graph 429/5xx and per-tenant bursts respect durable backoff, admission fairness, queue bounds, and Kubernetes scaling limits.
11. Large/source-changing/oversized transfers stream with bounded memory, exact S3 integrity, abandoned-object cleanup, and no ambiguous execution.
12. PostgreSQL, RabbitMQ, logs, traces, metrics, Sentry, and DLQs contain no document bytes, tokens, callback secrets, cursor/download URLs, or raw provider bodies.
13. Deactivation closes intake immediately, shared watches remain for other bindings, and the last-reference cleanup confirms subscription absence.
14. Direct upload and SharePoint produce the same document/execution shape from `DOCUMENT_STAGED` onward.

## Product and platform confirmations still required

- `SP-01`: approve the SaaS/customer-owned Entra app model, exact admin-consent UX, and sandbox-proven least-privilege profile; explicitly accept or reject broad `Files.Read.All`.
- `SP-02`: confirm supported SharePoint Online/national-cloud scope, tenant types, maximum sites/drives/folders per connection, and maximum item count per watched drive.
- `SP-03`: confirm accepted file types, maximum bytes, source-change retry, skipped-file UX, and whether malware/DLP scanning adds a pre-extraction stage.
- `SP-04`: confirm callback SLO, 15-minute delta backstop, baseline/activation deadline, renewal lead, retry/deadline budgets, and Graph per-tenant/connection concurrency.
- `SP-05`: approve new-only activation, folder/subfolder move semantics, one item-version per binding, overlapping workflow scopes, and future explicit backfill behavior.
- `SP-06`: approve notification, inventory, ingestion tombstone, orphan-watch, and provider metadata retention/deletion values.
- `SP-07`: confirm public callback hostname/routing, ingress body/time limits, Graph source filtering policy, outbound Graph/redirect egress controls, root HMAC key storage/rotation, and security review owner.
- `SP-08`: validate DevPortal site/library/folder discovery and connection-consent UX against the existing three-step flow before Phase 4 UI work.
