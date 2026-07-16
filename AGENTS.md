# AiFlow Engine Agent Rules

This file governs automated coding agents working anywhere in this repository. Human contributors should also read [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Primary coding policy

Keep it simple. Use clean architecture to make the code readable, testable, independent, and easy to maintain or change.

- Implement only what the current requirement needs.
- Prefer clear, explicit code over clever or highly generic code.
- Keep business logic independent from frameworks, databases, brokers, storage, and providers.
- Give each module one clear responsibility and test it through its public behavior.
- Add an abstraction when it protects a real external boundary or serves real reuse. Do not add layers, factories, base classes, or services for imagined future needs.
- Choose the fewest moving parts that still meet the required reliability, security, and scale.

Simple does not mean skipping correctness, tests, security, or failure handling. Those are part of the requirement.

## Rule priority

When instructions conflict, follow this order:

1. Security and privacy requirements in [`SECURITY.md`](SECURITY.md).
2. Accepted contracts in `docs/contracts/` and accepted architecture decision records in `docs/decisions/`.
3. Architecture laws in [`docs/architecture/principles.md`](docs/architecture/principles.md).
4. This file and [`CONTRIBUTING.md`](CONTRIBUTING.md).
5. Package-local documentation.

Do not silently choose between conflicting rules. State the conflict and resolve it in the same change, or stop and request a decision.

## Before changing code

- Read the relevant roadmap phase, contracts, ADRs, and package boundaries.
- Confirm that the work belongs to the active phase. Do not partially implement a later phase.
- Inspect the current worktree and preserve unrelated or user-authored changes.
- Prefer the smallest clear change that satisfies the contract.
- Do not add a service, repository, framework, data store, or provider dependency without an accepted ADR.

## Non-negotiable product boundaries

- Keep one repository and one image with independently deployable `api`, `worker`, and `scheduler` roles until measured evidence and an ADR justify a split.
- Keep the workflow core independent of n8n, Microsoft, Google, OCR vendors, and other providers. Provider behavior belongs behind ports and connector adapters.
- Do not rebuild DevPortal. The disposable `tools/demo-ui` harness is allowed only in Phase 2; changes to the real DevPortal begin at the Phase 3 gate.
- Document bytes move between the source, object storage, workers, and providers. They must not pass through RabbitMQ or PostgreSQL and should not pass through the API process.
- PostgreSQL is the system of record for execution state. RabbitMQ transports commands/events; it is not the state store.
- Every tenant-owned record and operation must carry an authenticated tenant context. Never trust a client-supplied tenant identifier without authorization.
- Assume messages, callbacks, webhooks, and completion requests are delivered more than once. Side effects must be idempotent.

## Code rules

- Use Bun for workspace commands and lockfile changes. Production runs on Node.js 24 LTS.
- Keep TypeScript strict. Prefer `unknown` plus validation at boundaries; restrict `any` to isolated adapters with an explanation.
- Keep controllers and consumers thin: validate, authorize, call an application use case, and translate the result.
- Keep domain rules free of NestJS, database, broker, storage, HTTP, and provider imports.
- Treat `apps/*` as composition roots. Reusable behavior belongs in `packages/*`.
- Depend on public package exports, not another package's internal source paths.
- Validate all external input at the boundary and return stable, documented error codes.
- Never log document contents, access tokens, secrets, authorization headers, presigned URLs, or unredacted provider payloads.
- Do not hide failures with empty catches, unbounded retries, or automatic fallbacks that change business behavior.

## Persistent state and messaging

- Database changes require a reviewed migration, compatibility/rollout notes, and recovery instructions.
- Prefer additive, backward-compatible schema changes. Separate destructive cleanup into a later, explicitly approved release.
- State transitions must be explicit, guarded, transactional, and auditable.
- Publish durable work through the transactional outbox; deduplicate consumption with an inbox/idempotency key.
- Consumers acknowledge only after durable success. Retries must be bounded and exhausted messages must be inspectable in a DLQ.
- Queue payloads contain identifiers and metadata, never document bytes, secrets, or presigned URLs.

## Tests and verification

- Add tests at the lowest useful level: unit tests for rules, integration tests for infrastructure adapters, and contract tests for public/provider boundaries.
- Every bug fix includes a regression test unless the PR explains why one cannot be written.
- Reliability-sensitive changes cover duplicate delivery, retry exhaustion, crash/restart, and tenant isolation where applicable.
- Unit tests must not depend on live networks or shared infrastructure.
- Before handing off a change, run `bun run check` and `bun run build`. Report any command that could not run.

## Git and change discipline

- Use a focused branch and Conventional Commits as defined in [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Do not commit, push, rewrite history, delete user changes, or alter remotes unless the user explicitly requests it.
- Keep generated artifacts, secrets, local environment files, and build output out of Git.
- Update contracts, ADRs, and operational notes in the same change as the behavior they govern.
