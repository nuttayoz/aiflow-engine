# AiFlow Engine Implementation Roadmap

This roadmap controls implementation order. A phase starts only after its entry gate is agreed, and it finishes only when its exit criteria are demonstrated.

## Status overview

| Stage    | Outcome                            | Status      |
| -------- | ---------------------------------- | ----------- |
| Phase 0A | Repository skeleton                | Complete    |
| Phase 0B | Contract and platform discovery    | In progress |
| Phase 1  | Reliable engine foundation         | Not started |
| Phase 2  | Direct-upload proof and demo       | Not started |
| Phase 3  | Existing DevPortal compatibility   | Not started |
| Phase 4  | SharePoint entry and destination   | Not started |
| Phase 5  | Templates and review               | Not started |
| Phase 6  | Migration, cutover, and retirement | Not started |

No later phase is partially implemented in the skeleton.

## Phase 0A: repository skeleton

Status: complete.

Delivered:

- Bun workspaces and frozen lockfile.
- TypeScript and NestJS with the Express adapter.
- API, worker, and scheduler runtime roles.
- Empty package boundaries for domain, infrastructure, and connectors.
- Liveness/readiness endpoints and graceful runtime shutdown.
- Linting, formatting, type-checking, tests, and a Node.js 24 Docker image.

Explicitly not delivered:

- Workflow behavior or database schemas.
- PostgreSQL, RabbitMQ, Redis, or S3 integration.
- Connector or third-party provider behavior.
- Kubernetes/CI/CD changes.
- DevPortal or `devportal-backend` changes.

## Phase 0B: contract and platform discovery

Status: in progress.

Purpose: remove implementation ambiguity before building the reliability foundation.

Progress:

- DevPortal compatibility discovery baseline: [`contracts/devportal-compatibility.md`](contracts/devportal-compatibility.md).
- Direct canonical API v1 and workflow-definition envelope: [`contracts/canonical-api-v1.md`](contracts/canonical-api-v1.md).
- Authentication, tenancy, permission, and project-authorization contract: [`contracts/auth-tenancy.md`](contracts/auth-tenancy.md).
- Platform baseline, verified legacy evidence, target integration rules, and owner-confirmation checklist: [`contracts/platform-baseline.md`](contracts/platform-baseline.md).

Required decisions:

1. Confirm PostgreSQL 18.4 availability, connection budget, migration process, backup/PITR guarantees, RPO, and RTO.
2. Confirm RabbitMQ 4.3.2 availability, cluster topology, quorum queue support, TLS/authentication, virtual-host convention, and KEDA availability.
3. S3 bucket, KMS key, lifecycle, private connectivity, EKS identity, and maximum-object conventions.
4. Authentication token validation plus canonical tenant, actor, role, and service-identity claims.
5. Third-party OCR request/callback contract, authentication, quotas, timeout, retry, idempotency, and reconciliation capability.
6. Exact Dynamics NAV or Business Central product/version, hosting model, authentication, companies, entities, and required writes.
7. Existing Review System ownership and callback contract.
8. Existing DevPortal endpoints, request/response shapes, and workflow payloads that the compatibility layer must preserve.
9. Initial retention, file-size, page-count, throughput, availability, and latency targets.

Deliverables:

- Versioned integration-contract notes or ADRs.
- Initial canonical API resource names and error envelope.
- Initial execution states and transition table.
- Initial RabbitMQ exchange/queue/message naming proposal.
- Initial PostgreSQL ownership and migration proposal.
- Compatibility inventory for the existing DevPortal and `devportal-backend`.

Exit criteria:

- Phase 1 has no unresolved PostgreSQL, RabbitMQ, S3, authentication, or tenancy dependency.
- Phase 2 has documented OCR and Dynamics integration contracts.
- Legacy UI compatibility requirements are listed rather than inferred during implementation.

## Phase 1: reliable engine foundation

