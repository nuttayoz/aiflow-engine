# Workflow Provisioning and Activation Contract v1

Status: Phase 0B proposal for Phase 1/2 implementation and Phase 4 managed-entry extension.

This contract defines how a validated immutable workflow version becomes eligible to accept new documents without n8n. It covers activation, provider validation, external connector setup, version replacement, deactivation, recovery, and the DevPortal-facing operation model.

Provisioning here means preparing a workflow's connector bindings. It does not create Kubernetes deployments, services, queues, databases, users, API keys, or n8n resources per workflow.

## Legacy evidence and target

The inspected DevPortal calls `POST /workflow/:workflowId/activate` or `/deactivate` with browser-generated `x-client-id`. `devportal-backend` forwards that request through `n8n-service`, which only authenticates to and proxies the corresponding n8n API. The response is reduced to workflow metadata plus an `active` boolean.

There is no durable legacy provisioning operation, effect identity, retry state, reconciliation, or provider-resource ownership to preserve. The target keeps the visible activate/deactivate workflow while replacing the implementation:

```text
DevPortal
  -> AiFlow Engine activation API
  -> durable PostgreSQL operation + outbox
  -> provisioning worker
  -> connector validation / managed provider resource
  -> atomic active-version switch
```

Evidence was inspected at:

- `devportal` `2fc93d8ba136`;
- `devportal-backend` `c546a2fdedf2`;
- `n8n-service` `05e6c32cfe1c`.

## Fixed decisions

- AiFlow Engine owns workflow versions, activation state, provisioning operations, connector bindings, and audit history.
- A workflow version is immutable. Editing creates a new version; activation never edits a definition.
- Version creation performs deterministic schema/reference validation. Activation reauthorizes and performs current connection/resource/provider checks.
- Version creation resolves a selected custom extraction profile to one exact immutable template/profile version and output-schema hash. Execution never resolves the template's current version.
- A newly accepted activation, or a deactivation requiring managed cleanup, is a durable operation. Provider calls never keep the API request or a database transaction open.
- PostgreSQL is authoritative. RabbitMQ only wakes a worker after the operation and outbox command commit together.
- At most one non-terminal provisioning operation exists per workflow.
- The current active version remains active while a replacement version is prepared. A target failure does not disable the current version.
- The active-version pointer changes atomically only after every required target binding is ready.
- An unchanged managed binding is reused by exact capability/configuration hash; editing an unrelated workflow field does not recreate its provider resource.
- Deactivation stops local intake immediately, but already accepted executions continue with their captured workflow version.
- External provisioning effects use a stable engine key and reconciliation. An unknown provider outcome is never blindly repeated.
- Connector adapters own provider-specific validation, resource creation, renewal, deletion, and handover behavior.
- No workflow creates a per-workflow RabbitMQ queue, worker deployment, HTTP endpoint, credential, database schema, or provider account.
- No document bytes, extracted values, mapped data, credentials, or provider response bodies are involved in provisioning.

The canonical definition and endpoints are defined by [`canonical-api-v1.md`](canonical-api-v1.md). Authentication and tenant rules follow [`auth-tenancy.md`](auth-tenancy.md). Persistence and messages follow [`postgresql-v1.md`](postgresql-v1.md) and [`messaging-v1.md`](messaging-v1.md).

## Connector provisioning capability

Each connector descriptor declares one activation behavior for each supported entry or destination capability version:

| Mode            | Meaning                                                                                | Initial example                    |
| --------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `NONE`          | Schema/catalog checks only; no live provider resource                                  | `direct-upload` entry              |
| `VALIDATE_ONLY` | Bounded live authorization/resource/capability checks; no provider write               | Business Central draft destination |
| `MANAGED`       | Create, share where allowed, reconcile, renew, and remove a required provider resource | SharePoint subscription entry      |

The descriptor also publishes:

- immutable connector/capability/schema versions;
- required connection and resource types;
- safe configuration schema;
- validation and provisioning timeouts;
- stable effect/reconciliation capability;
- renewal and health requirements for `MANAGED` resources;
- permissions and customer setup prerequisites;
- safe failure codes and operator recovery actions.

Adding Google Drive or another future entry provider adds a descriptor and adapter that satisfies this contract. It does not add a new workflow lifecycle or public activation payload.

`MANAGED` is not permission to execute arbitrary connector code or user URLs. Only installed, allow-listed connector modules may contribute provisioning behavior.

