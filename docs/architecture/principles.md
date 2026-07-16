# Architecture Laws

These laws are the durable boundary for AiFlow Engine. They apply across roadmap phases. A change to a law requires an accepted ADR and updates to affected contracts and operational guidance.

## 0. Simplicity is the default

Choose the simplest design that satisfies the current contract, reliability, security, and scale requirements. Prefer readable, explicit code and small independent modules. Clean architecture protects business logic from external systems; it is not permission to add ceremonial layers or speculative abstractions.

Add complexity only for a demonstrated requirement, measured constraint, or real external boundary. Make the reason visible in the code, test, contract, or ADR.

## 1. One product, independently scalable roles

AiFlow Engine remains one repository and one image with `api`, `worker`, and `scheduler` runtime roles. Kubernetes can scale each role independently. A new deployable service requires measured evidence that role-level scaling, isolation, or reliability is insufficient and an accepted ADR.

## 2. Core owns workflow meaning; adapters own providers

Workflow, execution, document, mapping, review, and template rules use canonical product language. Microsoft, Google, OCR vendor, n8n, HTTP, NestJS, RabbitMQ, PostgreSQL, and S3 concepts must not leak into the core domain.

Provider-specific configuration and behavior live behind connector or infrastructure ports. Adding a new entry or destination provider must not require redesigning execution state or canonical public resources.

## 3. Dependency direction points inward

```text
apps (composition roots)
  -> application/domain packages
  -> ports owned by the domain/application

infrastructure and connector adapters
  -> application/domain ports
```

Domain packages never import apps or adapters. Apps assemble dependencies but do not own business rules. Packages consume other packages through public exports only.

## 4. Durable state precedes asynchronous delivery

PostgreSQL is the system of record for workflows, versions, documents, executions, attempts, idempotency, inbox, outbox, and audit facts. RabbitMQ transports work notifications and commands; it does not decide truth.

A state change and its outgoing message intent are committed atomically through an outbox. Consumers make durable changes before acknowledging and deduplicate through an inbox or business idempotency key.

## 5. Document bytes use object storage paths

Document bytes travel by streaming or direct presigned transfer between source systems, S3-compatible object storage, workers, and approved providers. APIs create upload sessions and metadata; messages carry identifiers. PostgreSQL and RabbitMQ never contain document bytes.

Workers retrieve objects directly from storage only when their stage needs them. Object keys are immutable, tenant-scoped, non-guessable, and checksum-verifiable.

## 6. Delivery is at-least-once; effects are effectively-once

The system assumes duplicate API requests, webhook notifications, callbacks, scheduler scans, and RabbitMQ deliveries. Every boundary has a stable idempotency identity. Replaying work may repeat computation but must not repeat externally visible business effects.

Retries are bounded, classified, observable, and separated from permanent failure. Unknown destination outcomes require reconciliation; they are never blindly retried.

## 7. Waiting is state, not occupied compute

Provider waits, review waits, retry delays, and subscription renewal waits are persisted states. They do not keep HTTP requests, worker slots, database transactions, or unacknowledged broker deliveries open.

## 8. Tenant context is mandatory

Tenant isolation is enforced at API authorization, application use cases, repository queries, object keys, connection access, message metadata, and operational tooling. Actor identity, tenant identity, and project/resource permission are separate concepts.

Cross-tenant operator behavior must be explicit, audited, least-privileged, and impossible through ordinary tenant APIs.

## 9. Contracts are versioned at trust boundaries

Public HTTP resources, queue envelopes, provider callbacks, connector descriptors, and persisted workflow definitions have explicit versions and schemas. Additive compatible changes may stay in a version. Breaking semantic or structural changes require a new version plus coexistence and migration strategy.

Legacy DevPortal or n8n shapes are migration/compatibility inputs only and cannot become core entities.

## 10. Failure and operation are product behavior

Every execution and stage exposes a stable state, attempt history, safe error code, correlation identifiers, timestamps, and permitted recovery actions. Operators can inspect and safely replay failed work without editing the database or publishing ad hoc messages.

Logs, traces, metrics, and Sentry events correlate through identifiers and remain safe for confidential data. Health checks distinguish liveness from dependency readiness.

## 11. Evolution remains deployable

Database, message, API, and workflow-definition changes support mixed-version rolling deployment. Changes are expand-first, migrate/backfill, switch behavior, then contract/remove in a later approved release.

## 12. Security and resource bounds are defaults

All external inputs are authenticated where applicable, authorized, schema-validated, size-limited, time-limited, and rate/concurrency-bounded. Credentials use workload identity or approved secret references. Connections and retries are bounded so one tenant or provider cannot exhaust shared capacity.
