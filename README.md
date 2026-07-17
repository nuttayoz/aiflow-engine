# AiFlow Engine

AiFlow Engine is the single replacement repository for the n8n-based AiFlow runtime services. This repository currently contains only a compileable and testable project skeleton.

The existing DevPortal frontend is not part of this repository and will not be rebuilt. Its AiFlow screens will call this engine's canonical APIs directly. `devportal-backend` remains responsible for its existing non-AiFlow features and temporary legacy traffic, but it is not part of the new AiFlow runtime path.

## Runtime roles

One container image supports three independently deployable roles:

```bash
aiflow-engine api
aiflow-engine worker --queues=extract,map
aiflow-engine scheduler
```

- `api`: HTTP entry point. The skeleton exposes only liveness and readiness endpoints.
- `worker`: long-running application context. No consumers are registered yet.
- `scheduler`: long-running application context. No jobs are registered yet.

## Local setup

Requirements:

- Bun 1.3.14
- Node.js 24.18.0 LTS
- Docker for optional image verification

```bash
bun install --frozen-lockfile
bun run check
bun run build
bun run start:api
```

Health endpoints:

```text
GET /health/live
GET /health/ready
```

## Repository layout

```text
apps/
  api/
  worker/
  scheduler/
packages/
  core/
  config/
  database/
  messaging/
  storage/
  connector-sdk/
  connector-test-suite/
  workflows/
  connections/
  documents/
  executions/
  extraction/
  mappings/
  review/
  templates/
  connectors/
docs/
  architecture/
    principles.md
  contracts/
    auth-tenancy.md
    canonical-api-v1.md
    devportal-compatibility.md
    dynamics-destination-v1.md
    execution-lifecycle.md
    messaging-v1.md
    ocr-v1.md
    platform-baseline.md
    postgresql-v1.md
    review-v1.md
    sharepoint-entry-v1.md
    storage-v1.md
    workflow-provisioning-v1.md
    schemas/
      message-envelope.v1.schema.json
      extraction-result.v1.schema.json
      workflow-definition.v1.schema.json
  decisions/
    0000-template.md
    0001-current-stable-versions.md
    README.md
  roadmap.md
```

Infrastructure and domain packages are deliberately empty boundaries. PostgreSQL, RabbitMQ, S3, connector behavior, workflow state transitions, and DevPortal compatibility endpoints will be implemented phase by phase.

Implementation sequencing is defined in [`docs/roadmap.md`](docs/roadmap.md). Phase 0B contracts currently include the [`canonical API v1`](docs/contracts/canonical-api-v1.md), [`workflow provisioning v1`](docs/contracts/workflow-provisioning-v1.md), [`execution lifecycle`](docs/contracts/execution-lifecycle.md), [`RabbitMQ messaging v1`](docs/contracts/messaging-v1.md), [`PostgreSQL persistence v1`](docs/contracts/postgresql-v1.md), [`object storage v1`](docs/contracts/storage-v1.md), [`external OCR v1`](docs/contracts/ocr-v1.md), [`Microsoft Dynamics destination v1`](docs/contracts/dynamics-destination-v1.md), [`Microsoft SharePoint entry v1`](docs/contracts/sharepoint-entry-v1.md), [`human review v1`](docs/contracts/review-v1.md), [`DevPortal compatibility discovery`](docs/contracts/devportal-compatibility.md), and [`platform baseline`](docs/contracts/platform-baseline.md).

## Repository policy

The repository rules are intentionally split by purpose:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) is the team workflow, coding, testing, commit, review, and definition-of-done guide.
- [`AGENTS.md`](AGENTS.md) governs automated coding agents working in this repository.
- [`SECURITY.md`](SECURITY.md) defines confidential-data handling, authentication/tenancy expectations, and private vulnerability reporting.
- [`docs/architecture/principles.md`](docs/architecture/principles.md) contains the durable architecture laws.
- [`docs/decisions/`](docs/decisions/) contains the ADR process and template for important choices.

Commit messages and squash-merge PR titles follow Conventional Commits. Validate a message with:

```bash
bun run commitlint --edit .git/COMMIT_EDITMSG
```

## Scope guard

This repository does not build or operate DevPortal, authentication, Kubernetes, CI/CD, PostgreSQL, RabbitMQ, Redis, Sentry, Grafana, or OCR. It integrates with those existing platform capabilities in later phases.
