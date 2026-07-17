# Human Review Contract v1

Status: Phase 0B proposal for Phase 5 implementation.

This contract defines the provider-neutral human-review boundary for AiFlow Engine. It preserves the existing DevPortal review journey while moving canonical task state, authorization, idempotency, artifacts, and execution resumption out of n8n and the legacy runtime services.

## Repository evidence and recommendation

The current behavior was traced at these revisions:

- `devportal` `2fc93d8ba136`;
- `devportal-backend` `c546a2fdedf2`;
- `aiflow-trigger-handler` `7d5f9633af44`;
- `aiflow-webhook-processor` `85d2d46e78fd`;
- `aiflow-review-result` `e9b9e92d6e31`.

The current path is split across all five repositories:

1. `aiflow-trigger-handler` accepts a base64 document, stores the original in S3 when review is enabled, and records review headers with the execution.
2. `aiflow-webhook-processor` receives extraction results, calls the Review System `infosecure` and `collector` endpoints, sends the document again as base64, and stores the returned token and full review URL.
3. `devportal-backend` lists those stored review items and calls the Review System token-status endpoint.
4. DevPortal opens `/review?token=...`, calls the Review System item endpoint directly, and submits revised data to a workflow webhook using `x-aiflow-review-approved: true`.
5. `aiflow-review-result` accepts that body, looks up the plaintext token, writes through n8n, calls the Review System signature endpoint, and then deletes the S3 object and review row.

This behavior has several reliability and security gaps that must not be preserved:

- a trusted boolean header and a syntactically JWT-shaped token can drive approval without a proven engine authorization boundary;
- document bytes are repeatedly buffered and base64-encoded through application runtimes;
- plaintext review tokens and full capability URLs are stored and returned to the browser;
- no durable effect identity protects the destination write if the approval service crashes after n8n succeeds;
- review expiry is inconsistent: a request value is stored, while the collector call hard-codes another value;
- the visible flow has no durable rejection action;
- provider creation, callback authentication, idempotency, lookup, deletion, and retention guarantees are not established by the inspected code.

The Review System implementation was not present in the inspected workspace. Its observed endpoints are evidence of current calls, not a complete provider contract. Production integration therefore requires owner confirmation and sandbox contract tests; unknown provider behavior is never guessed.

## Fixed boundary

```text
MAP succeeds
  -> immutable MAPPING_RESULT in S3
  -> review_tasks row + review command in one transaction
  -> optional Review System presentation adapter
  -> existing DevPortal review page
  -> authenticated engine decision
       APPROVE -> immutable reviewed input -> DELIVER
       REJECT  -> terminal REJECTED
       EXPIRE  -> terminal FAILED/POLICY
```

- AiFlow Engine is the source of truth for the review task, its deadline, its single decision, the reviewer identity, and the execution transition.
- The immutable workflow version decides whether review is required. Request headers cannot enable, bypass, or approve review.
- Review occurs after `MAP`. The reviewer sees and, on approval, may revise the mapped destination input. The original extraction result remains immutable.
- The existing DevPortal review list and review page are retained. Their service calls and query identifier change locally; no second review frontend is built.
- The existing Review System, if retained, is behind a `ReviewPresentationPort`. It may present content or collect optional feedback, but it does not own engine execution state or authorize destination delivery.
- `aiflow-review-result` is retired. A review decision never calls n8n or a legacy workflow webhook.
- PostgreSQL stores bounded task metadata and S3 references only. Review input, revised values, source bytes, provider payloads, tokens, signatures, and capability URLs do not enter PostgreSQL or RabbitMQ.
- Waiting for a reviewer holds no worker lease, database transaction, or unacknowledged RabbitMQ delivery.
- Approval and destination delivery are separate effects. Approval commits the exact delivery input and creates/reuses the destination effect operation; the destination worker remains responsible for effective-once delivery.

## Workflow policy

The immutable workflow definition uses:

```json
{
  "reviewPolicy": {
    "required": true,
    "expiresAfterSeconds": 86400
  }
}
```

Rules:

