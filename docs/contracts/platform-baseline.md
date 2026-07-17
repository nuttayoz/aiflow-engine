# Platform Baseline

Status: Phase 0B discovery draft, 2026-07-16.

This document defines what AiFlow Engine can rely on from the existing platform, what the engine itself must provide, and which exact values still require platform-owner confirmation. It deliberately separates production facts from local development evidence and proposed defaults.

## Status labels

- **Confirmed:** agreed project direction or verified repository evidence.
- **Target:** an engine-owned rule that implementation must follow.
- **Proposed:** a starting value that requires owner approval or load-test evidence.
- **Open:** missing platform information that blocks the affected phase.

Local Docker Compose files and legacy application manifests are migration evidence. They are not proof of the current production managed-service version or guarantees.

## Discovery scope

The 2026-07-16 workspace snapshot contains application repositories but no production platform/IaC repository. The following revisions were inspected without reading `.env` files or secret objects:

| Repository                  | Revision       |
| --------------------------- | -------------- |
| `aiflow-trigger-handler`    | `7d5f9633af44` |
| `aiflow-webhook-processor`  | `85d2d46e78fd` |
| `aiflow-review-result`      | `e9b9e92d6e31` |
| `personal-template-backend` | `829d37bed2dc` |
| `n8n-service`               | `05e6c32cfe1c` |
| `devportal-backend`         | `c546a2fdedf2` |
| `devportal`                 | `2fc93d8ba136` |

The engine version targets are defined by [ADR-0001](../decisions/0001-current-stable-versions.md), but the versions actually available from the operated platform, topology, backup guarantees, KEDA availability, S3/KMS/IAM conventions, and authentication claims cannot be proven from this workspace. They remain platform inputs rather than application assumptions.

## Confirmed project baseline

| Concern           | Confirmed direction                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Hosting           | Existing AWS and Kubernetes platform; AiFlow Engine does not build a second platform.         |
| Runtime           | TypeScript compiled for Node.js 24.18.0 LTS; Bun 1.3.14 is the workspace/package tool.        |
| Deployment        | One image with independently deployable/scalable `api`, `worker`, and `scheduler` roles.      |
| Database          | PostgreSQL 18.4 target, with schema changes owned through TypeORM migrations.                 |
| Durable messaging | RabbitMQ 4.3.2 target through `amqplib`; Redis Pub/Sub is not a durable workflow command bus. |
| Storage           | Private Amazon S3 through AWS SDK v3; document bytes do not enter PostgreSQL or RabbitMQ.     |
| Identity          | Existing company authentication service; the engine does not issue user identities.           |
| Observability     | Existing Sentry and Grafana/Prometheus path; the engine supplies safe structured signals.     |
| Delivery          | Existing CI/CD and Kubernetes conventions remain platform-owned.                              |
| OCR               | Third-party capability behind an engine adapter; OCR itself is out of scope.                  |

## Legacy evidence and migration impact

| Evidence                                                                                                                              | What it proves                                                                              | Target impact                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `n8n-service/docker-compose.yml` and `devportal/docker-compose.yml` use `postgres:12-alpine`.                                         | PostgreSQL 12 was used for local legacy development.                                        | Do not infer the production version. Confirm the operated version before selecting migrations/features.                                         |
| Legacy TypeScript services use `pg`/TypeORM and database environment variables; DevPortal uses Knex with a legacy pool of 2-10.       | The team has PostgreSQL experience and existing relational data.                            | Use TypeORM migrations, but create a new connection budget from actual cluster capacity and planned replica counts.                             |
| Several legacy services expose `DB_SYNCHRONIZE`.                                                                                      | Legacy schemas could be auto-synchronized in some environments.                             | AiFlow Engine must keep TypeORM synchronization disabled everywhere and use reviewed migrations only.                                           |
| No RabbitMQ/AMQP client or deployment configuration was found in the inspected repositories.                                          | RabbitMQ is a new integration for this engine even though the platform already operates it. | Obtain the broker contract from platform owners; do not copy a legacy queue pattern.                                                            |
| Legacy AiFlow services use AWS SDK v3 with bucket/root-path variables and static access-key variables.                                | Existing flows already use S3 object storage.                                               | Keep AWS SDK v3, but replace static keys with EKS workload identity and secret references.                                                      |
| DevPortal backend uses Keycloak protection and the frontend derives `x-client-id` from token `sub`.                                   | The legacy actor identifier is tied to `sub`; exact tenant/project claims are not visible.  | Validate the platform token and derive actor/tenant authorization from trusted claims/services. Never accept `x-client-id` as tenant authority. |
| DevPortal backend has Kubernetes Deployments with two replicas, resource requests/limits, anti-affinity, and `secretKeyRef` examples. | Kubernetes application delivery patterns exist.                                             | Follow current platform conventions after obtaining the actual engine deployment template and service-account policy.                           |