A managed adapter may share one reference-owned external watch when the provider forbids duplicates or sharing materially improves bounded scale. Sharing requires an exact connector-defined key, remains inside one engine tenant and connection, and never merges authorization or lifecycle across tenants/connections. Workflow-specific bindings still control eligibility, version handover, scope, and audit. The first such rule is the SharePoint `(tenantId, connectionId, driveId)` watch defined by [`sharepoint-entry-v1.md`](sharepoint-entry-v1.md).

## Resource discovery and selection

`GET /api/v1/connections/:connectionId/resources` is read-only discovery through the selected connector. It accepts bounded provider-neutral query controls such as resource type, parent resource ID, search text, and cursor only when the descriptor supports them.

Resource results contain:

- opaque stable resource ID;
- resource type;
- safe display label and bounded hierarchy metadata;
- capability/selection flags;
- cursor metadata where applicable.

Results exclude access tokens, raw provider payloads, arbitrary URLs, secret references, broad permissions, and confidential fields not needed for selection. The workflow definition stores opaque resource IDs, never only mutable display names.

Discovery does not reserve or provision a resource. Activation resolves the stored IDs again under the current connection, tenant, permission, and connector version before any external write.

## Version validation versus activation validation

### Version creation

Creating a version validates without provider writes:

1. definition envelope and connector-owned schemas;
2. tenant/project ownership and referenced connection ownership;
3. installed connector, action, extraction-profile, and schema versions, including exact custom profile-version resolution defined by [`extraction-templates-v1.md`](extraction-templates-v1.md);
4. mapping source/target paths against that frozen profile schema and the bounded review policy defined by [`review-v1.md`](review-v1.md);
5. bounded values and forbidden secret/URL fields;
6. the relational connection-reference projection and definition hash.

A version is either `VALID` or rejected. Persisted versions are never changed to repair configuration; a corrected definition creates a new version.

### Activation

Activation reauthorizes the project and every referenced connection, then verifies current external facts:

1. version belongs to the requested workflow/tenant/project and remains supported;
2. connector modules and exact capability/schema versions are installed;
3. the exact frozen extraction profile version, custom template version when applicable, output-schema hash, and destination action remain installed, supported, and permitted;
4. connections are authorized, enabled, unexpired, and compatible;
5. selected companies/sites/drives/folders/resources still exist and are accessible;
6. required permissions, custom endpoints/extensions, quotas, and provider capabilities are present;
7. `MANAGED` connectors can satisfy their effect, lookup, renewal, cleanup, and handover contract;
8. a review-required version has an installed production-eligible presentation adapter and compatible content limits;
9. there is no unresolved earlier provisioning effect or cleanup that makes another activation unsafe.

Live checks run outside database transactions with bounded timeouts and concurrency. A transient check failure follows the durable retry policy; a deterministic configuration or permission failure ends the operation with a safe code.

## Public API contract

