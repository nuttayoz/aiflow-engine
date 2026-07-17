# Execution Lifecycle Contract

Status: Phase 0B proposal for Phase 1 implementation.

This contract defines the provider-neutral execution state machine. It describes durable behavior, not database tables or framework classes.

## Boundary and invariant

An execution starts only after a document has been staged in engine-managed object storage and its metadata has been committed. Direct API upload, SharePoint, and future entry connectors must all converge on this boundary:

```text
entry connector -> DOCUMENT_STAGED -> EXTRACT -> MAP -> optional REVIEW -> DELIVER
```

Entry discovery, download, checksum verification, and storage staging are ingestion responsibilities. They are not execution stages. Adding an entry or destination provider must not change the core lifecycle.

The active-version intake gate, immutable version snapshot, activation, and deactivation behavior are defined in [`workflow-provisioning-v1.md`](workflow-provisioning-v1.md).

Direct upload, provider streaming, derived artifacts, and the `AVAILABLE` storage boundary are defined in [`storage-v1.md`](storage-v1.md).

External extraction submission, callback hints, polling, reconciliation, and canonical result acceptance are defined in [`ocr-v1.md`](ocr-v1.md).

Microsoft destination effect identity, delivery operations, bounded receipts, and unknown-outcome reconciliation are defined in [`dynamics-destination-v1.md`](dynamics-destination-v1.md).

PostgreSQL is authoritative for every transition. RabbitMQ messages only wake workers so they can load and claim eligible work.

## Core resources

An `Execution` is one durable end-to-end run of one immutable workflow version against one staged document. It contains one or more `StageAttempt` records.

Conceptual execution fields:

| Field                    | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `executionId`            | Opaque identifier for this run                         |
| `tenantId`, `projectId`  | Mandatory isolation boundary                           |
| `workflowVersionId`      | Immutable workflow definition used by this run         |
| `documentId`             | Immutable staged input metadata                        |
| `rootExecutionId`        | First run in a manual-retry chain                      |
| `retryOfExecutionId`     | Immediately preceding failed run, when applicable      |
| `status`, `currentStage` | Current durable lifecycle position                     |
| `stateVersion`           | Monotonically increasing optimistic-concurrency value  |
| `failure`                | Safe current failure summary, when applicable          |
| timestamps               | Creation, start, last transition, and completion times |

Conceptual stage-attempt fields:

| Field                          | Meaning                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `stageAttemptId`               | Opaque attempt identifier                                 |
| `executionId`, `stage`         | Owning run and stage                                      |
| `attemptNumber`                | Starts at one and increases per stage                     |
| `status`                       | Durable attempt status                                    |
| `leaseOwner`, `leaseExpiresAt` | Present only while active work is owned                   |
| `startedAt`, `finishedAt`      | Attempt timing                                            |
| `failure`                      | Safe failure details                                      |
| `outputStorageObjectId`        | Immutable successful stage output, when the stage has one |
| `outputSchemaVersion`          | Canonical artifact schema version paired with that output |

These fields establish behavior and auditability. Phase 1 will define physical schemas and indexes separately.

The agreed physical ownership, constraints, guarded-update strategy, and retention proposal are defined in [`postgresql-v1.md`](postgresql-v1.md).

## Execution states

| State             | Terminal | Meaning                                                              |
| ----------------- | -------- | -------------------------------------------------------------------- |
| `QUEUED`          | No       | The staged document was accepted and extraction is eligible          |
| `EXTRACTING`      | No       | Extraction is running, waiting on a provider, or scheduled for retry |
| `MAPPING`         | No       | Extracted data is being validated and mapped                         |
| `AWAITING_REVIEW` | No       | A durable human decision is required; no worker or delivery is held  |
| `DELIVERING`      | No       | Destination delivery is running, reconciling, or scheduled for retry |
| `SUCCEEDED`       | Yes      | The destination effect was confirmed                                 |
| `FAILED`          | Yes      | This run cannot progress without an explicit recovery action         |
| `REJECTED`        | Yes      | A reviewer rejected the run                                          |