## Security discovery

The tracked file `devportal-backend/deployment/pord/kube/devportal-backend-api.yaml` contains plaintext credential and outbound-webhook values. The values are intentionally not reproduced here.

Treat those values as exposed: rotate them, remove plaintext values from the current file and Git history according to the security team's process, and move them to the approved secret manager/Kubernetes secret integration. This is a legacy remediation item; AiFlow Engine must not copy the pattern.

## Target integration rules

### PostgreSQL

- Target PostgreSQL 18.4. Do not use the legacy PostgreSQL 12 development image for the engine.
- Use an engine-owned database or schema and least-privileged application identity.
- Use a separate migration identity/process where the platform supports it.
- Disable automatic schema synchronization; deploy reviewed, forward migrations.
- Use expand/migrate/contract changes that tolerate mixed-version Kubernetes rollouts.
- Require encrypted connections and platform-managed credentials.
- Obtain one total engine connection budget, then divide it across maximum API, worker, and scheduler replicas. Do not size pools independently.
- PostgreSQL remains the system of record for execution state, outbox, inbox, idempotency, leases, and audit facts.

The Phase 0B database/schema ownership, logical record model, tenancy constraints, concurrency, migration, connection-budget, retention, and recovery proposal is defined in [`postgresql-v1.md`](postgresql-v1.md).

### RabbitMQ

- Target RabbitMQ 4.3.2.
- Use a dedicated environment-specific vhost or equivalent platform isolation and least-privileged credentials.
- Use durable quorum queues when the operated version and policy support them.
- Use persistent messages, publisher confirms, mandatory routing, manual acknowledgements, bounded retry, and inspectable DLQs.
- Acknowledge only after durable PostgreSQL success; use outbox/inbox records for database-to-broker reliability and deduplication.
- Messages carry versioned identifiers and metadata only—never document bytes, credentials, tokens, or presigned URLs.
- KEDA is optional. Use it only if already approved by the platform; otherwise use the existing metrics/HPA path.

The Phase 0B envelope, bounded topology, acknowledgement boundary, business-retry separation, and DLQ proposal are defined in [`messaging-v1.md`](messaging-v1.md).

### Amazon S3

- Use a private bucket per environment or the platform-approved equivalent isolation.
- Use SSE-KMS, block public access, TLS, immutable tenant-scoped versioned object keys, and S3-validated SHA-256 metadata with explicit full/composite checksum type.
- Use EKS Pod Identity or IRSA. Static AWS access keys are forbidden.
- Use direct presigned uploads for API entry and worker streaming for SharePoint/provider entry.
- Keep presigned URLs short-lived and operation-specific; never persist or log them.
- Record deletion intent and retention in PostgreSQL; use S3 lifecycle as a safety net.

The Phase 0B bucket baseline, storage-object model, keys, checksums, upload/ingestion flows, exact-version reads/deletes, IAM, reconciliation, retention, and local/AWS test boundary are defined in [`storage-v1.md`](storage-v1.md).

### Authentication and tenancy

- Validate token signature, issuer, audience, algorithm, expiry, and required claims at the engine boundary.
- Normalize validated identity into separate actor, tenant, roles/permissions, project authorization, and service-identity concepts.
- Never authorize using a browser-generated tenant/client header.
- Keep connector credentials behind references to the approved secret owner; never store them in workflow definitions or messages.
- Authenticate callbacks/webhooks independently and bind their tenant to persisted connection/task ownership.

### Kubernetes and operations

- Scale API, worker queue groups, and scheduler independently from the same image.
- Use role-specific service accounts/IAM permissions, resource requests/limits, probes, graceful shutdown, disruption budgets, and topology spreading.
- Keep provider concurrency limits in the application so autoscaling cannot overwhelm OCR, Microsoft Graph, or Dynamics.
- Integrate Pino JSON logs, Sentry, metrics, and OpenTelemetry with existing platform endpoints. Signals contain correlation IDs, not confidential document/provider data.
- Redis may support disposable caches, rate limits, or UI notification hints only. Correctness must not depend on Redis Pub/Sub delivery.
- If Redis is introduced, target Redis Open Source 8.8 and pin its client/test versions at that phase.