| Method and path                                    | Purpose                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/v1/workflows/:workflowId/activation`     | Read active version, intake gate, operation, health  |
| `PUT /api/v1/workflows/:workflowId/activation`     | Activate or replace with one selected version        |
| `DELETE /api/v1/workflows/:workflowId/activation`  | Stop new intake and remove managed external bindings |
| `GET /api/v1/provisioning-operations/:operationId` | Poll one tenant-scoped operation                     |

Activation and deactivation require `aiflow.workflow.activate`, current project authorization, and `Idempotency-Key`.

### Activation projection

Workflow list/get and the dedicated activation endpoint expose:

```json
{
  "data": {
    "workflowId": "workflow-id",
    "activeVersionId": "version-id",
    "acceptingNewDocuments": true,
    "targetVersionId": null,
    "operation": null,
    "cleanupRequired": false,
    "health": "HEALTHY"
  }
}
```

`activeVersionId` is the authoritative version for newly accepted documents. `acceptingNewDocuments` is server-derived and must be checked by every entry boundary; clients never set it. An active workflow may temporarily show a target operation while the old version continues accepting documents.

Workflow metadata status is limited to `INACTIVE`, `ACTIVE`, or `ARCHIVED`; operation progress is not overloaded into that field. A workflow is `ACTIVE` only while it has an active-version pointer. Clients use the activation operation for provisioning progress and failure details.

Health is limited initially to `HEALTHY`, `DEGRADED`, or `UNKNOWN`. Health does not silently change the active version or redirect to another connection/provider.

`cleanupRequired=true` means a retired/disabled managed binding is pending removal or needs recovery. It clears only after authoritative absence; a failed cleanup also changes health to `DEGRADED`.

### Activate a version

```http
PUT /api/v1/workflows/workflow-id/activation
Authorization: Bearer <token>
Idempotency-Key: activate-workflow-version-2
Content-Type: application/json
```

```json
{
  "versionId": "version-id"
}
```

A newly accepted operation returns `202 Accepted` with `Location: /api/v1/provisioning-operations/<id>` and a bounded `Retry-After` polling hint:

```json
{
  "data": {
    "id": "provisioning-operation-id",
    "kind": "ACTIVATE",
    "status": "PENDING",
    "workflowId": "workflow-id",
    "targetVersionId": "version-id",
    "activeVersionId": null,
    "currentStep": "VALIDATE",
    "failure": null,
    "createdAt": "2026-07-17T10:00:00.000Z",
    "updatedAt": "2026-07-17T10:00:00.000Z"
  }
}
```

If the same version is already active, no operation/cleanup is pending, and the supplied idempotency key is new, the API returns `200 OK` with the current activation projection. Repeating the same key and request returns the same logical operation and never provisions twice. Reusing a key with a different request hash returns the standard idempotency conflict.

### Deactivate

Accepting a deactivation atomically:

1. clears the active-version pointer and sets `acceptingNewDocuments=false`;
2. creates the deactivation operation when managed cleanup is required;
3. marks managed bindings as no longer eligible for new ingestion;
4. writes audit/outbox facts.

It returns `202 Accepted` while provider cleanup remains, or `200 OK` when no managed cleanup remains. Deactivation is idempotent and does not cancel or rewrite executions/documents already accepted before the gate closed.

Activation and deactivation are serialized. A different request while an operation is non-terminal returns `409 WORKFLOW_PROVISIONING_IN_PROGRESS` with the current safe operation reference. The initial contract does not support cancellation or overlapping operations.

After a terminal failure, the server exposes only safe allowed actions. A corrected connection/version may start a new operation with a new idempotency key; reusable bindings and effect keys are reconciled rather than recreated. An unresolved external effect blocks a conflicting operation until operator reconciliation confirms its state.

### Operation status and errors

Status is limited to:

| Status          | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `PENDING`       | Durable and eligible; no worker currently owns it                 |
| `RUNNING`       | A live worker lease owns the current step                         |
| `WAITING_RETRY` | A safe retry time is persisted; no worker/broker delivery is held |
| `RECONCILING`   | A provider effect may exist and is being authoritatively checked  |
| `SUCCEEDED`     | Required validation/provisioning/cutover or cleanup completed     |
| `FAILED`        | The operation cannot progress without an explicit safe action     |

Operation kind is `ACTIVATE` or `DEACTIVATE`. `currentStep` is one of `VALIDATE`, `PROVISION`, `SWITCH`, `DEPROVISION`, or `RECONCILE` while applicable; connector-internal steps are not exposed as new core states.

Safe failure categories are `TRANSIENT`, `PERMANENT`, `UNKNOWN_OUTCOME`, and `POLICY`. The API returns a stable code, non-confidential message, occurrence time, correlation ID, and server-derived allowed actions. It does not return provider bodies, tokens, configuration, resource URLs, or secret references.

## Durable operation model

`packages/workflows` owns `workflow_activation_operations`. Conceptual fields are:

| Field                                                | Meaning                                   |
| ---------------------------------------------------- | ----------------------------------------- |
| `operationId`, `tenantId`, `projectId`               | Identity and ownership                    |
| `workflowId`, `targetVersionId`, `previousVersionId` | Target and cutover context                |
| `kind`, `status`, `currentStep`, `stateVersion`      | Guarded operation lifecycle               |
| `definitionHash`, `capabilitySetHash`                | Exact immutable inputs used by validation |
| `attemptCount`, `nextAttemptAt`                      | Durable bounded retry state               |
| `leaseOwner`, `leaseExpiresAt`                       | Short active-work ownership               |
| `reconciliationDeadlineAt`                           | Final unknown-outcome boundary            |
| `failureCode`, `failureCategory`                     | Allow-listed safe failure projection      |
| actor/correlation/causation/timestamps               | Audit and trace context                   |

Rules:

- A partial unique constraint permits at most one non-terminal operation per tenant/workflow.
- The target version and definition/capability hashes cannot change after acceptance.
- The operation, workflow guard, idempotency result, audit event, and outbox command commit atomically.
- Provider calls occur outside transactions and only under a guarded lease.
- Losing a lease prevents result commit. The scheduler recovers the durable operation.
- Terminal history is immutable and retained with the workflow/audit requirement.

The first `MANAGED` connector adds provider-neutral `connector_provisioning_bindings` through a reviewed migration. A binding stores tenant/project/workflow and active/target version association, exact connector/capability/connection/resource/configuration hashes, stable provisioning key, safe external resource reference, lifecycle/renewal/reconciliation state, and bounded health/failure metadata. Provider-specific payloads remain adapter-owned and are never copied into the workflow core.

Phase 1/2 do not create this unused binding table for `NONE`/`VALIDATE_ONLY` connectors.

## Activation and version replacement flow

1. The API validates syntax/authorization, creates the durable operation and outbox command, and returns without provider calls.
2. A provisioning worker loads tenant-scoped workflow/version/definition, descriptors, profiles, connections, and current operation.
3. It claims the operation with `stateVersion` plus a bounded lease and completes deterministic validation.
4. It performs bounded live `VALIDATE_ONLY` checks.
5. For each `MANAGED` capability it reuses an existing healthy binding when the exact capability/configuration hash matches; otherwise it creates/reuses a stable provisioning key and prepares or reconciles the provider resource.
6. Only after all target capabilities are ready, one transaction sets the workflow's `active_version_id`, marks target bindings active, commits operation success, audit facts, and any follow-up cleanup intent.
7. Newly accepted documents snapshot the new active version. Existing executions retain their original version.
8. Previous managed bindings retire asynchronously. `cleanupRequired` remains true until confirmed removal; failure degrades health and alerts, but never rolls back a successful new cutover.

When replacing an active version, steps 2-5 leave the old active pointer and intake unchanged. A target validation/provisioning failure cleans or reconciles partial target resources and leaves the old version active.

Entry connectors must define a no-loss handover rule before supporting version replacement. Notifications from retired bindings cannot create new executions after cutover. A connector may use a bounded explicit `DRAINING` binding only when its provider cursor contract requires one post-cutover barrier; it is not a second active version and must end by a durable deadline. Any provider event gap is recovered by the connector's authoritative cursor/delta/reconciliation contract. Exact SharePoint semantics are defined by [`sharepoint-entry-v1.md`](sharepoint-entry-v1.md).

## Deactivation and cleanup flow

1. The API closes local intake atomically before returning.
2. Direct-upload sessions not yet created are rejected. Already issued upload capabilities follow the storage contract's expiry/completion rule and cannot bypass a closed gate or changed active version at completion.
3. Provider notifications are acknowledged safely but cannot create a document/execution through an inactive binding.
4. The worker removes or disables managed external resources using their stored stable identity.
5. Confirmed absence completes the operation and binding cleanup.
6. Ambiguous removal enters reconciliation; absence/delete is treated idempotently.
7. A final cleanup failure leaves the workflow inactive with `cleanupRequired=true` and an operator-safe recovery action.

Workflow archive is blocked while activation, unresolved provisioning, or
managed cleanup remains. API v1 archive retains workflow versions, accepted
executions, documents, operations, and audit history, so those retained
references do not block soft archive. Hard deletion remains unavailable pending
an explicit retention/product policy.

## Provider effect safety and recovery

Every managed provider-resource creation receives one random opaque provisioning key before the first call. The key and exact input hash survive RabbitMQ redelivery, worker restart, automatic retry, and operator reconciliation.

A managed connector must prove one of:

1. provider-side idempotency plus lookup by the same key; or
2. an adapter-owned authoritative lookup/deduplication/cleanup procedure that cannot create an unbounded duplicate set.

After a timeout, reset, ambiguous provider error, or worker loss during a possible write, the binding/operation enters reconciliation. The adapter checks by stable key or stored external identity before another create/delete. If the provider cannot support a safe contract, that connector capability is not production-eligible.

Retryable no-effect failures use bounded backoff and jitter. Provider throttling hints are honored. Permanent permission/configuration failures do not loop. Unresolved effects block conflicting activation until reconciled or explicitly remediated.

## Messaging and runtime placement

Provisioning uses one provider-neutral command:

```text
aiflow.workflow.provisioning.requested.v1
  data: { provisioningOperationId, expectedStateVersion }
