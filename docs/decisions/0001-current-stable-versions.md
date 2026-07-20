# ADR-0001: Use Current Stable Compatible Versions

- Status: Accepted
- Date: 2026-07-16
- Owners: `@nuttayoz`
- Related: Phase 0B, `docs/contracts/platform-baseline.md`

## Context

The legacy local stacks use PostgreSQL 12, but AiFlow Engine is a new system and does not need to inherit those old versions. The engine should begin on currently supported tools without making builds unpredictable or adopting preview releases that its libraries do not support.

“Latest” therefore needs a precise production meaning.

## Decision drivers

- Receive current security, correctness, and performance fixes.
- Avoid starting a new platform on versions already near end of support.
- Keep builds reproducible through exact package and image pins.
- Keep the complete framework, compiler, lint, test, and driver set compatible.
- Avoid unnecessary upgrade work during the first engine phases.

## Considered options

### Inherit legacy versions

This reduces short-term platform change but starts the engine with old software and carries forward unrelated legacy constraints.

### Use floating `latest` tags and package ranges

This appears current but makes identical source revisions produce different builds. An upstream release could break CI or production without a reviewed change.

### Pin the latest stable compatible versions

This starts current, remains reproducible, and makes every upgrade visible and testable.

## Decision

AiFlow Engine uses the latest stable, production-supported, mutually compatible versions available when a roadmap phase freezes its dependencies.

- Never use alpha, beta, release-candidate, nightly, or canary releases in the production baseline.
- Runtimes use the newest production LTS line, not a newer Current line.
- Packages, build images, and test service images are pinned to exact versions. Production images should additionally be pinned by digest in deployment configuration.
- Do not install a planned dependency before the phase that needs it. Resolve and pin its current stable compatible version when introduced.
- Patch/minor upgrades require the full quality and integration suite. Major upgrades require an explicit compatibility/migration review; use a new ADR when architecture or persisted contracts change.
- A platform limitation may require an older supported version, but the exception must name its owner, reason, support deadline, and upgrade plan.

Verified baseline on 2026-07-17:

| Tool              | Selected version | Reason                                                                              |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------- |
| PostgreSQL        | 18.4             | Current stable PostgreSQL release; PostgreSQL 19 is beta and excluded.              |
| RabbitMQ          | 4.3.2            | Latest fully supported RabbitMQ release series and patch.                           |
| Node.js           | 24.18.0 LTS      | Latest Node 24 LTS patch; Node 26 is Current and excluded from production.          |
| Bun               | 1.3.14           | Latest stable workspace/package tool.                                               |
| Redis             | 8.8              | Latest stable Redis Open Source release if the optional Redis integration is used.  |
| NestJS            | 11.1.28          | Latest stable NestJS packages and already pinned consistently across runtime roles. |
| Pino              | 10.3.1           | Latest stable structured logger, shared across the three runtime roles.             |
| TypeORM           | 1.1.0            | Latest stable ORM/migration release compatible with Node 24 and PostgreSQL.         |
| `pg`              | 8.22.0           | Latest stable PostgreSQL driver and a supported TypeORM peer.                       |
| Testcontainers    | 12.0.4           | Latest stable Node test container library for PostgreSQL contract tests.            |
| TypeScript        | 6.0.3            | Latest release supported by current `typescript-eslint` and `ts-jest` peer ranges.  |
| Jest              | 30.4.2           | Latest stable Jest release, supported by the current `ts-jest`.                     |
| ESLint            | 10.7.0           | Latest stable ESLint release.                                                       |
| typescript-eslint | 8.64.0           | Latest stable release; supports TypeScript below 6.1.                               |

TypeScript 7.0.2 is newer but is not selected because the current stable `typescript-eslint` and `ts-jest` versions do not support it. Re-evaluate it when the full toolchain supports it.

Planned Phase 1 libraries such as `amqplib`, AWS SDK v3, Ajv, and JOSE remain uninstalled. Their exact versions will be verified and pinned when their Phase 1 slice begins.

## Consequences

### Positive

- The new engine does not inherit PostgreSQL 12 or other legacy version constraints.
- Builds remain deterministic and upgrades remain reviewable.
- Compatibility is considered across the whole toolchain rather than by package version alone.

### Negative and trade-offs

- Exact pins require regular deliberate upgrades.
- The absolute newest release may wait until dependent tools support it.
- The platform team must confirm it can provide PostgreSQL 18.4 and RabbitMQ 4.3.2.

## Security and data impact

Current supported versions reduce exposure to known defects. Database or broker major-version changes still require tested backup, restore, migration, and rollback procedures before production adoption.

## Reliability and operations

Platform-managed services must expose their patching, support, HA, backup, and recovery policy. Application dependencies are upgraded through CI and integration tests, never dynamically at application startup.

## Migration and rollback

AiFlow Engine has no production state yet, so no PostgreSQL 12-to-18 data migration is required for new engine state. Legacy data migration tools must read from the legacy source and write through the new engine contract; they must not reuse the legacy database as the engine database.

Rollback uses the previously tested application image and only database/message changes that remain backward compatible under the expand/migrate/contract policy.

## Validation

- Run `bun outdated --recursive` during each dependency freeze.
- Run `bun run check` and `bun run build` for every dependency update.
- Run PostgreSQL, RabbitMQ, and S3 integration suites against exact target versions before Phase 1 exits.
- Verify production container images and platform service versions before deployment approval.
