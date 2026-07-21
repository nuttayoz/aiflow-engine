# Phase 2 Demo Runbook

This runbook proves the direct-upload Phase 2 journey without n8n or changes to
the real DevPortal.

## Automated proof

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run phase2:prepare
bun run phase2:smoke
```

The smoke command builds the repository, starts temporary API, worker, and
scheduler processes, and uses only the public canonical API plus the returned
presigned S3 capability. Success prints one execution with `EXTRACT`, `MAP`, and
`DELIVER` succeeded and `REVIEW` skipped.

## Browser proof

Start the roles in separate terminals:

```bash
bun run start:api
bun run start:worker
bun run start:scheduler
```

Then start the disposable UI:

```bash
bun run phase2:demo
```

Open `http://localhost:4173`, create and activate a workflow, then upload a
document. The UI calls only `@aiflow/api-client`; it has no database, RabbitMQ,
or worker access.

Local identity fixtures:

| Token                 | Tenant          | Project          |
| --------------------- | --------------- | ---------------- |
| `aiflow-demo-token-a` | `demo-tenant-a` | `demo-project-a` |
| `aiflow-demo-token-b` | `demo-tenant-b` | `demo-project-b` |

These are deterministic non-secret local fixtures. The demo validator and fake
OCR/Business Central adapters cannot be selected in production. A production
deployment requires the existing platform authentication adapter and approved
real provider adapters.

## Expected flow

```text
create workflow -> activate -> create upload session -> browser PUT to S3
-> complete session -> EXTRACT -> MAP -> DELIVER -> SUCCEEDED
```

If a destination write times out, the execution waits while the scheduler
requests lookup by stable effect key. Confirmed application completes the
original execution, confirmed non-application schedules a safe retry, and an
unresolved deadline fails visibly instead of blindly writing again.