```

It is routed to `aiflow.q.workflow.provisioning.v1`. The API publishes through the transactional outbox; consumers use the standard inbox, durable claim, acknowledgement, lease, retry, and DLQ rules.

The scheduler scans due retries, reconciliation, renewal, and cleanup records in bounded batches and emits the same command with a new message ID. It never performs provider work itself.

This adds a worker queue group, not a new service or image. API, provisioning worker, and scheduler remain roles of the same repository/image. Connector/provider/tenant concurrency and fairness are bounded independently of Kubernetes replica count.

## Connection changes and health

- Connection credential rotation does not create a workflow version. The next validation/provider call uses the updated approved secret reference.
- Disabling or revoking a connection prevents new provider calls but does not erase the active version or unresolved resource identity.
- An active workflow is never silently redirected to another connection, tenant, site, company, folder, destination, or provider.
- Renewal and health checks for managed bindings are durable scheduler work. Waiting consumes no worker lease or RabbitMQ delivery.
- An entry binding that can no longer guarantee safe intake becomes degraded and blocks that entry path according to its connector contract; accepted executions continue.
- A destination outage normally leaves the workflow definition active and is handled by execution retry/reconciliation policy rather than automatic deactivation.

## DevPortal UX compatibility

The existing workflow-table toggle remains recognizable:

- inactive + activate click: send canonical `PUT`, show provisioning, poll the returned operation;
- active + new version activation: keep the current version visibly active while showing the target update;
- active + deactivate click: send canonical `DELETE`, show intake stopped immediately, then cleanup progress;
- failure: show the engine's safe message and allowed action without provider details;
- success: derive toggle state from `activeVersionId`/`acceptingNewDocuments`, not a browser-maintained boolean.

Phase 3 DevPortal calls AiFlow Engine through its same-origin Next.js BFF and
the platform API gateway. The BFF forwards the bearer token and canonical
permission. It does not forward `x-client-id`, call `devportal-backend` for
AiFlow activation, or create/activate an n8n workflow.

## Security and observability

- Reauthorize tenant/project/workflow/version and every referenced connection when accepting activation.
- Derive provider targets from stored validated bindings. Messages, resource labels, and user configuration cannot redirect a worker to an arbitrary URL.
- Acquire credentials just in time through approved references; never place them in workflows, operations, bindings, messages, logs, traces, Sentry, or API responses.
- Treat provider resource metadata and errors as untrusted confidential input; validate, bound, and allow-list before persistence/disclosure.
- Require security review for activation/resource-discovery authorization and any new OAuth/consent flow, provider callback, on-premises endpoint, managed external resource, credential, or network path.
- Record activation/deactivation actor, target/previous version, outcome, safe failure, correlation/causation IDs, and timestamps in append-only audit facts.

Safe metrics include operation count/duration/status/failure category, queue age, retries, reconciliation age, managed-resource health, renewals, cleanup backlog, and throttling by connector/capability. Tenant, workflow, connection, operation, and external resource IDs are trace/log fields, not metric labels.

Alerts cover stuck operations, reconciliation deadline, unresolved provider effects, renewal/cleanup failure, missing connector version, revoked permission, queue age, and cross-binding integrity conflicts.

## Required implementation evidence

1. Operation and outbox creation survive API termination before publication.
2. Repeated API requests and duplicate/out-of-order messages create one logical operation and one provider resource.
3. Cross-tenant workflow/version/connection/resource references fail without disclosing existence.
4. Live validation/provider calls never occur inside a database transaction or API request lifecycle.
5. Worker termination before, during, and after a possible provider write recovers by stable-key reconciliation.
6. A target activation failure leaves the previous active version accepting documents.
7. Successful cutover atomically changes the active pointer; documents before/after capture the correct immutable version.
8. Deactivation closes local intake immediately and cannot cancel accepted executions.
9. Expired upload capabilities, stale callbacks, and retired bindings cannot bypass the active-version gate.
10. Managed connector handover/reconciliation proves no missed source item and no duplicate execution across version replacement.
11. Cleanup/renewal failures are durable, visible, bounded, and operator-recoverable.
12. No provisioning path creates n8n resources, per-workflow infrastructure, or sends document/business data through RabbitMQ/PostgreSQL.
13. The demo UI can create, activate, poll, replace, deactivate, and display safe failures using only canonical APIs.
14. A custom template edit cannot change an existing workflow version; activation and execution load the frozen custom profile version without a live template-service lookup.

## Product and platform confirmations still required

- `PROV-01`: approve the operation polling UX, one-operation serialization, immediate local deactivation, active-version replacement, and cleanup-warning behavior.
- `PROV-02`: approve operation/provider deadlines, retry budgets, polling hints, admission limits, and per-connection/tenant provisioning concurrency.
- `PROV-03`: confirm descriptor/capability version rollout and how long old active connector versions remain installed during migration.
- `PROV-04`: confirm workflow archive/hard-delete policy and retained provisioning/audit history.
- `PROV-05`: for every `MANAGED` connector, prove provisioning-key uniqueness, authoritative lookup, renewal, removal, unknown-outcome recovery, and no-loss version handover.

SharePoint resource, subscription, callback, delta, permission, renewal, and handover details are defined by [`sharepoint-entry-v1.md`](sharepoint-entry-v1.md). They refine the managed adapter without changing this provider-neutral activation API or lifecycle.
