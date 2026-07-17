# External OCR Contract v1

Status: Phase 0B proposal for Phase 2 implementation.

This contract defines how AiFlow Engine submits a staged document to a third-party OCR/extraction capability, waits without holding a worker, authenticates provider notifications, reconciles uncertain outcomes, and commits one canonical extraction artifact. The OCR product itself remains outside this repository.

## Boundary and fixed decisions

- Core execution uses the canonical `EXTRACT` stage and does not know an OCR vendor, SDK, endpoint, or payload shape.
- `packages/extraction` owns the application use cases and the provider-neutral port. A provider adapter translates the selected extraction profile to one external API.
- PostgreSQL is authoritative for request, attempt, wait, retry, and completion state.
- The exact staged source version is read from S3 and streamed to the provider over TLS; document bytes never enter PostgreSQL, RabbitMQ, logs, traces, Sentry, or metrics.
- The worker never holds a database transaction while transferring bytes or calling a provider.
- Long-running provider work becomes durable `WAITING` state with no worker lease or unacknowledged RabbitMQ delivery.
- A callback is an authenticated wake-up hint. The worker confirms status and fetches the result from the provider before changing execution state.
- Provider payloads are untrusted input. An adapter must normalize and validate them before the engine accepts a canonical artifact.
- Extracted values live in an immutable encrypted `EXTRACTION_RESULT` object, not PostgreSQL or RabbitMQ.
- Provider credentials are external secret references. They never appear in a workflow definition, request row, message, callback URL, or log.
- The engine does not automatically fail over to another OCR provider because models and output semantics are not interchangeable. A provider/profile change requires an explicit workflow-version or recovery decision.

The provider-neutral lifecycle is defined by the [execution contract](execution-lifecycle.md), and source/result object behavior is defined by the [storage contract](storage-v1.md).

## Required provider capabilities

An OCR provider is compatible only when its adapter can prove all of these capabilities:

1. Submit a bounded document and return either a completed result or an accepted operation.
2. Receive an opaque engine `submissionKey` as an idempotency/client-request value, or find an existing operation by that value after an uncertain submit outcome.
3. Inspect an accepted operation until it reaches a documented terminal state.
4. Fetch the terminal result independently of callback delivery.
5. Distinguish pending, succeeded, failed, throttled, unauthorized, and not-found outcomes.
6. Document authentication, quotas, maximum document/result size, page limit, timeout behavior, retention, data residency, and deletion capability.
7. Authenticate callbacks when callbacks are offered. Poll-only providers are acceptable when the reconciliation capability and latency target are sufficient.

A provider that only accepts a non-idempotent create call and cannot look up by the engine request key is not safe for this contract. A crash after external acceptance but before local persistence would otherwise make duplicate submission unavoidable.

Result-bearing callbacks are not part of v1. If a candidate provider cannot expose a notification-only callback plus result-retrieval API, its adapter needs a separate security and storage contract before adoption; raw extracted data must not be smuggled through the notification path.

## Extraction profiles

`ExtractionProfile` is the user-facing, provider-neutral catalog resource. A profile version fixes:

- stable `profileId` and immutable `profileVersionId`;
- display metadata for DevPortal;
- accepted MIME types, maximum bytes/pages, and profile configuration schema;
- canonical output JSON Schema and stable source-field paths;
- confidence/warning rules used by mapping or review policy;
- adapter ID and provider model/version reference held in server-side configuration;
- retry, timeout, reconciliation, and quota policy;
- credential/account scope and approved Region/data-residency class.

The public workflow definition continues to contain `extraction.profileId` and bounded profile configuration. When an immutable workflow version is created, the engine resolves and freezes the exact compatible `profileVersionId`. A later model, schema, or provider change creates a new profile version and does not change accepted executions.

Provider model names, endpoints, account IDs, credentials, and callback secrets are not exposed through the profile API. The profile output schema—not a provider response—is the contract used by mappings and the temporary demo UI.

## Application port

The initial application boundary needs only these behaviors:

```ts
interface ExtractionProviderPort {
  submit(
    input: ExtractionSubmission,
  ): Promise<
    | { status: 'ACCEPTED'; providerOperationRef: string }
    | { status: 'COMPLETED'; providerOperationRef: string }
  >;

  inspect(
    input: ExtractionOperationLookup,
  ): Promise<
    | { status: 'PENDING'; retryAfter?: Date }
    | { status: 'SUCCEEDED' }
    | { status: 'FAILED'; failure: SafeProviderFailure }
    | { status: 'NOT_FOUND' }
  >;

  fetchResult(input: ExtractionOperationLookup): Promise<ProviderResultStream>;
  deleteProviderCopy?(
    input: ExtractionOperationLookup,
  ): Promise<ProviderDeletionResult>;
}
```

The exact TypeScript types arrive with Phase 2. This contract fixes behavior, not method spelling. The adapter may combine inspect/result calls internally when a provider API does so, but the application still observes the states above.

The source passed to `submit` is a bounded stream for the exact accepted S3 version. An adapter may use a provider pull URL only when the provider contract requires it and Security approves the additional bearer capability. Such a URL is read-only, short-lived, exact-version scoped, created just in time, and never persisted or logged.

## Durable request record

`packages/extraction` owns one `extraction_requests` row for each `EXTRACT` stage attempt and append-only `extraction_callback_events` rows for authenticated notification deduplication.

Conceptual fields:

| Field                                          | Meaning                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `extractionRequestId`                          | Engine UUID and opaque provider `submissionKey`                         |
| `tenantId`, `projectId`                        | Mandatory ownership boundary                                            |
| `executionId`, `stageAttemptId`                | Owning execution and unique extraction attempt                          |
| `profileVersionId`, `adapterId`                | Frozen provider-neutral profile and selected server adapter             |
| `status`, `stateVersion`                       | Guarded durable request lifecycle                                       |
| `providerOperationRef`                         | Bounded non-secret provider reference, when known                       |
| `providerAccountRef`                           | Server-side safe account/configuration reference, never credential data |
| `callbackCorrelationId`                        | Random opaque correlation value, not authorization                      |
| `nextCheckAt`, `deadlineAt`                    | Durable reconciliation schedule and final deadline                      |
| `resultStorageObjectId`, `resultSchemaVersion` | Reserved canonical result; attached as output after guarded completion  |
| `lastSafeStatus`, `failureCode`                | Allow-listed operational projection                                     |
| `submittedAt`, `completedAt`                   | Lifecycle timing                                                        |
| `providerDeletionStatus`, `providerDeletedAt`  | Provider-copy cleanup tracking when supported                           |

`(tenant_id, stage_attempt_id)` is unique. The provider operation reference is unique within its adapter/account when present. The engine never searches an operation using a tenant hint from a callback.

Request status is limited to:

| Status             | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `SUBMITTING`       | Durable key exists; submit may be in flight/uncertain and must reconcile |
| `ACCEPTED`         | Provider operation is known or recoverable; stage is normally waiting    |
| `RESULT_AVAILABLE` | Notification/inspection says a result may be fetched                     |
| `COMPLETED`        | Canonical extraction artifact and stage transition committed             |
| `FAILED`           | Provider outcome or policy permanently ended this request                |

Transport attempts and provider status observations do not create extra business states. A retry after a confirmed failed operation creates a new stage attempt and a new extraction request; history is never overwritten.

## Submit flow

1. The extract worker loads the trusted tenant-scoped execution, immutable workflow/profile version, document, and exact source storage object.
2. It atomically claims the eligible stage lease and creates the stage attempt, `SUBMITTING` extraction request, and reserved `EXTRACTION_RESULT` storage object before any provider call.
3. It verifies the exact S3 version, checksum, content signature, and full-content SHA-256. If a multipart browser upload has only an unverified client full digest, the worker completes one bounded verification pass and guarded metadata update before provider transfer.
4. It reopens the exact verified S3 version, and the adapter applies the shared provider/tenant quota gate and streams it with bounded memory using `extractionRequestId` as the stable `submissionKey`.
5. On accepted/completed response, it stores the bounded provider operation reference and releases the lease into `WAITING` or immediately continues to result retrieval.
6. On an uncertain submit outcome, it leaves the same request `SUBMITTING`, releases into reconciliation, and looks up by `submissionKey` or safely repeats the provider-idempotent submit with the same key.

