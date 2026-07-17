# PostgreSQL Persistence Contract v1

Status: Phase 0B proposal for Phase 1 implementation.

This contract defines database ownership, durable records, concurrency rules, migrations, connection budgeting, retention, and recovery. It is a logical and operational contract, not the first TypeORM migration.

## Decision summary

- Target PostgreSQL 18.4 after platform confirmation.
- Target one dedicated engine database containing one `aiflow` schema per environment. An isolated `aiflow` schema in an approved shared database is the `PG-03` fallback.
- Use one reviewed TypeORM migration stream and keep schema synchronization disabled.
- Keep business meaning in domain packages; `packages/database` owns TypeORM mappings, the data source, and migrations.
- Use shared tenant tables with mandatory `tenant_id`; do not create a database or schema per tenant.
- Use PostgreSQL as the sole source of truth for workflow and execution progress, idempotency, leases, inbox, outbox, and audit facts.
- Keep document bytes, extracted document payloads, mapped artifacts, and secrets outside PostgreSQL. Store only bounded metadata, validated definitions/configuration, safe audit data, and immutable storage references.
- Do not add partitioning, read replicas, event sourcing, database triggers for workflow behavior, or Row-Level Security in the initial implementation.

The initial design intentionally uses ordinary relational constraints, short transactions, explicit tenant-scoped repositories, and a small number of coordination tables. More complex database features require evidence and an ADR.

## Database and schema ownership

AiFlow Engine uses a new dedicated database when the platform supports it, otherwise an isolated `aiflow` schema in an approved shared database. It never reuses the n8n or legacy service schemas or tables.

| Concern                                                                             | Owner                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------- |
| Database availability, TLS, backups, PITR, maintenance, and total connection budget | Existing platform/DBA team                    |
| `aiflow` schema, tables, constraints, indexes, and migration history                | AiFlow Engine                                 |
| Business invariants and repository ports                                            | Owning domain package                         |
| TypeORM entities/mappers, repository adapters, data source, and migrations          | `packages/database`                           |
| Migration execution in each environment                                             | Existing CI/CD process using the engine image |

There is one ordered migration stream under `packages/database/src/migrations`. Domain modules do not run their own independent migration tools, and application pods never synchronize schemas at startup.

The runtime application identity can read and write approved `aiflow` tables but cannot alter schema or own tables. A separate migration identity owns or can alter the schema. Platform administration remains separate from both.

## Logical record ownership

The package named below owns the business meaning and repository contract. Physical TypeORM code remains in the database adapter so domain packages do not import TypeORM.

| Logical owner | Initial tables                                                                                         | Purpose                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `workflows`   | `workflows`, `workflow_versions`, `workflow_version_connection_refs`, `workflow_activation_operations` | Stable workflow identity, immutable definitions, durable activation, and connection references    |
| `connections` | `connections`                                                                                          | Tenant-owned safe provider configuration and external secret reference                            |
| `storage`     | `storage_objects`                                                                                      | Provider-neutral object location, exact version, checksum, status, retention, and deletion intent |
| `documents`   | `documents`                                                                                            | Immutable source identity and accepted source-storage reference                                   |
| `executions`  | `executions`, `execution_stages`, `stage_attempts`, `delivery_operations`                              | Provider-neutral lifecycle, attempts, waits, outputs, destination effects, and receipts           |
| `extraction`  | `extraction_requests`, `extraction_callback_events`                                                    | External extraction operation, reconciliation, callback deduplication, and provider cleanup       |
| `core`        | `idempotency_records`, `audit_events`                                                                  | Boundary idempotency and append-only audit facts shared by use cases                              |
| `messaging`   | `outbox_messages`, `inbox_messages`                                                                    | Atomic publication intent and logical-consumer deduplication                                      |
| `database`    | `scheduler_leases`, `typeorm_migrations`                                                               | Global job leadership and schema history                                                          |

Future phases add provider-neutral tables only when their feature arrives, for example upload sessions/parts, ingestions, managed connector-provisioning bindings, and review tasks. Provider-specific fields remain inside validated connector configuration or connector-owned records; they do not become columns on `executions`.

The extraction and delivery-operation tables are Phase 2 additions. Their ownership is fixed here so provider contracts are unambiguous; Phase 1 does not create unused provider tables.

