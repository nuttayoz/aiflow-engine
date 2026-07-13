# AiFlow Engine

AiFlow Engine is the single replacement repository for the n8n-based AiFlow runtime services. This repository currently contains only a compileable and testable project skeleton.

The existing DevPortal frontend is not part of this repository and will not be rebuilt. `devportal-backend` remains the initial compatibility layer between the current UI contracts and this engine's future canonical APIs.

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

- Bun 1.3.10
- Node.js 24 LTS
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
  roadmap.md
```

Infrastructure and domain packages are deliberately empty boundaries. PostgreSQL, RabbitMQ, S3, connector behavior, workflow state transitions, and DevPortal compatibility endpoints will be implemented phase by phase.

## Scope guard

This repository does not build or operate DevPortal, authentication, Kubernetes, CI/CD, PostgreSQL, RabbitMQ, Redis, Sentry, Grafana, or OCR. It integrates with those existing platform capabilities in later phases.