- `expiresAfterSeconds` is required when `required` is `true` and omitted when it is `false`.
- The v1 engineering range is 60 seconds through 30 days. Product must select the initial UI default before implementation; the engine does not hide a default in runtime code.
- The review deadline starts when the task becomes `OPEN`, so provider-presentation outages do not consume the reviewer's allowed time.
- Provider preparation has its own bounded retry/reconciliation deadline. Exhausting it fails the execution as an integration failure rather than creating an invisible review task.
- Expiry always fails the execution with failure category `POLICY`. V1 has no auto-approve, auto-reject, or fallback destination behavior.
- Reviewer assignment, multi-step approval, quorum approval, delegation, comments, and SLA escalation are outside v1. Any authenticated actor with `aiflow.review.decide` and project/task access may decide an open task.
- Changing review policy creates a new workflow version and affects only documents accepted by that version.

Legacy `is_review` is translated during migration. A review-enabled legacy workflow must receive an explicit expiry selected by the migration policy; missing legacy values are not copied as an unbounded wait.

## Canonical artifacts

The successful `MAP` stage produces one immutable, schema-versioned `MAPPING_RESULT`. It is the review input and must already validate against the selected destination action schema.

The review page may load:

- safe task and document metadata from PostgreSQL;
- mapped values from the exact mapping artifact through an authenticated, size-bounded engine endpoint;
- the source document directly from S3 through a short-lived, read-only, exact-version capability issued only after task authorization;
- connector-owned field labels and validation metadata from the frozen destination action schema.

Document bytes never pass through the engine API, PostgreSQL, RabbitMQ, or Review System merely to render the DevPortal preview. The browser reads the exact source object directly from S3. Bucket, key, version, KMS configuration, and caller-supplied URLs are never accepted by the access endpoint.

An approval body may contain `revisedData` because it is bounded structured data, not document bytes. The API treats it as confidential input, validates it as a complete replacement against the frozen destination action schema, and writes it as an immutable `REVIEW_ARTIFACT`. It is never logged or stored in an idempotency response. A provider-specific patch format is not part of the core contract.

If `revisedData` is omitted, the approved delivery input is the existing `MAPPING_RESULT`; no duplicate S3 object is created. A rejection cannot contain revised data and creates no review artifact.

The delivery worker reads only the exact storage object selected by the committed decision. A reviewer cannot change the workflow version, destination connection/action, effect key, source object, tenant, project, or execution identity.

## Review task state

One `ReviewTask` belongs to one execution's `REVIEW` stage. Its public status is:

| Status      | Terminal | Meaning                                                                 |
| ----------- | -------- | ----------------------------------------------------------------------- |
| `PREPARING` | No       | The task exists; presentation creation or reconciliation is in progress |
| `OPEN`      | No       | Authorized reviewers may view and decide the task                       |
| `APPROVED`  | Yes      | One approval and its exact delivery input were committed                |
| `REJECTED`  | Yes      | One rejection was committed; destination delivery will never begin      |
| `EXPIRED`   | Yes      | The open deadline passed without a decision                             |
| `FAILED`    | Yes      | The review could not be made available because preparation failed       |

V1 does not reopen or cancel a task. Terminal review facts are immutable. A later correction/reprocess feature creates a new execution and task rather than rewriting the original decision.

Conceptual fields are:

| Field                                                             | Meaning                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `reviewTaskId`, `tenantId`, `projectId`                           | Opaque task identity and isolation boundary                            |
| `workflowId`, `workflowVersionId`, `executionId`, `reviewStageId` | Frozen workflow/execution association                                  |
| `status`, `stateVersion`                                          | Guarded task state                                                     |
| `inputStorageObjectId`, `inputSchemaVersion`, `inputHash`         | Exact immutable mapped input                                           |
| `presentationAdapterId`, `presentationAdapterVersion`             | Frozen presentation integration                                        |
| `submissionKey`, `externalTaskRef`, `externalCapabilityRef`       | Stable provider correlation; capability material stays outside the row |
| `nextAttemptAt`, `reconciliationDeadline`, `safeFailure`          | Bounded provider preparation/recovery state                            |
| `readyAt`, `expiresAt`                                            | Open-window timing                                                     |
| `decision`, `decisionStorageObjectId`, `decisionInputHash`        | Immutable approved/rejected result references                          |
| `decidedByType`, `decidedById`, `decidedAt`, `feedbackConsent`    | Audit-safe decision identity and consent                               |
| `providerCleanupStatus`, `providerCleanupDueAt`                   | Provider-copy close/deletion reconciliation                            |