An expired worker lease while a request is `SUBMITTING` is always treated as an uncertain external outcome, even when the worker may have crashed before making the call. Recovery reconciles the stable key before any resubmission.

The source object does not become a second local copy. Provider HTTPS transfer is necessarily external traffic; S3-to-worker reads use the approved private AWS path where available.

If the provider rejects the document before acceptance with a confirmed retryable response, the attempt follows the normal bounded stage retry policy. Authentication/configuration errors, unsupported format, excessive pages, corrupt content, and schema/profile incompatibility are permanent until an explicit recovery action changes the input or configuration.

## Callback contract

Provider callbacks use a separate public trust boundary:

```text
POST /provider-callbacks/v1/extraction/:adapterId
```

The callback endpoint is not an end-user canonical API and does not accept bearer user identity, tenant headers, project IDs, presigned URLs, or document/result payloads.

Each adapter declares one approved authentication mechanism based on actual provider support:

- signed HMAC over the raw request bytes plus timestamp/event ID;
- signed JWT with fixed issuer, audience, algorithms, expiry, and replay identity; or
- mTLS identity established by the approved gateway/runtime boundary.

IP allowlisting is defense in depth, never callback authentication by itself. Secrets/keys support overlap during rotation. A query-string secret, undocumented shared boolean header, or callback correlation ID alone is forbidden.

Processing order:

1. Enforce TLS, method/content type, a small provider-specific body limit, and request timeout.
2. Select only configured adapter/key metadata; callback input cannot choose an endpoint or secret reference.
3. Authenticate the exact raw body before normal JSON parsing where the signature scheme requires it.
4. Enforce the provider timestamp/replay window and extract a stable provider event ID.
5. Resolve the request through stored adapter/account/correlation or operation references, then derive tenant/project from that row.
6. In one short transaction, insert a provider-event inbox record with body hash and safe status, move `nextCheckAt` forward when valid, and create the existing extraction reconciliation outbox command.
7. Return the provider-required success status only after durable acceptance. Database/authentication failure returns a retryable non-success response according to provider behavior.

`(adapter_id, provider_account_ref, provider_event_id)` is unique. Repeating the same authenticated event/body returns success without a second outbox effect. Reuse of an event ID with a different body hash is rejected and alerted. Authenticated stale/out-of-order events are recorded safely and acknowledged without reversing state.

Callback responses contain no execution, tenant, document, profile, or provider-operation details. Callback bodies are not stored or logged; only an allow-listed event type/status, event ID hash/reference, body hash, timing, authentication outcome, and correlation ID are retained.

The initial target is to acknowledge a valid durable notification within five seconds. Slow provider inspection, result retrieval, S3 writing, and state transition always happen in a worker.

## Polling and reconciliation

Correctness never depends on callback delivery. The scheduler scans due `SUBMITTING`/`ACCEPTED`/`RESULT_AVAILABLE` requests and creates `aiflow.execution.stage.reconcile.requested.v1` through the transactional outbox. The existing stage-reconciliation queue handles the command; no OCR-specific reconciliation topology is required.

The worker claims a short stage lease and calls `inspect` using the persisted provider reference or submission key:

| Observation                           | Durable action                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Pending before deadline               | Release lease, persist provider `Retry-After` or bounded next check                 |
| Succeeded                             | Mark result available and fetch canonical result                                    |
| Confirmed provider failure            | Classify safe failure; retry only when policy and operation semantics allow         |
| Not found after uncertain submit      | Reconcile by submission key; retry submit only if provider idempotency proves safe  |
| Unauthorized                          | Fail configuration/authentication; alert; never retry with the same rejected secret |
| Throttled                             | Persist bounded jitter plus `Retry-After`; consume no worker/broker wait            |
| Unknown until reconciliation deadline | End the stage with `UNKNOWN_OUTCOME`; require operator-safe recovery                |