No module writes another module's table directly. A cross-module change is performed by an application use case inside one transaction through the owning repository adapters.

## Relationship map

```text
workflows
  -> workflow_versions
       -> workflow_version_connection_refs -> connections
  -> workflow_activation_operations -> target workflow_version

documents
  -> storage_objects (source bytes)
  -> executions
       -> execution_stages
            -> stage_attempts -> storage_objects (optional canonical stage output)
                 -> extraction_requests (for EXTRACT)
                      -> extraction_callback_events

root execution/retry chain -> delivery_operations -> current DELIVER stage_attempt

accepted transaction -> outbox_messages -> RabbitMQ
RabbitMQ delivery -> inbox_messages + durable stage claim

every security-sensitive mutation -> audit_events
```

References between tenant-owned records include `tenant_id` on both sides. PostgreSQL foreign keys and unique constraints enforce relational integrity; workflow behavior remains in application/domain code rather than triggers.

## Common data conventions

### Identifiers and time

- Primary identifiers use UUIDv4 generated by the application runtime. They are generated before persistence so a root execution can set `root_execution_id` to itself in its creation transaction without another dependency or database round trip.
- Public identifiers are opaque; clients cannot infer tenant, sequence, or business meaning from them.
- Normalized tenant, project, actor, correlation, and causation identifiers use non-empty `varchar(180)`, matching the existing auth and message-contract boundary.
- Durable time uses `timestamptz` and database time for lease/retry comparisons. Applications present time in the caller's locale but persist UTC instants.
- Tables use `created_at` and `updated_at` only when updates are valid. Append-only tables use immutable occurrence/creation timestamps instead.

### Values and constraints

- SQL names use `snake_case`; TypeScript names use `camelCase`.
- Required ownership, status, reference, hash, and timestamp columns are `NOT NULL`.
- Lifecycle values use bounded text plus named `CHECK` constraints rather than PostgreSQL enum types. A rollout expands allowed values before new application code writes them.
- Mutable aggregate roots carry a `state_version bigint` used by guarded updates.
- Money, floating-point provider values, or locale-sensitive text are not introduced until their domain contract defines precision and normalization.
- Foreign-key deletion is `RESTRICT` by default. Retention jobs delete explicitly in dependency order; broad cascading deletion is not used for execution or audit history.

### JSONB boundary

`jsonb` is appropriate for versioned workflow definitions, bounded connector configuration, message envelopes, and safe audit metadata when their boundary schema is validated before persistence.

It is not a substitute for ownership, status, searchable relationships, idempotency keys, retry times, or lease columns. Those values remain relational and indexed. GIN indexes are not added by default; a measured query and plan must justify one.

PostgreSQL never stores:

- document bytes or base64 content;
- raw OCR/extraction payloads or mapped document artifacts;
- access/refresh tokens, passwords, client secrets, or private keys;
- authorization headers, end-user JWTs, or presigned URLs;
- unredacted provider request/response bodies.

The database may store immutable S3 keys/version IDs, checksums, sizes, schema versions, safe provider operation references, and external secret-manager references. Domain records use provider-neutral storage-object IDs; adapter location fields remain confidential and are not automatically exposed through APIs or messages. Exact object behavior is defined by the [storage contract](storage-v1.md).

## Initial table invariants

This section fixes behavior and critical constraints while leaving exact column ordering and TypeORM syntax to Phase 1.

### Workflows and versions

`workflows` holds stable identity, tenant/project ownership, lifecycle status, display metadata, and an optional active-version reference.

`workflow_versions` holds an immutable validated definition, definition schema version, canonical definition hash, monotonically increasing workflow-local version number, and creator audit snapshot.

Rules:

- `(tenant_id, workflow_id, version_number)` is unique.
- An active version must belong to the same tenant and workflow.
- A persisted workflow version is never edited. Editing creates a new row.
- Activation changes workflow activation fields and creates operation/audit facts; it never rewrites a persisted version or accepted execution.
- Archived workflows remain while referenced by retained executions.

`workflow_version_connection_refs` is a relational projection of connection IDs contained in the validated definition. It identifies the reference purpose and prevents a connection from being silently deleted while a workflow version depends on it. The JSON definition remains canonical; the projection is rebuilt and verified in the same creation transaction.