`externalCapabilityRef` is an approved secret-manager reference, not a token or URL. If the provider cannot separate a safe external task ID from a bearer capability, its adapter is not production-eligible until that boundary is fixed or explicitly risk-accepted.

## Creation and presentation

When mapping succeeds and review is required, one PostgreSQL transaction:

1. commits the successful `MAP` output;
2. moves the execution to `AWAITING_REVIEW` and its `REVIEW` stage to `WAITING`;
3. creates the unique `PREPARING` review task with a random stable `submissionKey`;
4. inserts the review command, audit fact, and storage retention reference.

The review worker later claims only the short presentation operation. It loads the exact task and artifacts, calls the adapter outside the transaction, and then commits one guarded outcome:

- confirmed created: store only safe provider references, mark `OPEN`, set `readyAt`/`expiresAt`, and release the lease;
- confirmed not created after a retryable failure: persist a bounded retry time;
- unknown create outcome: keep `PREPARING` and reconcile by `submissionKey`; never call create blindly;
- permanent failure or exhausted reconciliation: mark the task `FAILED` and the execution `FAILED` with a safe integration failure.

An engine-native presentation adapter may open the task without copying content to another service. If the existing Review System is selected, it must satisfy the provider contract below. The core state machine does not change between adapters.

## Existing Review System adapter contract

The observed `infosecure`, `collector`, `item`, `signature`, and `token/status` calls do not prove the capabilities required for reliable production use. The Review System owner must confirm and contract-test:

1. authenticated service-to-service create, status, close, and delete operations;
2. stable create idempotency using the engine `submissionKey` and lookup by that key after a timeout;
3. a bounded safe provider task reference distinct from any bearer token;
4. short-lived presentation access that does not persist a long-lived token in a query string, browser storage, PostgreSQL, logs, or referrers;
5. exact payload, schema, MIME type, size, timeout, quota, rate-limit, and error contracts;
6. a streaming or exact-object-reference document path if the provider truly needs a copy;
7. signed, replay-resistant, uniquely identified callbacks if callbacks are used;
8. feedback/signature semantics and whether they are optional or required by a real consumer;
9. provider retention, expiry, deletion, deletion confirmation, and support ownership;
10. test/sandbox isolation and synthetic-data support.

The legacy JSON/base64 collector is not the medium-enterprise document path: it requires whole-document buffering, increases payload size, and duplicates confidential data. If the Review System cannot accept a bounded stream/object reference, the initial engine-native presentation keeps the document in AiFlow S3 and the existing DevPortal page renders it directly.

Provider signature or feedback completion is ancillary. It cannot authorize approval, block or undo an already committed engine decision, or cause destination delivery a second time. When feedback consent is false, the adapter sends no revised values for feedback. Provider cleanup/feedback failures are visible and retried separately without rewriting the execution outcome.

## Decision contract

The primary v1 decision boundary is the authenticated DevPortal call:

```http
POST /api/v1/review-tasks/:reviewTaskId/decisions
Authorization: Bearer <access-token>
Idempotency-Key: <client-generated-opaque-key>
Content-Type: application/json
```

Approval:

```json
{
  "decision": "APPROVE",
  "revisedData": {},
  "enableFeedback": false
}
```

Rejection:

```json
{
  "decision": "REJECT"
}
```

Rules:

- the bearer token supplies tenant and actor identity; task/project lookup plus `aiflow.review.decide` supplies authority;
- only `OPEN` and unexpired tasks accept a decision;
- the idempotency fingerprint covers task ID, decision, revised-data hash, and feedback flag, never the raw revised values;
- `revisedData` is a complete replacement, is allowed only for approval, and must pass the frozen destination schema and configured body/complexity limits;
- optional feedback defaults to false and is allowed only when the selected adapter advertises that capability;
- provider tokens, `meta`, redirect URLs, workflow endpoints, tenant IDs, actor IDs, and effect keys are not accepted;
- approval with no revision reuses the mapped artifact; approval with revision first creates an immutable candidate artifact, then atomically selects it;
- rejection and approval both commit once. Concurrent different decisions race on the same guarded task state; exactly one wins and the other receives `REVIEW_ALREADY_DECIDED`;
- an expired task is atomically changed to `EXPIRED` before returning `REVIEW_EXPIRED` when the scheduler has not yet scanned it;
- the response contains task/execution status and allowed navigation only. It never echoes revised data, a provider token, signature, or arbitrary redirect URL.

