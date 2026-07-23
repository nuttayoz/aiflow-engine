# AiFlow Engine Implementation Roadmap

This roadmap controls implementation order. A phase starts only after its entry gate is agreed, and it finishes only when its exit criteria are demonstrated.

## Status overview

| Stage    | Outcome                            | Status        |
| -------- | ---------------------------------- | ------------- |
| Phase 0A | Repository skeleton                | Complete      |
| Phase 0B | Contract and platform discovery    | Complete      |
| Phase 1  | Reliable engine foundation         | Code complete |
| Phase 2  | Direct-upload proof and demo       | Complete      |
| Phase 3  | Existing DevPortal compatibility   | In progress   |
| Phase 4  | SharePoint entry and destination   | Not started   |
| Phase 5  | Templates and review               | Not started   |
| Phase 6  | Migration, cutover, and retirement | Not started   |

Phase 2 is complete. Phase 3 compatibility implementation is in progress;
Phase 4 and later product behavior is not implemented.

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

Status: complete.

Purpose: remove implementation ambiguity before building the reliability foundation.

Progress:

- DevPortal compatibility discovery baseline: [`contracts/devportal-compatibility.md`](contracts/devportal-compatibility.md).
- Direct canonical API v1 and workflow-definition envelope: [`contracts/canonical-api-v1.md`](contracts/canonical-api-v1.md).
- Authentication, tenancy, permission, and project-authorization contract: [`contracts/auth-tenancy.md`](contracts/auth-tenancy.md).
- Platform baseline, verified legacy evidence, target integration rules, and owner-confirmation checklist: [`contracts/platform-baseline.md`](contracts/platform-baseline.md).
- Provider-neutral execution lifecycle, guarded transitions, attempts, retries, waits, leases, and recovery: [`contracts/execution-lifecycle.md`](contracts/execution-lifecycle.md).
- RabbitMQ v1 envelope, bounded topology, delivery semantics, retry separation, and DLQ handling: [`contracts/messaging-v1.md`](contracts/messaging-v1.md).
- PostgreSQL v1 ownership, logical records, tenancy constraints, concurrency, migrations, connection budget, retention, and recovery: [`contracts/postgresql-v1.md`](contracts/postgresql-v1.md).
- Object storage v1 bucket controls, storage-object model, direct/provider transfer, integrity, exact-version lifecycle, retention, and test boundary: [`contracts/storage-v1.md`](contracts/storage-v1.md).
- External OCR v1 provider capabilities, durable requests, authenticated callback hints, reconciliation, canonical result artifact, quotas, and deletion boundary: [`contracts/ocr-v1.md`](contracts/ocr-v1.md).
- Microsoft Dynamics destination v1 product separation, connection/action descriptors, stable effect identity, receipt, unknown-outcome reconciliation, and Business Central draft recommendation: [`contracts/dynamics-destination-v1.md`](contracts/dynamics-destination-v1.md).
- Workflow provisioning v1 activation API, operation lifecycle, connector capability modes, atomic version replacement, deactivation, and recovery: [`contracts/workflow-provisioning-v1.md`](contracts/workflow-provisioning-v1.md).
- Microsoft SharePoint entry v1 connection/permission boundary, shared drive watch, callback, delta inventory, Graph-to-S3 ingestion, renewal, handover, and scaling: [`contracts/sharepoint-entry-v1.md`](contracts/sharepoint-entry-v1.md).
- Human review v1 engine-owned task/decision state, DevPortal content and direct-S3 preview, Review System adapter requirements, idempotent execution resumption, expiry, and cleanup: [`contracts/review-v1.md`](contracts/review-v1.md).
- Custom extraction templates v1 tenant-owned authoring, immutable profile versions, deterministic output schema, workflow freeze, legacy migration, and no-direct-invoke boundary: [`contracts/extraction-templates-v1.md`](contracts/extraction-templates-v1.md).

Required decisions:

1. Confirm PostgreSQL 18.4 availability, connection budget, migration process, backup/PITR guarantees, RPO, and RTO.
2. Confirm RabbitMQ 4.3.2 availability, cluster topology, quorum queue support, TLS/authentication, virtual-host convention, and KEDA availability.
3. Confirm the bucket, KMS, IAM, CORS, lifecycle, private-connectivity, and product values proposed by [`contracts/storage-v1.md`](contracts/storage-v1.md).
4. Authentication token validation plus canonical tenant, actor, role, and service-identity claims.
5. Confirm the provider/product values and capabilities required by [`contracts/ocr-v1.md`](contracts/ocr-v1.md).
6. Confirm the product, action, endpoint, authentication, effect extension, and schema values required by [`contracts/dynamics-destination-v1.md`](contracts/dynamics-destination-v1.md).
7. Confirm the operation UX, limits, connector-version support, cleanup, and archive values required by [`contracts/workflow-provisioning-v1.md`](contracts/workflow-provisioning-v1.md).
8. Confirm the identity/permission, product limits, callback/network, timing, retention, and UX values required by [`contracts/sharepoint-entry-v1.md`](contracts/sharepoint-entry-v1.md).
9. Confirm the product, authorization, existing Review System, browser access, callback, feedback/signature, retention, and cutover values required by [`contracts/review-v1.md`](contracts/review-v1.md).
10. Confirm the deployed template service, tenant/permission model, output semantics, provider mapping, direct-invoke/collection consumers, authoring UI, migration, and cutover values required by [`contracts/extraction-templates-v1.md`](contracts/extraction-templates-v1.md).
11. Existing DevPortal endpoints, request/response shapes, and workflow payloads that the compatibility layer must preserve.
12. Initial retention, file-size, page-count, throughput, availability, and latency targets.

Deliverables:

- Versioned integration-contract notes or ADRs.
- Initial canonical API resource names and error envelope.
- Initial execution states and transition table: [`contracts/execution-lifecycle.md`](contracts/execution-lifecycle.md).
- Initial RabbitMQ exchange/queue/message naming proposal: [`contracts/messaging-v1.md`](contracts/messaging-v1.md).
- Initial PostgreSQL ownership and migration proposal: [`contracts/postgresql-v1.md`](contracts/postgresql-v1.md).
- Initial Amazon S3 ownership, transfer, integrity, retention, and local-development proposal: [`contracts/storage-v1.md`](contracts/storage-v1.md).
- Initial external OCR request, callback, reconciliation, canonical artifact, quota, and deletion proposal: [`contracts/ocr-v1.md`](contracts/ocr-v1.md).
- Initial Microsoft Dynamics destination connection, action, effective-once write, receipt, and reconciliation proposal: [`contracts/dynamics-destination-v1.md`](contracts/dynamics-destination-v1.md).
- Initial n8n-free workflow activation, connector provisioning, version cutover, deactivation, and recovery proposal: [`contracts/workflow-provisioning-v1.md`](contracts/workflow-provisioning-v1.md).
- Initial SharePoint Online connection, subscription, callback, delta, ingestion, renewal, recovery, and scaling proposal: [`contracts/sharepoint-entry-v1.md`](contracts/sharepoint-entry-v1.md).
- Initial human-review task, artifact, presentation, decision, expiry, retry, cleanup, and DevPortal compatibility proposal: [`contracts/review-v1.md`](contracts/review-v1.md).
- Initial custom extraction-template authoring, immutable profile projection, output schema, workflow binding, migration, and compatibility proposal: [`contracts/extraction-templates-v1.md`](contracts/extraction-templates-v1.md).
- Compatibility inventory for the existing DevPortal and `devportal-backend`.

Exit criteria:

- Phase 1 has no unresolved PostgreSQL, RabbitMQ, S3, authentication, or tenancy dependency.
- Phase 2 has documented OCR and Dynamics integration contracts.
- Legacy UI compatibility requirements are listed rather than inferred during implementation.
- Template authoring/invocation/collection consumers and deployed behavior are inventoried rather than inferred from the stale default branch.

