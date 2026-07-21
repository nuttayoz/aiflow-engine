# PostgreSQL Operations

This runbook covers the Phase 1 PostgreSQL foundation. PostgreSQL is
authoritative for workflow, provisioning, storage metadata, document, execution,
idempotency, inbox/outbox, audit, and scheduler state.

## Local development

Requirements:

- Bun 1.3.14
- Docker with Compose

Start the exact PostgreSQL 18.4 image, build, and run the migration command:

```bash
cp .env.example .env
bun run db:up
bun run db:migrate
```

The Compose database is local-only and creates three identities:

| Identity           | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `aiflow_bootstrap` | Local container initialization only         |
| `aiflow_migration` | Owns/changes the `aiflow` schema            |
| `aiflow_app`       | Runtime DML; cannot create schema or tables |

The passwords in Compose and `.env.example` are synthetic local values. Never reuse them outside the local container.

AiFlow binds PostgreSQL to loopback host port `55439` by default to avoid existing development databases on common PostgreSQL ports and to prevent LAN exposure. Set `AIFLOW_POSTGRES_PORT` and matching local URLs only when another isolated port is required.

Useful commands:

```bash
bun run db:logs
bun run db:down
bun run test:integration
```

`bun run db:reset` deletes the Compose volume and all local engine data. It cannot target a remote database because it only removes this repository's named Compose resources.

## Migration boundary

The same built-image command is used locally and by CI/CD:

```bash
aiflow-engine migrate
```

Locally, `bun run db:migrate` builds first and invokes that command. The migration process:

1. loads only `DATABASE_MIGRATION_URL`;
2. creates the validated engine schema when absent;
3. initializes the TypeORM migration data source with `synchronize: false` and `migrationsRun: false`;
4. holds one schema-specific PostgreSQL advisory lock to prevent concurrent
   migration commands;
5. applies the ordered migration stream transactionally;
6. releases the lock, closes the migration connection, and emits only migration
   names/counts.

API, worker, and scheduler load only `DATABASE_URL`. They never receive or fall back to migration credentials. Runtime startup initializes one bounded pool per process and fails closed when PostgreSQL is unavailable.

## Readiness and safe diagnostics

- `GET /health/live` reports only process liveness.
- `GET /health/ready` executes `SELECT 1` through the runtime identity.
- Database failure returns `503` with `DATABASE_UNAVAILABLE`; connection URLs and driver errors are not returned or logged.
- TypeORM query logging and schema synchronization are disabled.

## Rollout and recovery

The foundation schema is an additive transactional migration with no data
backfill. It creates the Phase 1 domain tables, composite tenant foreign keys,
state guards, and known-query indexes.

Production rollout order:

1. Platform provisions the engine database, TLS trust, migration identity, runtime identity, and connection budget.
2. CI/CD runs `aiflow-engine migrate` once using the migration identity.
3. API, worker, and scheduler roll out with the runtime identity.
4. Readiness and pool metrics are observed before increasing replicas.

Rollback uses the previous application image. Do not automatically run
destructive down migrations. The `aiflow` schema and TypeORM migration history
remain in place for forward repair or the next compatible image. Each later
persistent migration must add its own lock/performance, mixed-version, backfill,
and recovery instructions before merge.

For a failed migration, stop the rollout, retain the database state and migration logs, determine whether PostgreSQL committed the transaction, then use the migration-specific forward repair or approved restore procedure. Never edit the migration-history table manually.