For approval, the final short transaction commits the task decision, reviewer audit fact, `REVIEW` stage output/success, execution transition to `DELIVERING`, destination operation/effect input, idempotency result, delivery outbox command, and provider cleanup intent together. A crash before that transaction cannot deliver; a crash after it is recovered from the durable outbox and cannot choose a second decision.

For rejection, the transaction commits the task decision, reviewer audit fact, `REVIEW` stage failure outcome, execution `REJECTED`, idempotency result, and provider cleanup intent together. No delivery operation or command exists.

An unused candidate review artifact from a failed/racing request remains a normal unreferenced storage reservation and is deleted by bounded storage reconciliation. It can never become delivery input without winning the guarded decision transaction.

## Optional provider callbacks

DevPortal decisions do not need a provider callback. If a retained Review System must originate decisions, the adapter exposes a provider-specific callback route and maps an authenticated provider event into the same decision use case.

- Authentication uses the provider's confirmed signed JWT, HMAC, mTLS, or one-time exchange contract. A requester string, token syntax check, URL value, or boolean header is insufficient.
- Tenant/project authority comes from the stored external task correlation, never the callback body.
- Callback events have a provider event ID and body hash, are size/time limited, and are stored as bounded deduplication metadata without revised values or raw bodies.
- Revised values are validated and written to S3 before the guarded decision transaction.
- Duplicate, stale, terminal, expired, and conflicting callbacks are acknowledged safely without repeating delivery.
- A provider without a stable event ID, replay window, rotation procedure, and retry contract is not callback-eligible.

## API projection for DevPortal