## Phase 1: reliable engine foundation

Status: code complete; platform validation pending.

Purpose: prove that execution state and commands cannot be lost before adding real document processing.

Implemented in this foundation slice:

- Validated runtime/API configuration and bounded PostgreSQL runtime configuration for the next database slice.
- Framework-independent request and canonical authorization-context types with asynchronous correlation isolation.
- Pino JSON logging shared by API, worker, and scheduler roles with defensive secret redaction and safe startup failures.
- API correlation-header propagation and bounded request-completion logs that exclude bodies, query strings, and headers.
- PostgreSQL 18.4 local/test environment with separate bootstrap, migration, and runtime identities.
- Bounded TypeORM runtime pools, migration-only schema ownership, transactional migration command, lifecycle shutdown, and database-aware readiness.
- Exact-version integration coverage proving runtime DML access and denial of runtime DDL.
- Reviewed Phase 1 schema for workflows, versions, frozen profiles, provisioning,
  storage objects, documents, executions, stages, attempts, idempotency, inbox,
  outbox, audit, and scheduler leases.
- Tenant-scoped PostgreSQL repositories, guarded execution transitions,
  activation idempotency, atomic active-version switching, and transactional
  outbox writes.
- RabbitMQ 4.3.2 durable topic topology, quorum queues, confirmed mandatory
  publication, manual acknowledgement, bounded redelivery, inspectable DLQs, and
  validated confirmed replay.
- Outbox publisher, worker inbox deduplication, execution leases, expired-lease
  recovery, retry scheduling, and scheduler leadership using database time.
- AWS S3 adapter with immutable conditional writes, streaming reads/writes,
  full-object SHA-256 validation, exact-version operations, and deletion tests
  against pinned Moto 5.2.2.
- Connector SDK, configuration schema validation, capability hashing, shared
  connector checks, direct-upload entry descriptor, and non-production synthetic
  destination.
- Prometheus metrics for every runtime role, OpenTelemetry spans, optional
  redacted Sentry reporting, and append-only audit facts.
- A runnable smoke command proving activation and synthetic
  EXTRACT -> MAP -> DELIVER across separate scheduler and worker processes.

Implementation order:

1. Configuration, secret references, tenant context, correlation identifiers, and structured logging.
2. PostgreSQL connection, migrations, module-owned repositories, and health checks.
3. Workflow, workflow-version, frozen extraction-profile reference, activation-operation, document, execution, stage-attempt, idempotency, inbox, and outbox records.
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
- A duplicate or interrupted workflow activation produces one operation and one atomic active-version switch.
- Duplicate messages do not duplicate a stage transition.
- A worker crash before acknowledgement causes safe redelivery.
- Exhausted retries appear in an inspectable DLQ and can be safely replayed.
- Scheduler failover does not run the same reconciliation job concurrently.
- S3 contract tests prove streaming, checksum validation, immutable keys, and deletion behavior.
- Tenant isolation tests cover every repository and public API query.

Verification:

- `bun run check` passes all static gates and unit tests.
- `bun run test:integration` proves PostgreSQL 18.4, RabbitMQ 4.3.2, and S3
  adapter contracts in pinned containers.
- `bun run phase1:smoke` proves real local PostgreSQL, RabbitMQ, and object-storage
  flow with separate worker and scheduler runtimes.
- Phase 1 exposes only health queries publicly; canonical workflow/upload APIs
  remain a Phase 2 deliverable and therefore add no untrusted tenant query yet.
- Final production approval still requires the platform-owned disposable AWS S3
  contract run and confirmation of managed PostgreSQL/RabbitMQ controls listed in
  Phase 0B; these are deployment validations, not missing engine code.

## Phase 2: direct-upload proof with internal demo harness

Status: complete.

Purpose: deliver and demonstrate one complete workflow without n8n, review, or changes to the real DevPortal.

Implemented:

- Provider-neutral upload-session lifecycle with explicit active/completed/
  aborted/expired states, guarded transitions, and idempotent terminal replay.
