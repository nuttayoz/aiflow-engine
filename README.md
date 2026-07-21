# AiFlow Engine

AiFlow Engine is the single replacement repository for the n8n-based AiFlow
runtime services. Phase 2 provides a runnable direct-upload proof: canonical
APIs, immutable S3 staging, fake external OCR, deterministic mapping, and one
effective-once Microsoft Business Central draft action. SharePoint, human
review, real provider adapters, and the existing DevPortal migration remain in
later roadmap phases.

The existing DevPortal frontend is not part of this repository and will not be rebuilt. Its AiFlow screens will call this engine's canonical APIs directly. `devportal-backend` remains responsible for its existing non-AiFlow features and temporary legacy traffic, but it is not part of the new AiFlow runtime path.

## Runtime roles

One container image supports three independently deployable roles:

```bash
aiflow-engine api
aiflow-engine worker --queues=extract,map
aiflow-engine scheduler
```

- `api`: canonical workflow, catalog, upload, and execution APIs plus health.
- `worker`: consumes independently selectable provisioning and stage queues.
- `scheduler`: publishes the transactional outbox and recovers expired leases and
  due retries under database leadership.

## Local setup

Requirements:

- Bun 1.3.14
- Node.js 24.18.0 LTS
- Docker with Compose for local PostgreSQL, RabbitMQ, Moto S3, and integration tests

```bash
bun install --frozen-lockfile
cp .env.example .env
bun run phase2:prepare
bun run check
bun run test:integration
```

Start each independently scalable role in its own terminal:

```bash
bun run start:api
bun run start:worker
bun run start:scheduler
```

Then prove the complete Phase 2 flow from a fourth terminal:

```bash
bun run phase2:smoke
```

The smoke command starts isolated API, worker, and scheduler processes, creates
and activates an invoice workflow through `/api/v1`, uploads a small document
directly to local S3, and waits for EXTRACT, MAP, and Business Central DELIVER to
succeed. Document bytes do not pass through the API, PostgreSQL, or RabbitMQ.

To use the disposable DevPortal-shaped browser harness, keep the three runtime
roles above running and start:

```bash
bun run phase2:demo
```

Open `http://localhost:4173`. The harness uses the shared
`@aiflow/api-client`, local token `aiflow-demo-token-a`, and project
`demo-project-a`. The demo identity and fake OCR/Business Central adapters are
non-production composition only; production startup fails closed until the real
platform authentication and external-provider adapters are configured.

Runtime configuration comes only from validated environment variables. Copy `.env.example` to `.env` only for local values and never commit `.env` or real credentials. Bun loads the local file for repository scripts. JSON logs include service, runtime role, environment, event, and request correlation fields while omitting request bodies, query strings, authorization headers, and known secret fields.

PostgreSQL uses separate runtime and migration URLs. API, worker, and scheduler
never load migration credentials. The migration command also holds a database
advisory lock. See the [PostgreSQL runbook](docs/operations/postgresql.md) for
local identities, reset, rollout, and recovery behavior.

For dead-letter inspection and bounded confirmed replay, see the
[RabbitMQ runbook](docs/operations/rabbitmq.md).

Health endpoints:

```text
GET /health/live
GET /health/ready
```

Prometheus metrics are exposed on a separate internal listener at `/metrics`.
Local defaults are ports `9464` (API), `9465` (worker), and `9466`
(scheduler). OpenTelemetry uses the standard API so the platform tracer can
install its provider, and Sentry is enabled only when `SENTRY_DSN` is supplied.

Readiness returns `503 DATABASE_UNAVAILABLE` until the runtime identity can execute a bounded PostgreSQL probe. Run the exact-version integration suite separately with `bun run test:integration`.

## Repository layout

```text
apps/
  api/
  worker/
  scheduler/
packages/
  core/
  config/
  observability/
  database/
  messaging/
  storage/
  connector-sdk/
  connector-test-suite/
  api-client/
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
  operations/
    postgresql.md
  contracts/
    auth-tenancy.md
    canonical-api-v1.md
    devportal-compatibility.md
    dynamics-destination-v1.md
    execution-lifecycle.md
    extraction-templates-v1.md
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
      extraction-template-definition.v1.schema.json
      workflow-definition.v1.schema.json
  decisions/
    0000-template.md
    0001-current-stable-versions.md
    README.md
  roadmap.md
tools/
  demo-ui/
```

The Business Central package in Phase 2 contains the action descriptor,
effective-once delivery processor, and a deterministic fake adapter. Real
provider credentials and network calls remain behind the same port for a later
deployment slice.

Implementation sequencing is defined in [`docs/roadmap.md`](docs/roadmap.md). Phase 0B contracts currently include the [`canonical API v1`](docs/contracts/canonical-api-v1.md), [`workflow provisioning v1`](docs/contracts/workflow-provisioning-v1.md), [`execution lifecycle`](docs/contracts/execution-lifecycle.md), [`RabbitMQ messaging v1`](docs/contracts/messaging-v1.md), [`PostgreSQL persistence v1`](docs/contracts/postgresql-v1.md), [`object storage v1`](docs/contracts/storage-v1.md), [`external OCR v1`](docs/contracts/ocr-v1.md), [`custom extraction templates v1`](docs/contracts/extraction-templates-v1.md), [`Microsoft Dynamics destination v1`](docs/contracts/dynamics-destination-v1.md), [`Microsoft SharePoint entry v1`](docs/contracts/sharepoint-entry-v1.md), [`human review v1`](docs/contracts/review-v1.md), [`DevPortal compatibility discovery`](docs/contracts/devportal-compatibility.md), and [`platform baseline`](docs/contracts/platform-baseline.md).

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

This repository does not build or operate DevPortal, authentication, Kubernetes, CI/CD, production PostgreSQL, RabbitMQ, Redis, Sentry, Grafana, or OCR. It supplies engine adapters, migrations, health checks, and local test infrastructure while the existing platform continues to own production services.