Cancellation is not part of canonical API v1. Deactivating a workflow prevents new executions but does not cancel accepted work. A future cancellation contract may add a terminal state without weakening the rules here.

## Stage and attempt states

The stages are `EXTRACT`, `MAP`, `REVIEW`, and `DELIVER`. `REVIEW` is skipped when the immutable workflow version does not require it.

| Stage status      | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `PENDING`         | Eligible but not yet claimed                                                |
| `RUNNING`         | Owned by a live worker lease                                                |
| `WAITING`         | Waiting durably for a callback, review, or reconciliation; no lease is held |
| `RETRY_SCHEDULED` | A future retry time is persisted; no broker delivery is held                |
| `SUCCEEDED`       | Stage output was committed                                                  |
| `FAILED`          | Stage ended the execution                                                   |
| `SKIPPED`         | Stage does not apply to this workflow version                               |

Attempt status is limited to `RUNNING`, `SUCCEEDED`, `FAILED`, or `TIMED_OUT`. A retry always creates a new attempt; attempt history is never overwritten.

## Transition table

Every transition and its outgoing outbox record are committed in one PostgreSQL transaction.

| From              | Trigger and guard                                               | To                   | Durable effect                                                     |
| ----------------- | --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| no execution      | Document is staged and the idempotency key is new               | `QUEUED`             | Create execution and extraction outbox command                     |
| `QUEUED`          | Extraction command matches `stateVersion`; lease claim succeeds | `EXTRACTING`         | Start extraction attempt                                           |
| `EXTRACTING`      | Extraction output is valid and committed                        | `MAPPING`            | Complete extraction; create mapping command                        |
| `EXTRACTING`      | Provider accepted asynchronous work                             | `EXTRACTING`         | Mark stage `WAITING`; release lease and persist extraction request |
| `MAPPING`         | Mapping succeeds and review is required                         | `AWAITING_REVIEW`    | Commit immutable mapped output; create review request command      |
| `MAPPING`         | Mapping succeeds and review is not required                     | `DELIVERING`         | Skip review; create delivery command                               |
| `AWAITING_REVIEW` | Authenticated decision is approved and new                      | `DELIVERING`         | Commit decision; create delivery command                           |
| `AWAITING_REVIEW` | Authenticated decision is rejected and new                      | `REJECTED`           | Commit decision and terminal audit event                           |
| `AWAITING_REVIEW` | Review policy expires                                           | `FAILED`             | Record non-retryable policy failure                                |
| `DELIVERING`      | Destination effect is confirmed                                 | `SUCCEEDED`          | Commit destination receipt and terminal audit event                |
| active state      | Transient stage failure remains within policy                   | same execution state | Finish attempt; mark `RETRY_SCHEDULED` with `nextAttemptAt`        |
| active state      | Permanent failure or retry budget exhausted                     | `FAILED`             | Finish attempt and record allowed recovery actions                 |

Duplicate, stale, or out-of-order triggers do not transition state. They are recorded as already handled where useful and acknowledged safely.

## Retry rules

### Automatic stage retry

Automatic retry stays inside the same execution and creates a new stage attempt. The database stores `nextAttemptAt`; the scheduler later emits a new outbox command. RabbitMQ redelivery and delayed retry queues are not business retry timers.

The retry policy is captured with the immutable workflow version or the applicable connector policy. It defines:

- maximum attempts;
- exponential backoff and bounded jitter;
- retryable failure codes;
- provider-specific throttling hints such as `Retry-After`;
- stage timeout and reconciliation timeout.

`SUCCEEDED`, `REJECTED`, permanent failures, and unresolved destination outcomes are never retried blindly.

### Manual execution retry

`POST /api/v1/executions/:executionId/retries` creates a new execution linked by `retryOfExecutionId` and `rootExecutionId`. The original remains terminal and auditable.

The new execution resumes at the failed stage and may reuse immutable, checksum-verified outputs from earlier successful stages. It must still use the original workflow version unless a future explicit reprocess contract says otherwise.

Rules:

- The request requires an idempotency key. Repeating the request returns the same child execution.
- An execution may have only one direct retry child. A failed child is retried to extend the chain; retry branches are forbidden.
- Only one non-terminal execution may exist in a root retry chain.
- The API exposes an allowed retry action only when recovery is safe.
- A random opaque destination effect key is created once, stored against the root execution and destination action, and reused so manual retry cannot create a second business effect.

## Failure contract

The execution API exposes safe failure information without provider credentials, document content, or confidential payloads:

```json
{
  "stage": "DELIVER",
  "code": "DESTINATION_TIMEOUT",
  "category": "UNKNOWN_OUTCOME",
  "retryable": false,
  "attemptId": "sat_opaque",
  "occurredAt": "2026-07-16T08:30:00Z",
  "message": "The destination result could not be confirmed.",
  "allowedActions": ["RECONCILE"]
}
```

Failure categories are:

- `TRANSIENT`: a bounded automatic retry is safe;
- `PERMANENT`: the same input or configuration will not succeed;
- `UNKNOWN_OUTCOME`: an external effect may have occurred and must be reconciled;
- `POLICY`: a workflow rule such as review expiry ended the run.

## Leases, waits, and recovery

A lease is held only while a worker is actively performing a stage operation. Long provider waits, review waits, retry delays, and reconciliation waits are persisted without a worker, database transaction, or unacknowledged RabbitMQ delivery.

Worker claims use both the expected `stateVersion` and an atomic lease condition. Each accepted transition increments `stateVersion`. A worker that loses its lease cannot commit a result.

The scheduler finds expired leases and unfinished waits:

| Interrupted condition                                     | Recovery                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Worker exits before durable claim                         | RabbitMQ can redeliver the command                                                     |
| Worker exits after claim with no durable external request | Lease expiry creates a timed-out attempt and schedules a safe retry                    |
| Worker exits while external submission outcome is unknown | Reconcile by the stable external request/effect key before any retry                   |
| Worker exits during an idempotent/read-only provider call | Reconciliation or a policy-controlled retry follows lease expiry                       |
| Worker exits during a destination write                   | Treat as `UNKNOWN_OUTCOME`; reconcile using the destination effect key before retrying |
| Callback arrives more than once                           | Inbox/provider-event uniqueness accepts it once                                        |
| Callback arrives after state moved on                     | Record as stale where required and leave state unchanged                               |

Destination reconciliation has three outcomes:

- confirmed applied: commit the receipt and move to `SUCCEEDED`;
- confirmed not applied: schedule a safe delivery retry;
- unresolved until the policy deadline: move to `FAILED` with an operator-safe reconciliation action, never a blind replay.

## API projection

`GET /api/v1/executions/:executionId` should expose the lifecycle without leaking internal queue or database details:

```json
{
  "executionId": "exe_opaque",
  "status": "DELIVERING",
  "currentStage": "DELIVER",
  "stateVersion": 6,
  "stageSummary": [
    { "stage": "EXTRACT", "status": "SUCCEEDED", "attempts": 2 },
    { "stage": "MAP", "status": "SUCCEEDED", "attempts": 1 },
    { "stage": "REVIEW", "status": "SKIPPED", "attempts": 0 },
    { "stage": "DELIVER", "status": "WAITING", "attempts": 1 }
  ],
  "failure": null,
  "allowedActions": [],
  "correlationId": "cor_opaque"
}
```

`allowedActions` is server-derived. Initial values are `RETRY`, `RECONCILE`, or an empty list; the UI must not infer them from status alone.

## Phase 1 acceptance cases

The implementation must prove at least these cases:

1. Creation of an execution and its first command is atomic.
2. Duplicate and out-of-order commands do not repeat a transition.
3. A transient failure produces a new attempt only after the persisted due time.
4. A worker crash at each stage is recovered without losing the execution.
5. Waiting states hold no worker lease or broker delivery.
6. A destination timeout cannot cause a second business effect through blind retry.
7. Manual retry is idempotent, linked to the original execution, and tenant-isolated.
8. Terminal execution and attempt history cannot be rewritten.