- Additive PostgreSQL upload-session schema plus tenant-scoped, idempotent
  reservation, multipart binding, abort, expiry, audit, and storage-abandonment
  persistence.
- Provider-neutral direct-upload storage capabilities backed by checksum-bound,
  short-lived S3 single-PUT and multipart URLs, conditional completion, and
  explicit multipart abort.
- Direct-upload application planning with server-owned size limits, automatic
  single/multipart selection, durable multipart binding, and safe retry
  reconciliation that never exposes the storage upload reference.
- Immutable multipart-part checksum/size pinning with exact final-part sizing,
  idempotent capability refresh, tenant isolation, and changed-file rejection.
- Verified single/multipart completion with exact S3 metadata, lost-response
  reconciliation, and one atomic document, execution, stage, outbox,
  idempotency, and audit commit guarded by the pinned workflow version.
- Additive pipeline persistence for immutable extraction/mapping artifacts,
  durable provider requests, authenticated callback deduplication, and stable
  destination effects/receipts.
- Frozen `invoice-basic-v1` extraction profile, bounded canonical result
  validation, fake-provider submission/reconciliation, HMAC callback
  authentication, and outage/throttle/timeout test modes.
- Deterministic mapping into the Business Central purchase-invoice-draft action
  with immutable S3 output and payload hashing.
- Business Central descriptor and effective-once delivery processor with safe
  throttling retry, uncertain-write lookup, deadline failure, and durable
  receipt state.
- API, worker, and scheduler composition for the complete flow, including due
  retry/reconciliation scans and expired-upload cleanup.
- Bearer-protected canonical workflow/catalog/upload/execution endpoints with
  tenant/project isolation, idempotent mutations, safe failure details, audit
  facts, and guarded pre-delivery execution retry.
- Shared typed `@aiflow/api-client`, frozen Phase 2 request/response fixtures,
  and a disposable DevPortal-shaped browser harness under `tools/demo-ui`.
- Automated Phase 2 smoke proof using only public APIs and presigned S3 transfer,
  including API restart after durable upload acceptance.

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
- The real frontend and `devportal-backend` repositories remain unchanged throughout Phase 2.

Verification:

- `bun run check` passes static analysis, type checking, unit tests, and format checks.
- `bun run test:integration` passes real PostgreSQL, RabbitMQ, and local
  S3-compatible integration contracts, including callback deduplication and
  destination lease-expiry reconciliation.
- `bun run phase2:smoke` proves canonical API -> S3 -> OCR -> mapping -> Business
  Central delivery across separate runtime processes and an API restart.
- The browser harness creates/activates a workflow and completes an uploaded
  document with `EXTRACT`, `MAP`, and `DELIVER` succeeded and `REVIEW` skipped.
- Fake identity/provider adapters fail closed for production composition; real
  platform/provider adapters remain explicit Phase 3/deployment work.

## Phase 3: existing DevPortal compatibility and provisioning

Status: in progress; the source compatibility baseline has been revalidated and
canonical workflow lifecycle gaps are the first implementation slice.

Purpose: make the new engine fit the current UI rather than rebuilding the frontend.

Entry gate: Phase 2 has passed its engine reliability, end-to-end demo, and canonical-contract exit criteria. The real `devportal-frontend` is not modified before this gate.

Scope:

- Keep the existing `devportal-frontend` project/workflow navigation, workflow builder sections, workflow table, upload/demo, execution, and review journeys.
- Update the existing workflow API/query layer to call AiFlow Engine through the same-origin Next.js BFF and platform API gateway.
- Submit and consume canonical engine resources; legacy v1/v2 payloads are migration inputs only.
- Replace only Google/n8n-specific Step Two controls with connector configuration.
- Add direct browser-to-S3 upload to the existing demo/upload flow.
- Show engine execution status, error details, and safe retry in existing UI areas.
- Do not send `x-client-id` to AiFlow Engine; the BFF forwards bearer authentication and the engine derives tenant and actor from the validated token.
- Create, version, validate, activate, deactivate, and delete workflows through the engine.