## Proposed initial engineering envelope

These are test targets, not customer SLAs. Platform and product owners must accept or replace them before Phase 0B closes.

| Concern                       | Proposed starting value                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| Public API availability       | 99.9% monthly, excluding declared maintenance and third-party outages |
| Disaster recovery             | RPO 15 minutes; RTO 4 hours, limited by existing platform guarantees  |
| Ordinary API latency          | p95 below 500 ms, excluding provider calls and direct upload transfer |
| Sustained acceptance test     | 10 documents/second for one hour across tenants                       |
| Burst acceptance test         | 50 documents/second for 10 minutes without loss                       |
| Tenant fairness test          | At least 100 concurrently active tenants                              |
| Source document limit         | 100 MiB and 500 pages, configurable below a platform hard cap         |
| Raw/derived object retention  | 30 days after terminal execution                                      |
| Execution and audit retention | 1 year                                                                |
| Idempotency retention         | Initially 90 days, never shorter than the external replay window      |

Production measurements must replace assumptions about document size, pages, provider duration, destination latency, and tenant distribution.

## Required platform confirmations

| ID           | Owner             | Confirmation required                                                                                       | Blocks                   |
| ------------ | ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| `PG-01`      | Platform/DBA      | Confirm PostgreSQL 18.4 availability and supported extensions/features                                      | Migration implementation |
| `PG-02`      | Platform/DBA      | Total engine connection budget and proxy/pooler convention                                                  | Replica and pool sizing  |
| `PG-03`      | Platform/DBA      | TLS/CA, database/schema ownership, application and migration identities                                     | Database connection      |
| `PG-04`      | Platform/DBA      | Migration execution/approval process, backups/PITR, confirmed RPO/RTO                                       | Phase 1 recovery proof   |
| `RMQ-01`     | Platform          | Confirm RabbitMQ 4.3.2, node/AZ topology, quorum queue and policy support                                   | Queue topology           |
| `RMQ-02`     | Platform          | TLS/CA, authentication, vhost naming, permissions, maximum message and queue policies                       | Broker connection        |
| `RMQ-03`     | Platform          | KEDA availability or approved RabbitMQ-metrics/HPA alternative                                              | Worker autoscaling       |
| `S3-01`      | Platform/Security | AWS account/Region, bucket naming/ownership, versioning, Block Public Access, and infrastructure owner      | Storage adapter          |
| `S3-02`      | Platform/Security | KMS key/alias, key policy, S3 Bucket Key approval, rotation, and recovery behavior                          | Storage encryption       |
| `S3-03`      | Platform/Security | Pod Identity/IRSA roles, exact IAM/KMS actions including API checksum verification, and VPC/bucket policies | Storage authentication   |
| `S3-04`      | Platform/Security | Browser origins, regional endpoint, CORS, signature-age cap, and gateway behavior                           | Direct upload            |
| `S3-05`      | Platform/Security | Lifecycle, noncurrent/delete-marker cleanup, inventory/audit logging, replication, and restore              | Retention and recovery   |
| `AUTH-01`    | Auth team         | JWT versus opaque token; issuer/discovery/JWKS, audience, algorithms and token lifetime                     | Authentication guard     |
| `AUTH-02`    | Auth/Product      | Exact actor, tenant, role/scope, token-ID and service-identity claims; multi-tenant selection               | Tenant context           |
| `AUTH-03`    | Auth/Platform     | Project authorization contract, service authentication, timeout and revocation behavior                     | Resource authorization   |
| `OPS-01`     | Platform          | Existing CI template, deployment values convention, secret manager, Sentry/metrics/trace endpoints          | Production delivery      |
| `PRODUCT-01` | Product/Security  | File/page limits, types, malware controls, retention, availability, throughput, RPO and RTO targets         | Contract freeze          |

## Phase decision

The architecture direction is stable, but platform integration is not implementation-ready until the relevant rows above are confirmed. Phase 0B can continue defining provider-independent contracts; Phase 1 infrastructure code must not guess these values.