| Method and path                                         | Purpose                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/v1/workflows/:workflowId/review-tasks`        | Cursor-list authorized tasks by status without content or capabilities |
| `GET /api/v1/review-tasks/:reviewTaskId`                | Get authorized task metadata, state, and server-derived actions        |
| `GET /api/v1/review-tasks/:reviewTaskId/content`        | Load bounded mapped review data and frozen field/schema metadata       |
| `POST /api/v1/review-tasks/:reviewTaskId/source-access` | Issue a short-lived exact-version read capability for document preview |
| `POST /api/v1/review-tasks/:reviewTaskId/decisions`     | Commit one authenticated, idempotent approval or rejection             |

The list/detail projection includes opaque IDs, safe filename/content type/size, workflow display name, status, ready/expiry/decision timestamps, safe failure, and `allowedActions`. It excludes mapped values, document URLs, object locations, provider tokens/URLs, reviewer tokens, and provider payloads.

`allowedActions` is server-derived and initially contains `VIEW`, `APPROVE`, and `REJECT` only when authorized and valid for the current status. The UI does not infer authority from status.

The content endpoint returns confidential mapped values only after the same authorization as task view. It is no-store, size-bounded, schema-validated, and never cached or logged by the engine/gateway. The source-access endpoint authorizes the exact task-to-document relation, emits an audit event, and returns an operation-specific, short-lived, read-only capability. Browser CORS and content disposition are server-controlled.

Stable errors include `REVIEW_NOT_FOUND`, `REVIEW_NOT_OPEN`, `REVIEW_EXPIRED`, `REVIEW_ALREADY_DECIDED`, `REVIEW_REVISION_INVALID`, `REVIEW_CONTENT_TOO_LARGE`, and the common authorization/idempotency errors.

## DevPortal compatibility

The page layout and navigation remain familiar, but its trust boundary changes:

| Current UI behavior                                               | Target localized change                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| List through `devportal-backend` review-item table                | Query the engine workflow review-task list with the normal bearer token |
| Open `/review?token=...&aiflow=...&webhook=...`                   | Open `/review?reviewTaskId=<opaque-id>`                                 |
| Load base64 document/data directly from Review System             | Load engine content and direct-S3 preview capability                    |
| Decode provider JWT in the browser                                | Use server-projected safe metadata; never decode a provider credential  |
| Approve by trusted headers on a workflow webhook                  | Call the engine decision endpoint with bearer token and idempotency key |
| Return provider signature and revised values through redirect URL | Return to the review/execution page using opaque IDs and current status |
| Cancel only exits edit mode                                       | Keep navigation cancel; expose an explicit durable Reject action        |

The migration does not move an in-flight legacy token into the new engine. Old open review items remain on the legacy path until decided, expired, or explicitly drained. New engine executions create only engine review tasks. Cutover inventory must identify external consumers of legacy `review_full_url`, signature, and redirect behavior before those routes are retired.

## Retry, recovery, and expiry

- RabbitMQ redelivery before a durable claim is transport recovery; it is not another review task.
- A provider create timeout enters reconciliation by `submissionKey`. No blind second create is allowed.
- Presentation retry remains bounded inside the same task. Exhaustion moves task/execution to `FAILED`.
- The scheduler scans due preparation/reconciliation, open expiry, provider cleanup, and abandoned candidate artifacts in tenant-fair bounded batches.
- Expiry uses a guarded database-time comparison. A decision and expiry racing each other can commit only one terminal outcome.
- `REJECTED`, `APPROVED`, and `EXPIRED` tasks are never automatically reopened or replayed.
- A manual retry after review preparation failure or expiry may create a new execution/task only when the execution API exposes `RETRY`; it may reuse the checksum-verified mapping artifact.
- A delivery-stage retry after approval reuses the immutable approved review artifact and destination effect key. It does not ask for approval again.
- A rejected execution has no v1 retry action. A future correction/reprocess contract must create a new auditable run.

## Persistence and constraints

Phase 5 adds provider-neutral `review_tasks` and, only when provider callbacks are enabled, `review_callback_events`.

Required constraints include:

- unique `(tenant_id, execution_id)` for the one v1 review task per execution;
- unique `(tenant_id, execution_stage_id)` for its stage association;
- globally unique random `submission_key`;
- unique safe provider task reference within adapter/account when present;
- unique `(adapter_id, provider_account_ref, provider_event_id)` for callbacks;
- tenant-scoped composite foreign keys to workflow, version, execution, stage, storage objects, and connection/account records;
- guarded `state_version` updates and terminal-state immutability.

Review content, revised values, provider bodies, full URLs, tokens, signatures, and secret-manager values are forbidden in these rows. Callback rows store only safe allow-listed event metadata, authentication outcome, body hash, and handling outcome.

Known access paths are project/workflow review lists ordered by `(created_at, id)`, open-expiry scans ordered by `(expires_at, id)`, preparation/reconciliation scans ordered by `(next_attempt_at, id)`, and provider-cleanup scans ordered by `(provider_cleanup_due_at, id)`. Indexes are introduced with the Phase 5 migration, not before the tables are used.

## Messaging and scaling

- `aiflow.execution.stage.review.requested.v1` wakes review creation or reconciliation using only `executionId`, `stage`, and `expectedStateVersion`.
- `aiflow.review.provider-copy.delete.requested.v1` wakes close/deletion reconciliation using only `reviewTaskId` and `expectedStateVersion`.
- Decisions do not carry revised values through RabbitMQ. Their final transaction publishes the existing destination command with identifiers only.
- Review workers scale independently through `aiflow.q.stage.review.v1`; this remains one role of the same repository/image, not a new service.
- Concurrency is bounded per adapter/account and globally, with tenant-fair claims and provider `Retry-After` handling.
- Review list APIs use cursor pagination; task content and source access are lazy and never included in lists.
- No worker, HTTP request, database transaction, or broker delivery remains open while a human reviews a document.

## Retention and deletion

- An active review reference blocks deletion of its source, mapping input, and approved output.
- Engine source and derived artifacts become eligible under the storage contract after the last execution/retry-chain/review reference is terminal.
- Provider presentation copies are tracked separately. Engine S3 deletion never claims a provider copy was removed.
- Terminal decision metadata follows execution/audit retention; revised values remain only in the approved S3 artifact under object retention.
- Provider close/deletion is durable, retryable, auditable, and reconciled to confirmed absence when the provider supports it.
- A provider with no deletion/retention contract requires explicit product/security acceptance before tenant documents may be copied to it.
- Logs, traces, Sentry, metrics, audit metadata, and DLQs never contain review values, source content, provider tokens, capability URLs, signatures, or raw callback/provider bodies.

## Security boundary

- Task list, metadata, content, source access, and decisions all require validated bearer authentication and exact tenant/project/task authorization.
- Provider presentation access is not engine decision authority. Possession of a provider URL or token cannot resume an execution.
- Presigned source reads are exact-version, short-lived, read-only, HTTPS-only, unlogged, and issued only for currently authorized task/document pairs.
- Arbitrary redirect URLs are not accepted. DevPortal navigation uses configured same-origin routes and opaque resource IDs.
- Review API bodies, content endpoints, callbacks, and provider responses have strict byte, depth, field, array, timeout, and concurrency limits.
- Provider endpoints use allow-listed configuration, TLS, workload credentials, and egress controls; workflow data cannot choose an arbitrary URL.
- Audit records cover view capability issuance, decision attempt/outcome, expiry, provider creation/reconciliation, and provider cleanup without confidential values.
- Implementation requires the security review mandated by [`SECURITY.md`](../../SECURITY.md), specifically covering authorization, source download, browser exposure, callbacks, provider copies, retention, and deletion.

## Observability

Metrics use adapter/status/failure-class labels, never tenant IDs, filenames, values, task IDs, or provider tokens. Initial measures include:

- tasks preparing/open/expired/failed and oldest open age;
- presentation create/reconcile latency and unknown outcomes;
- decision success/conflict/expired/invalid counts;
- time from open to decision;
- provider callback authentication/deduplication failures when enabled;
- provider cleanup backlog/age;
- source-access issuance failures and content-limit rejections;
- review queue depth/age, lease recovery, and per-adapter throttling.

Safe structured logs correlate by opaque correlation/execution/task identifiers and error code. Dashboards alert on preparation failures, expiry spikes, growing open/cleanup backlog, callback authentication failures, and stalled review commands.

## Required acceptance cases

1. A mapping success creates exactly one review task and command atomically.
2. Waiting for a reviewer holds no lease, worker, HTTP request, or RabbitMQ delivery.
3. Duplicate/stale review commands cannot create a second task or provider presentation.
4. A provider-create timeout reconciles by the stable submission key before any retry.
5. Tenant/project authorization prevents list, content, preview, and decision access across tenants.
6. Source preview reads directly from the exact S3 version and never passes document bytes through the API.
7. Approval with valid revised data commits one immutable artifact and one delivery intent.
8. Invalid/oversized revised data cannot alter task or execution state.
9. Concurrent approve/reject requests commit exactly one decision; retries with the same idempotency key return the same result.
10. A crash before decision commit cannot deliver; a crash after commit is recovered through the outbox without another decision/effect.
11. Duplicate authenticated callbacks, when enabled, cannot resume an execution twice.
12. Expiry racing with a decision commits one terminal outcome using database time.
13. Rejection creates no delivery operation; delivery retry after approval reuses the exact approved artifact/effect key.
14. Provider cleanup is retryable and cannot rewrite the review/execution decision.
15. Logs, audit metadata, messages, database rows, and error bodies contain no confidential review values or capabilities.
16. DevPortal contract tests cover list, open, content, preview, approve, reject, expiry, conflict, and return navigation without legacy tokens/headers.

## Required confirmations before Phase 5 implementation

- `REVIEW-01` Product: select the v1 expiry default within the fixed range and confirm whether explicit rejection is enabled in the first DevPortal release.
- `REVIEW-02` Auth/Product: confirm which platform roles receive `aiflow.review.read` and `aiflow.review.decide`, and whether project membership alone is sufficient.
- `REVIEW-03` Review System owner: provide the exact deployed API/auth/schema/limit/error/retry contract and sandbox for all observed endpoints.
- `REVIEW-04` Review System owner: prove create idempotency plus lookup by engine submission key, or approve engine-native presentation for v1.
- `REVIEW-05` Review System owner/Security: confirm short-lived presentation access, callback signing/replay rules if used, credential rotation, and token handling.
- `REVIEW-06` Product/Review System owner: define whether signature and feedback have a required consumer; remove them from the critical path if they do not.
- `REVIEW-07` Security/Provider owner: confirm whether any provider document copy is necessary and, if so, its streaming/object-reference, retention, and deletion contract.
- `REVIEW-08` Platform/Security: confirm API/gateway structured-data limits, source-read capability TTL, S3 browser CORS/content-disposition policy, rate limits, egress, and security-review owner.
- `REVIEW-09` Product/Operations: inventory external consumers of legacy review URLs, redirects, signatures, and open tasks; define drain/cutover ownership.

No production Review System adapter, public review callback, source-download endpoint, or legacy route retirement proceeds until its applicable confirmation is recorded.