Implemented Phase 3 slices:

- Immutable workflow-version create/list/get APIs with optimistic edit context,
  idempotent creation, tenant/project authorization, audit facts, and typed
  client support for both direct-bearer and same-origin BFF composition.
- Activation-state projection plus immediate, idempotent intake closure for the
  current non-managed connectors, including operation serialization, audit
  facts, stored replay results, and upload-gate smoke coverage.
- Archive-only workflow removal with inactive/provisioning/cleanup guards,
  retained history, idempotent audit behavior, normal-list filtering, and typed
  client/smoke coverage.
- Connector and extraction-profile list/detail catalogs with capability
  filtering, stable safe projections, explicit lookup errors, and typed client
  support for the existing wizard.

Exit criteria:

- A user can create and activate the Phase 2 workflow using the existing DevPortal builder journey.
- Existing App Router paths, TanStack Query/Zustand ownership, feature boundaries, and general visual structure remain intact.
- Canonical UI/API contracts and legacy migration mappings are covered by separate contract tests.
- No n8n workflow, user, credential, tag, or database record is created for a new workflow.
- Legacy compatibility names do not appear in engine-core entities.

## Phase 4: SharePoint entry and destination

Purpose: support automatic document entry from Microsoft while converging on the same `DOCUMENT_STAGED` boundary.

Contract: [`contracts/sharepoint-entry-v1.md`](contracts/sharepoint-entry-v1.md).

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

- Implement tenant-owned custom extraction templates and immutable versions in `packages/templates` according to [`contracts/extraction-templates-v1.md`](contracts/extraction-templates-v1.md).
- Project each custom template/version through the existing extraction-profile catalog and freeze the exact profile version/output schema in workflow versions.
- Migrate required personal-template definitions and workflow endpoint references without live runtime lookups.
- Keep documents on the normal upload/connector -> S3 -> execution -> extraction path; do not add a template `/invoke` API.
- Migrate, redirect, reassign, or visibly block retirement for every confirmed direct single/multiple-file or document-collection consumer under an approved separate contract.
- Implement the review-required workflow policy and engine-owned review task state defined by [`contracts/review-v1.md`](contracts/review-v1.md).
- Reuse the existing DevPortal review list/page with opaque task IDs, bounded engine content, and direct-S3 source preview.
- Integrate the existing Review System through a presentation adapter only after its production eligibility is proven; otherwise use engine-native presentation behind the same DevPortal page.
- Handle authenticated DevPortal decisions and any approved provider callbacks idempotently.
- Commit revised review artifacts, resume approved executions once, and terminate rejected/expired executions.
- Implement provider-copy and object retention, cleanup, and deletion reconciliation.

Exit criteria:

- Template create/version/archive is tenant-isolated, idempotent, bounded, and never accepts document bytes or provider/model endpoints.
- Workflow versions freeze immutable custom profile versions; template edits cannot change active or historical executions.
- Migrated field/table definitions and output paths pass representative compatibility fixtures without a runtime call to `personal-template-backend`.
- Every confirmed direct-invoke, customer/engine-admin, and collection caller has an approved migration/owner; unresolved callers visibly block legacy service retirement.
- Review waiting occupies no worker slot or RabbitMQ delivery.
- Duplicate decisions/callbacks and concurrent approve/reject races cannot resume an execution twice.
- Source documents preview directly from exact-version S3 and review content/capabilities never enter lists, messages, logs, or PostgreSQL.
- Delivery after approval uses the exact immutable approved artifact and stable destination effect identity.
- DevPortal compatibility tests cover list, view, approve, reject, expiry, conflict, and navigation without legacy tokens or trusted headers.
- Template behavior needed by migrated workflows is covered by compatibility tests, including ambiguous/colliding definitions that must fail migration visibly.
- Retention and deletion jobs are auditable, retryable, and reconciled against S3 and supported provider copies.

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