Callbacks can reduce latency by setting a request due immediately, but cannot mark extraction successful. Duplicate scheduler scans, callback notifications, messages, or inspections converge through request `stateVersion`, stage lease, and provider-event uniqueness.

## Result normalization and artifact

After confirmed provider success, the worker fetches the result over TLS with strict response status, content type, size, idle, and total time limits. Redirects are disabled unless an adapter has an approved allowlist and credential-forwarding policy. Endpoints come only from trusted configuration to prevent server-side request forgery.

The adapter validates the provider response and produces the provider-neutral envelope defined by [`extraction-result.v1.schema.json`](schemas/extraction-result.v1.schema.json):

```json
{
  "schemaVersion": 1,
  "profile": {
    "profileId": "general-invoice",
    "profileVersionId": "profile-version-id"
  },
  "source": {
    "contentSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sizeBytes": 1048576
  },
  "pageCount": 2,
  "data": {
    "invoice_number": "INV-1001",
    "total": 1250.5
  },
  "confidence": [
    { "path": "/invoice_number", "score": 0.99 },
    { "path": "/total", "score": 0.94 }
  ],
  "warnings": []
}
```

Rules:

- `data` must also validate against the exact output JSON Schema frozen by `profileVersionId`.
- Mapping source fields resolve against stable profile paths; provider property names never become an accidental public contract.
- The source digest and size must match the accepted document, and page count must remain inside the profile/product limit.
- Confidence is optional per field but, when present, is finite and within `0..1`. Missing confidence is not silently treated as `1`.
- Warnings use stable allow-listed codes and JSON Pointer paths; raw provider messages and extracted values are not copied into warning text.
- JSON keys, strings, arrays, nesting, numeric forms, and total normalized bytes are bounded before artifact acceptance.
- Raw provider payloads are not retained by default. A support/compliance requirement to retain them needs an explicit encrypted artifact kind, access policy, and shorter retention decision.

The normalized JSON is streamed or bounded-serialized to the reserved `EXTRACTION_RESULT` object with the storage contract's conditional write and checksum rules. It never passes through RabbitMQ or a PostgreSQL JSON field.

## Atomic completion

After the exact result object is verified, one guarded PostgreSQL transaction:

1. verifies tenant, execution/stage, active lease, stage/request `stateVersion`, and immutable profile version;
2. marks the result storage object `AVAILABLE`;
3. attaches the result storage object and schema version to the extraction stage attempt;
4. marks the extraction request `COMPLETED` and attempt `SUCCEEDED`;
5. moves the stage to `SUCCEEDED` and execution to `MAPPING`;
6. creates the mapping command through the outbox and records safe audit facts.

If S3 write succeeds but the transaction fails or the lease is lost, the object remains reserved and cannot be attached by a stale worker. Reconciliation may verify and commit the same reserved object under a new lease, or storage retention deletes it. It is never reused by another execution.

A duplicate callback, fetch, or completion observes the committed request and returns without creating another artifact or mapping command.

## Quotas, timeouts, and retries

Limits are profile/provider configuration, not caller input. The initial test values are proposals until the selected provider confirms its contract:

| Control                             | Proposed starting value                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| Source limit                        | Platform limit: 100 MiB and 500 pages, profile may be lower |
| Callback notification body          | 256 KiB hard maximum                                        |
| Normalized extraction artifact      | 64 MiB hard maximum                                         |
| Provider connect timeout            | 5 seconds                                                   |
| Submit/fetch idle timeout           | 30 seconds                                                  |
| Submit/fetch total transfer timeout | 5 minutes                                                   |
| Inspect request timeout             | 30 seconds                                                  |
| Callback durable acknowledgement    | 5-second target                                             |
| Initial operation deadline          | 30 minutes                                                  |
| Initial automatic stage attempts    | 3, subject to provider-safe semantics                       |