Purpose: prove that execution state and commands cannot be lost before adding real document processing.

Implementation order:

1. Configuration, secret references, tenant context, correlation identifiers, and structured logging.
2. PostgreSQL connection, migrations, module-owned repositories, and health checks.
3. Workflow, workflow-version, document, execution, stage-attempt, idempotency, inbox, and outbox records.
4. Explicit execution state machine and transition guards.
5. RabbitMQ connection lifecycle, topology declaration, publisher confirms, manual acknowledgements, retries, and DLQs.
6. Transactional outbox publisher and inbox deduplication.
7. Worker leases, timeout recovery, scheduler leadership, and reconciliation.
8. S3 storage port, AWS adapter, immutable key policy, checksum metadata, and storage contract tests.
9. Connector SDK, connector descriptor/schema contract, and connector contract-test harness.
10. Metrics, tracing, Sentry integration, operator-safe replay, and audit events.

Exit criteria:

- A test workflow/execution can move through synthetic stages without a real provider.
- A committed database command survives API termination before RabbitMQ publication.
- Duplicate messages do not duplicate a stage transition.
- A worker crash before acknowledgement causes safe redelivery.
- Exhausted retries appear in an inspectable DLQ and can be safely replayed.
- Scheduler failover does not run the same reconciliation job concurrently.
- S3 contract tests prove streaming, checksum validation, immutable keys, and deletion behavior.
- Tenant isolation tests cover every repository and public API query.

## Phase 2: direct-upload proof with internal demo harness

Purpose: deliver and demonstrate one complete workflow without n8n, review, or changes to the real DevPortal.

Scope:

- Create upload session.
- Presigned single-part or multipart S3 upload.
- Complete upload session and stage the immutable document.
- Submit to the third-party OCR provider.
- Validate and authenticate OCR callbacks.
- Reconcile missing or uncertain OCR results.
- Map extracted fields into the canonical destination command.
- Deliver to one confirmed Dynamics NAV/Business Central action.
- Expose execution status and failure details through canonical APIs.
- Build a disposable internal demo UI under `tools/demo-ui` that calls only the canonical public API.
- Mirror the existing DevPortal journey boundaries: workflow list, three-step create/activate wizard, upload, execution status, failure details, and retry.
- Generate or share the same typed API client and workflow-definition schema that the real DevPortal migration will consume.
- Mock only external provider boundaries when needed; do not mock PostgreSQL state, RabbitMQ delivery, S3 staging, idempotency, or engine recovery behavior.
- Exclude the demo UI from the production engine image and production deployment manifests.

Exit criteria:

- Direct upload -> OCR -> mapping -> Dynamics completes without n8n.
- Document bytes never pass through the API, RabbitMQ, or PostgreSQL.
- Duplicate completion calls, OCR callbacks, and RabbitMQ deliveries produce one destination effect.
- API/worker termination tests recover the execution at every stage.
- Provider outage, throttling, timeout, and uncertain-write scenarios are tested.
- An API-only operator can inspect, retry, and audit the execution.
- The internal demo UI proves the DevPortal-shaped journey against the real engine APIs without database, queue, or worker backdoors.
- Canonical request/response fixtures from the demo are frozen for the Phase 3 DevPortal client migration.
- The real `devportal` and `devportal-backend` repositories remain unchanged throughout Phase 2.

## Phase 3: existing DevPortal compatibility and provisioning

Purpose: make the new engine fit the current UI rather than rebuilding the frontend.

Entry gate: Phase 2 has passed its engine reliability, end-to-end demo, and canonical-contract exit criteria. The real DevPortal is not modified before this gate.

Scope:

- Keep existing DevPortal project/workflow navigation, three-step wizard, workflow table, upload/demo, and review journeys.
- Update the existing DevPortal workflow service to call AiFlow Engine directly through the platform API gateway.
- Submit and consume canonical engine resources; legacy v1/v2 payloads are migration inputs only.
- Replace only Google/n8n-specific Step Two controls with connector configuration.
- Add direct browser-to-S3 upload to the existing demo/upload flow.
- Show engine execution status, error details, and safe retry in existing UI areas.
- Remove browser-generated `x-client-id`; derive tenant and actor from the validated token.
- Create, version, validate, activate, deactivate, and delete workflows through the engine.

Exit criteria:

- A user can create and activate the Phase 2 workflow using the existing three-step DevPortal flow.
- Existing routes, Redux organization, and general visual structure remain intact.
- Canonical UI/API contracts and legacy migration mappings are covered by separate contract tests.
- No n8n workflow, user, credential, tag, or database record is created for a new workflow.
- Legacy compatibility names do not appear in engine-core entities.

## Phase 4: SharePoint entry and destination

Purpose: support automatic document entry from Microsoft while converging on the same `DOCUMENT_STAGED` boundary.

Scope:

- Microsoft connection and consent flow.
- Site, drive/library, and folder selection.
- Subscription provisioning, renewal, and health status.
- Notification validation, deduplication, durable persistence, and fast acknowledgement.
- SharePoint ingestion worker with Graph-to-S3 streaming.
- Source identity/eTag deduplication and delta reconciliation.
- Graph throttling and per-connection concurrency controls.
- SharePoint destination actions where required.

Exit criteria:

- A new SharePoint document enters the same Phase 2 processing pipeline after staging.
- Duplicate notifications do not create duplicate document versions or destination effects.
- Missed notifications are recovered with delta reconciliation.
- Subscription expiry and renewal failures are visible and recoverable.
- Load tests cover provider throttling, tenant fairness, bursts, and large documents.

## Phase 5: templates and review

Purpose: absorb the remaining template and human-review responsibilities from the retired services.

Scope:

- Migrate personal-template ownership into the template module.
- Add review-required workflow configuration and execution state.
- Integrate with the existing Review System through an adapter.
- Handle authenticated approval/rejection callbacks idempotently.
- Resume approved executions and terminate rejected executions.
- Implement object retention, cleanup, and deletion reconciliation.

Exit criteria:

- Review waiting occupies no worker slot or RabbitMQ delivery.
- Duplicate review callbacks cannot resume an execution twice.
- Template behavior needed by migrated workflows is covered by compatibility tests.
- Retention and deletion jobs are auditable, retryable, and reconciled against S3.

## Phase 6: migration, cutover, and retirement

Purpose: move production ownership to AiFlow Engine safely.

Scope:

- Inventory and migrate compatible workflows, mappings, connections, and templates.
- Route newly created workflows only to AiFlow Engine.
- Shadow/compare representative results where safe.
- Drain or explicitly terminate old in-flight executions; do not silently migrate them.
- Preserve or redirect required public endpoints.
- Disable n8n workflow creation.
- Archive required audit/history data.
- Retire n8n, `n8n-service`, `aiflow-trigger-handler`, `aiflow-webhook-processor`, `aiflow-review-result`, and `personal-template-backend`.

Exit criteria:

- No production execution depends on n8n or a retired runtime service.
- Rollback and incident procedures have been exercised before final removal.
- Migrated workflow outputs match the agreed compatibility baseline.
- Queue, subscription, execution, DLQ, and destination health are visible to operators.
- Old infrastructure and credentials are removed only after the agreed observation period.

## Rules applying to every phase

- Plan and approve the phase contract before implementation.
- Add migrations and rollback/recovery instructions with every persistent-state change.
- Test tenant isolation, idempotency, crash recovery, and duplicate delivery where relevant.
- Never put document bytes, secrets, or presigned URLs in RabbitMQ messages or PostgreSQL.
- Do not rebuild the DevPortal frontend.
- Do not add a new platform service when an approved existing capability already satisfies the requirement.
- Keep one repository, one image, and separately deployable API/worker/scheduler roles until a measured boundary justifies a split.