`workflow_activation_operations` stores one durable activation/deactivation request: target/previous version, immutable definition/capability hashes, guarded operation step/status, attempt/lease/retry/reconciliation timing, safe failure, actor/correlation context, and timestamps.

Rules:

- A partial unique index permits at most one non-terminal operation per `(tenant_id, workflow_id)`.
- Accepting an operation commits its workflow guard, idempotency result, audit fact, and outbox command atomically.
- Activation changes `active_version_id` only after target validation/provisioning succeeds; a replacement failure leaves the previous pointer unchanged.
- Deactivation clears `active_version_id` and closes local intake before external cleanup.
- Provider calls occur outside transactions and require the current operation state version plus lease.
- Terminal operation history is immutable.
- Exact operation, cutover, cleanup, and future managed-binding behavior follows [`workflow-provisioning-v1.md`](workflow-provisioning-v1.md).

### Connections

`connections` stores tenant ownership, connector ID, safe display metadata, bounded connector configuration, authorization/health state, and an approved external secret reference.

Rules:

- Credential material is never stored in the row.
- Connector ID and configuration-schema version are explicit.
- A workflow version can reference only a connection from the same tenant and compatible connector.
- Deletion is blocked while a retained workflow version or in-flight operation requires the connection. Disable/revoke state is preferred to destructive deletion.

### Documents

`storage_objects` stores the physical location alias, immutable object key and exact version, verified size/content type/checksum/encryption projection, lifecycle status, retention time, and deletion intent. It is owned by the storage module and defined by [`storage-v1.md`](storage-v1.md).

`documents` stores accepted document identity and metadata: tenant/project, source connector and source identity, source `storage_object_id`, S3-verified checksum/size snapshot, optional full-content SHA-256 plus verification state, original safe filename, and staging time.

Rules:

- The row is created only after object existence, size, and checksum are verified.
- Source storage-object identity, checksum, and staged metadata are immutable after acceptance.
- Direct-upload idempotency and provider source identity prevent duplicate document creation.
- Source-specific version/eTag values live in bounded source metadata or a later ingestion record, not in execution columns.
- Storage deletion is a durable transition on `storage_objects`. The document row remains a tombstone/audit reference until its approved metadata retention expires.

### Executions, stages, and attempts

`executions` stores the immutable workflow-version/document references, retry-chain links, current execution status/stage, `state_version`, safe failure projection, actor/correlation snapshot, and lifecycle timestamps.

`execution_stages` stores one row per canonical stage for the execution. It holds the current stage status, attempt count, next retry/reconciliation time, current lease owner/expiry, and current safe failure projection.

`stage_attempts` preserves one row per attempt with identity and number, start/end times, terminal outcome, safe failure data, lease history, and optional canonical output storage-object/schema reference. One canonical output per successful stage is sufficient initially; a separate execution-artifact table is added only when a demonstrated stage requires multiple independently retained outputs. An attempt row may move only from `RUNNING` to one terminal attempt status.

Critical constraints:

- `(tenant_id, execution_id, stage)` is unique.
- `(tenant_id, execution_id, stage, attempt_number)` is unique.
- `(tenant_id, retry_of_execution_id)` is unique when a retry parent exists, preventing retry branches.
- A partial unique index allows at most one non-terminal execution per `(tenant_id, root_execution_id)`. PostgreSQL documents partial unique indexes as the mechanism for enforcing uniqueness only among rows satisfying a predicate in its [partial-index guidance](https://www.postgresql.org/docs/18/indexes-partial.html).
- Tenant-scoped composite foreign keys ensure the workflow version, document, retry parent, stages, and attempts belong to the same tenant.
- Terminal execution and attempt history cannot return to an active state.

The database enforces structural invariants. The domain state machine remains responsible for which transition is semantically valid.

### Extraction requests and callbacks

`extraction_requests` stores one provider-neutral external extraction operation per `EXTRACT` stage attempt: immutable profile/adapter references, stable submission key, safe provider operation/account references, guarded state, reconciliation due/deadline, result storage-object reference, safe failure projection, and provider-copy deletion status.

`extraction_callback_events` is append-only callback deduplication metadata: owning request/tenant, adapter/account, provider event ID, body hash, allow-listed event type/status, authentication outcome, receipt time, and handling outcome. It never stores the callback body or extracted values.

Rules:

- `(tenant_id, stage_attempt_id)` is unique for extraction requests.
- A provider operation reference is unique within its adapter/account when present.
- `(adapter_id, provider_account_ref, provider_event_id)` is unique for callback events.
- Callback tenant/project authority comes from the stored extraction request.
- Request state changes, reconciliation/deletion outbox intent, and safe audit facts commit atomically.
- Provider calls, result transfer, and callback authentication do not occur inside a database transaction.
- Exact behavior and retention/deletion responsibilities follow [`ocr-v1.md`](ocr-v1.md).

### Delivery operations

`delivery_operations` stores one provider-neutral destination effect for a root retry chain and immutable connector/action version: connection/company references, random effect key, exact input storage-object/schema and payload hash, guarded status, current execution/attempt, reconciliation due/deadline, bounded external resource receipt, and safe failure projection.

Rules:

- `(tenant_id, root_execution_id, connector_id, action_id, action_version)` is unique.
- `effect_key` is globally unique, opaque, generated before first publication, and never accepted from a caller/mapping/message.
- Automatic and manual retry attempts reuse the same operation/effect key and exact payload hash.
- Same effect key with a different payload hash is a permanent integrity conflict.
- Provider calls occur outside transactions; operation/stage/attempt/outbox/audit transitions commit atomically around them.
- An unknown outcome permits only reconciliation until authoritative provider evidence says the effect was or was not applied.
- Receipt fields are bounded identifiers/version/timing only; mapped values and raw provider responses are excluded.
- Exact behavior follows [`dynamics-destination-v1.md`](dynamics-destination-v1.md).

### Idempotency records

`idempotency_records` represents one mutation boundary, not a general cache. The unique key is `(tenant_id, operation_scope, idempotency_key)`.

It stores a canonical request fingerprint, status, resulting resource type/ID or safe response projection, creation/completion times, and expiry.

Rules:

- The idempotency row and business mutation commit in the same transaction.
- Same key and same fingerprint returns the committed result.
- Same key with a different fingerprint returns `IDEMPOTENCY_KEY_REUSED`.
- A concurrent matching request may wait only for a short bounded period; otherwise it returns `IDEMPOTENCY_IN_PROGRESS` as retryable.
- Failed transactions leave no completed result. A durable accepted operation is never silently re-executed.
- Stored response data follows the same confidential-data restrictions as the API.

### Outbox messages

`outbox_messages` stores the complete versioned message envelope, message/aggregate metadata, `available_at`, publish lease, publish attempt count, confirmed publication time, and last safe transport error.

Rules:

- `message_id` is globally unique.
- Aggregate state and its outbox row commit atomically.
- Unpublished rows never expire through retention.
- The publisher claims a deterministic bounded batch ordered by `(available_at, id)`.
- Multiple publishers use `FOR UPDATE SKIP LOCKED`; PostgreSQL explicitly identifies `SKIP LOCKED` as suitable for multiple consumers of a queue-like table in its [`SELECT` documentation](https://www.postgresql.org/docs/18/sql-select.html).
- A publish lease uses database time and can be reclaimed after expiry.
- Only a confirmed publish sets `published_at`; an uncertain confirmation republishes the same `message_id`.

### Inbox messages

`inbox_messages` stores logical consumer name, message ID/type, tenant/project, safe target reference, durable handling outcome, receipt/completion time, and expiry.

Rules:

- `(consumer_name, message_id)` is unique.
- Inbox insertion and the durable target claim commit in one short transaction.
- Duplicate, stale, and rejected outcomes are durable and acknowledgeable.
- The inbox does not claim that an external stage operation completed; the execution-stage lease owns crash recovery after broker acknowledgement.

### Audit events

`audit_events` is append-only and contains tenant/project, actor type/ID, canonical action, resource type/ID, outcome/error code, correlation/causation IDs, workflow version where relevant, timestamp, and bounded redacted metadata.

Audit rows cannot be updated by ordinary application use cases. Corrections are new audit events. Audit data never becomes a second source of current workflow or execution state.

### Scheduler leases

`scheduler_leases` is a small system table keyed by stable job name. It stores owner, lease expiry, and fencing version for singleton periodic jobs such as retry scheduling, reconciliation scanning, and retention. Outbox publishers do not require global leadership because they claim independent rows with `SKIP LOCKED`.

A scheduler replica acquires or renews a lease with one guarded statement using database time. Work produced by a lease includes the fencing version where needed so an expired owner cannot commit after a new owner takes over.

The migration command additionally takes one well-known PostgreSQL advisory lock on its dedicated connection. PostgreSQL documents that advisory locks are application-defined and session locks are released when the session ends in its [explicit-locking guidance](https://www.postgresql.org/docs/18/explicit-locking.html). CI/CD must still prevent concurrent migration jobs; the lock is defense in depth.

## Tenant isolation

Every tenant-owned table has a non-null `tenant_id`. Project-owned rows also have non-null `project_id`.

Required rules:

1. Repository methods require explicit trusted tenant context; there is no unscoped generic `findById` for tenant data.
2. Lookups include `tenant_id` even when UUIDs are globally unique.
3. Unique business keys start with `tenant_id` and include `project_id` when their scope is project-local.
4. Tenant-owned foreign keys include `tenant_id` on both sides, backed by the required composite unique key.
5. Cross-tenant lookup returns the same absence result as an unknown resource.
6. Scheduler/operator scans are isolated in explicit system repositories and always preserve tenant context when dispatching work.
7. Integration tests create at least two tenants and attempt reads, updates, joins, retries, and foreign-key references across them.

PostgreSQL Row-Level Security is not enabled in Phase 1. It is useful but not complete by itself: table owners and `BYPASSRLS` roles can bypass policies, and referential-integrity checks bypass row security, as described in the official [RLS documentation](https://www.postgresql.org/docs/18/ddl-rowsecurity.html). Adding RLS later requires an ADR covering pooled-session tenant context, migration ownership, scheduler/system access, backup behavior, and tests. Until then, tenant-scoped repositories plus composite constraints and isolation tests are mandatory—not optional substitutes.

## Transactions and concurrency

Ordinary application transactions use PostgreSQL `READ COMMITTED`, its default isolation level, with predetermined rows, explicit constraints, and guarded updates. The official [transaction-isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html) notes that concurrent updates re-evaluate the `WHERE` condition, which supports updates guarded by `tenant_id`, ID, `state_version`, status, and lease owner.

Rules:

- Transactions are short and contain database work only. HTTP/provider calls, S3 transfers, RabbitMQ confirms, and user waits never occur inside a transaction.
- A state transition updates the aggregate/stage, closes or creates its attempt, inserts outbox/audit records, and updates idempotency where applicable in one transaction.
- A transition succeeds only when its guarded update affects the expected row. Zero affected rows means duplicate, stale, forbidden, or lost lease and is resolved by reloading state.
- Multi-row locks are acquired in a stable order: workflow/execution root, activation operation or stage, attempt, then outbox/audit rows.
- Deadlocks and serialization failures are retried only around the complete idempotent transaction, with a small bounded retry count and metrics.
- Higher isolation is selected only for a use case whose invariant cannot be represented by a unique constraint, guarded update, or explicit row lock.

Current stage leases live in `execution_stages`. A claim atomically verifies eligibility and expected execution version, installs owner/expiry, increments the attempt number, and creates the attempt. Result commit verifies the same tenant, execution/stage, lease owner, unexpired lease, and expected state version.

The scheduler scans due workflow/execution retries and expired operation/stage leases in stable bounded batches with `FOR UPDATE SKIP LOCKED`. It creates durable outbox commands and releases the rows in one transaction; it does not perform provider work.

## Required access paths

Initial migrations add indexes only for known contract queries:

| Query                         | Leading index columns or predicate                                         |
| ----------------------------- | -------------------------------------------------------------------------- |
| Project workflow list         | `(tenant_id, project_id, created_at, id)`                                  |
| Workflow version history      | `(tenant_id, workflow_id, version_number)`                                 |
| Current/due provisioning      | Partial `(status, next_attempt_at, id)` and `(lease_expires_at, id)` paths |
| Workflow execution list       | `(tenant_id, workflow_id, created_at, id)`                                 |
| Execution stage lookup        | `(tenant_id, execution_id, stage)`                                         |
| Due retry/reconciliation scan | `(next_attempt_at, execution_id)` for due-capable stage states             |
| Expired stage lease scan      | `(lease_expires_at, execution_id)` for running stages                      |
| Unpublished outbox scan       | `(available_at, id)` where `published_at IS NULL`                          |
| Inbox deduplication           | unique `(consumer_name, message_id)`                                       |
| Mutation idempotency          | unique `(tenant_id, operation_scope, idempotency_key)`                     |
| Resource audit history        | `(tenant_id, resource_type, resource_id, occurred_at, id)`                 |

Cursor APIs use the same stable sort tuple as their index and include the final unique `id` as a tie-breaker. Offset pagination is not used for unbounded operational lists.

Index additions on populated large tables require query-plan evidence, write-cost review, and a rollout note. Partitioning is deferred until measured row count, retention cost, vacuum behavior, or query plans demonstrate a need.

## Connection budget

The platform provides one maximum AiFlow Engine connection budget after reserving capacity for PostgreSQL administration, monitoring, backups, and other databases. The engine divides that budget across maximum simultaneous replicas; each team cannot size its pool independently.

```text
required connections =
  (max API replicas × API pool max)
  + Σ(max replicas for each worker queue group × that worker pool max)
  + (max scheduler replicas × scheduler pool max)
  + 1 migration connection

required connections <= confirmed engine budget
```

The scheduler pool includes the outbox publisher and scheduled scans. Health checks use the existing role pool rather than creating a second pool.

Initial local-development defaults are a maximum of five connections for each running API, worker, and scheduler process plus one migrator connection: 16 connections when all three roles run together. This is a convenience value, not a production recommendation.

Production pool sizes remain blocked by `PG-02`. They must also respect:

- worker/provider concurrency and RabbitMQ prefetch;
- finite acquire, statement, lock, idle-in-transaction, and connection lifetimes;
- graceful pod shutdown and pool drain;
- platform proxy/pooler mode and its transaction/session limitations;
- metrics for active, idle, waiting, timed-out, and long-running transactions.

Provider calls do not hold database connections, so worker concurrency is not mechanically equal to pool size. It is bounded separately using measured claim/commit time and provider limits.

## Migration and rollout contract

Phase 1 adds a same-image operational command such as `aiflow-engine migrate`; this is not a new long-running service. CI/CD runs it once before application rollout using the migration identity.

Rules:

1. `synchronize` is `false` in every environment, including local development and tests that prove production behavior.
2. Every persistent change is a reviewed TypeORM migration with an owner, compatibility notes, recovery plan, expected lock/performance impact, and retention impact.
3. Migrations are transactional by default. A non-transactional operation such as a required concurrent index build is isolated, retry-safe, and explicitly documented.
4. Mixed-version rollouts use expand, migrate/backfill, switch behavior, and contract/remove in a later release.
5. New writers deploy only after old readers tolerate the expanded schema. Columns are not dropped or made stricter in the same release that stops using them.
6. Backfills are resumable, bounded, observable, and separate from pod startup. Large backfills use a dedicated operational job from the same image.
7. Production rollback normally restores the previous application image while retaining the backward-compatible expanded schema. Destructive `down` migrations are not an automatic rollback strategy.
8. A safe `down` implementation may be supplied and tested for a new empty table/index. When rollback would lose or reinterpret data, the migration documents forward repair or restore instead.

The migration suite must prove:

- creation from an empty PostgreSQL 18.4 database;
- upgrade from the previous released schema;
- repeated migration command safety;
- expected schema and constraints after migration;
- documented recovery for an interrupted non-transactional migration.

## Retention and deletion

These initial values inherit the proposed engineering envelope and require product/platform confirmation:

| Record                           | Initial retention rule                                              |
| -------------------------------- | ------------------------------------------------------------------- |
| Active workflows/connections     | Retain while active or referenced                                   |
| Archived workflow versions       | Retain at least as long as referencing executions/audit facts       |
| Workflow activation operations   | Same workflow/audit lifetime; unresolved cleanup never auto-expires |
| Documents and execution metadata | 1 year after terminal execution, subject to object-deletion policy  |
| Execution stages and attempts    | Same lifetime as their execution                                    |
| Extraction requests              | Same lifetime as their execution; provider copies follow OCR policy |
| Extraction callback events       | 90 days and never shorter than provider callback replay policy      |
| Delivery operations/receipts     | Same lifetime as root execution; longer only by financial policy    |
| Audit events                     | 1 year                                                              |
| Idempotency records              | 90 days and never shorter than the accepted external replay window  |
| Inbox records                    | 90 days and never shorter than broker/DLQ replay policy             |
| Confirmed outbox rows            | 30 days after `published_at`                                        |
| Unpublished outbox rows          | Never expire automatically                                          |
| Scheduler leases                 | Current row retained; obsolete job rows removed explicitly          |

Retention cleanup uses small ordered batches, explicit dependency order, and metrics. It does not issue broad unbounded deletes. A failed S3 deletion keeps document deletion intent and is retried/reconciled; database metadata is not removed first.

Raw and derived S3 objects follow the separate proposed 30-day post-terminal retention. Their bounded database metadata may remain in deleted/tombstone state for the execution's one-year audit window.

Retention does not override legal/security holds or provider contract requirements. If future audit rules require longer-lived destination-effect tombstones, those small records are separated from bulky execution metadata rather than retaining everything indefinitely.

## Backup, restore, and disaster recovery

The platform owns encrypted backups, continuous archiving/PITR, retention, cross-AZ durability, and restore infrastructure. PostgreSQL documents WAL archiving and recovery to a chosen point through its [PITR guidance](https://www.postgresql.org/docs/18/continuous-archiving.html); the exact managed-service guarantees remain `PG-04` inputs.

AiFlow Engine owns application-level recovery behavior and a tested runbook:

1. Stop or fence API mutations, consumers, scheduler scans, and outbox publication.
2. Restore PostgreSQL to the approved point and verify migration version plus critical constraints.
3. Compare the restored database time/state with retained S3 objects and broker deliveries without treating RabbitMQ as newer truth.
4. Restart consumers so stale/out-of-order messages are safely acknowledged by state/version guards.
5. Restart scheduler/outbox publication so committed unpublished intents are republished.
6. Reconcile every external destination operation whose outcome crosses the recovery point before issuing another write.
7. Record the recovery window, replay counts, unresolved operations, and tenant impact.

The initial proposed target is RPO 15 minutes and RTO 4 hours, but the engine cannot promise it until the platform confirms backup frequency, WAL/PITR availability, restore time, and an exercised restore test.

## Local development boundary

Phase 0B defines this contract but does not add Docker infrastructure.

The first PostgreSQL slice in Phase 1 will add:

- a pinned PostgreSQL 18.4 local container with health check and named volume;
- separate local application and migration identities;
- schema creation and migrations through the same command used by CI/CD;
- TypeORM connection/readiness integration;
- PostgreSQL integration tests against the same exact version, using isolated test databases;
- documented reset/reseed commands that never target a non-local database.

Local Kubernetes is not required. RabbitMQ and S3-compatible local dependencies arrive in their own Phase 1 slices so failures remain easy to diagnose.

## Required Phase 1 evidence

1. A fresh database and previous-version database reach the same expected schema through migrations.
2. Runtime identity cannot alter schema and migration identity is not used by application roles.
3. Cross-tenant reads, writes, joins, and foreign-key references fail or return absence.
4. Two concurrent state transitions produce exactly one winner and one outbox intent.
5. Duplicate API mutations return one resource; key reuse with different input is rejected.
6. Multiple outbox publishers/inbox consumers do not claim the same logical work twice.
7. Expired worker and scheduler leases are recovered using database time and fencing.
8. Unpublished outbox rows survive process termination and are never removed by retention.
9. Retention deletes only eligible rows in bounded batches and preserves deletion failures.
10. Pool exhaustion, lock timeout, deadlock retry, migration failure, and restore/replay behavior are observable and bounded.

## Platform confirmations still required

- `PG-01`: PostgreSQL 18.4 availability and any prohibited/required features or extensions.
- `PG-02`: total engine connection budget, proxy/pooler convention, and maximum replica assumptions.
- `PG-03`: TLS/CA, database/schema creation, application identity, migration identity, and credential delivery.
- `PG-04`: migration approval/execution, backup/PITR retention, restore-test process, confirmed RPO, and confirmed RTO.
- `PRODUCT-01`: final retention, throughput, availability, and recovery targets.

No PostgreSQL extension is required by this proposal. A platform-required deviation is recorded before Phase 1 migrations are implemented.