The provider adapter enforces shared account/global, per-tenant, and per-profile admission limits across worker replicas. Kubernetes autoscaling cannot bypass provider quotas. When capacity is unavailable, the stage persists `RETRY_SCHEDULED`/`nextAttemptAt`; it does not hold a worker or RabbitMQ delivery.

The shared limiter is coordination, not execution truth. Its Phase 2 implementation may use the existing approved Redis capability, but losing Redis cannot mark work complete, lose a request, or replace PostgreSQL due times and guards.

Retry classification:

| Condition                                                  | Category/behavior                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Local admission limit or provider `429`                    | `TRANSIENT`; honor bounded `Retry-After` and jitter                         |
| Confirmed pre-acceptance network/`408`/eligible `5xx`      | `TRANSIENT`; new attempt after persisted due time                           |
| Timeout/reset where acceptance is unknown                  | `UNKNOWN_OUTCOME`; reconcile by stable submission key before retry          |
| Provider pending beyond ordinary SLA but before deadline   | Continue bounded reconciliation; no new provider job                        |
| Invalid credential/account/permission                      | `PERMANENT` configuration failure and alert                                 |
| Unsupported/corrupt/oversized document or profile mismatch | `PERMANENT`; safe user-visible failure code                                 |
| Invalid/oversized result or checksum/source mismatch       | `PERMANENT` integrity/schema failure and security/operations alert          |
| Provider operation unresolved at final deadline            | `UNKNOWN_OUTCOME`; fail with operator `RECONCILE`, never blind resubmission |

Transport-library retries are limited to clearly idempotent reads or a submit carrying demonstrated provider idempotency. Business retries always remain durable execution attempts.

## Provider retention and deletion

AiFlow's source and canonical extraction objects follow [`storage-v1.md`](storage-v1.md). Provider copies have a separate lifecycle because deleting S3 does not delete provider data.

- Prefer providers that do not train on customer data and that delete transient input/results immediately or expose a deletion API.
- When deletion is supported, create `aiflow.extraction.provider-copy.delete.requested.v1` through the result transaction's outbox unless an approved support policy requires a short retention window.
- Track safe deletion status and retry it durably; provider deletion failure does not erase the already committed extraction result but creates an operations/security alert.
- When deletion is not supported, the selected provider contract must state its maximum automatic retention, backup behavior, residency, subprocessors, and contractual deletion guarantee before production use.
- Provider metadata tombstones may follow the one-year execution/audit window, but they contain no document bytes, extracted values, raw payloads, credentials, or callback bodies.

Security/Product approval is required for provider training use, cross-region transfer, legal hold behavior, or retention longer than the engine's approved source/artifact policy.

## Security and disclosure

- Provider base URLs, callback issuers/audiences, allowed algorithms, mTLS roots, and secret references are deployment configuration, never workflow/callback input.
- TLS certificate verification is mandatory. Provider endpoints and redirects use an explicit allowlist; private/link-local/metadata destinations are forbidden.
- Credentials use the existing approved secret manager and workload/service identity path, support rotation, and are scoped per environment/account.
- Callback verification uses raw-body size limits, constant-time comparison where applicable, replay protection, and fail-closed parsing.
- Tenant/project authority always comes from the stored extraction request and execution, never provider-supplied tenant data.
- Provider errors are mapped to stable codes. Raw body, URLs with tokens, headers, extracted values, filenames, and document content are never logged or sent to Sentry.
- Operator views show safe request ID, adapter/profile, state, attempt, timing, failure code, and reconciliation/deletion action; provider credentials and extracted data require no default operator access.

This contract changes callback authentication and external document transfer, so its implementation requires the security review mandated by [`SECURITY.md`](../../SECURITY.md).

## Observability and scaling

Safe metrics include:

- requests submitted/accepted/completed/failed by adapter/profile and safe failure category;
- submit, provider-processing, callback-lag, fetch, normalization, and end-to-end extraction duration;
- active/due/overdue requests, reconciliation count, retry count, and unknown outcomes;
- throttling/admission delay, provider quota usage where exposed, callback authentication/replay failures;
- source/result bytes and pages in bounded histograms;
- provider-copy deletion due/succeeded/failed.

Tenant, execution, request, provider-operation, document, and callback-event IDs are high-cardinality trace/log correlation values, not metric labels. Extracted field names/values, filenames, URLs, and raw provider status text are not telemetry.

Extraction workers scale independently through the existing `--queues=extract` role. Scaling is bounded by provider/account admission, tenant fairness, S3/provider bandwidth, CPU/memory needed for normalization, and PostgreSQL connection budget—not queue depth alone.

Alerts cover sustained provider failure/throttling, callback authentication spikes, operations beyond deadline, result integrity/schema failures, reconciliation backlog, and provider deletion backlog. Third-party outage is reported separately from engine availability.

## Local development and contract tests

Phase 0B adds no OCR SDK or runtime dependency.

Phase 2 provides a small fake extraction adapter/server for deterministic tests. It implements the same port and can simulate accepted/completed operations, callbacks, polling, throttling, malformed/oversized results, timeouts, duplicate events, stale events, uncertain submission, and provider deletion. Synthetic documents/results only are used.

The shared adapter contract suite must also run against the selected provider sandbox before production approval. A fake proves engine behavior but cannot prove provider idempotency, callback signing, event ordering, quotas, retention, deletion, or regional routing.

## Required implementation evidence

1. The exact staged document version is streamed to the configured provider without entering PostgreSQL, RabbitMQ, logs, or temporary disk.
2. Worker termination before, during, and immediately after submit cannot lose an accepted operation or create an uncontrolled duplicate.
3. Waiting and retry delays hold no worker lease, database transaction, or RabbitMQ delivery.
4. Missing callbacks still complete through polling/reconciliation.
5. Duplicate, stale, reordered, forged, expired, and body-conflicting callbacks cannot repeat or reverse a transition.
6. Callback tenant/project hints cannot access or mutate another tenant's request.
7. Provider throttling and global/per-tenant admission remain bounded with multiple worker replicas and at least 100 active tenants.
8. Malformed, oversized, wrong-profile, wrong-source, or over-page-limit results never become available artifacts.
9. A valid canonical result is committed once with one mapping outbox command, including after S3 success/database failure or worker lease loss.
10. RabbitMQ, PostgreSQL, logs, traces, metrics, Sentry, and DLQ tooling contain no document bytes, extracted values, credentials, callbacks, or presigned URLs.
11. Provider-copy deletion or documented automatic expiry is auditable and retryable.
12. Provider sandbox evidence proves authentication, idempotency/correlation, status/result reconciliation, quotas, and retention behavior.

## Provider and product confirmations still required

- `OCR-01`: provider/product/API version, supported Regions, endpoints, authentication, SDK/HTTP protocol, and sandbox.
- `OCR-02`: submission idempotency/client correlation, operation lookup/status/result contract, terminal states, and event ordering.
- `OCR-03`: callback availability, exact signing/JWT/mTLS scheme, raw-body rules, replay window, event identity, retry schedule, and required response.
- `OCR-04`: provider/account quotas, concurrency, document MIME/byte/page limits, result limit, latency/SLA, `Retry-After`, and pricing units.
- `OCR-05`: credential ownership/scope, network allowlist/private connectivity, secret rotation, provider status/support/escalation path.
- `OCR-06`: retention/deletion API, backups, data residency, subprocessors, training/data-use terms, DPA, and incident notification.
- `PRODUCT-02`: initial extraction profiles, immutable output schemas/field paths, confidence/review rules, and acceptable normalization limit.

These inputs select and configure an adapter. They do not change the engine execution states, durable reconciliation model, storage boundary, or canonical extraction-result envelope.
