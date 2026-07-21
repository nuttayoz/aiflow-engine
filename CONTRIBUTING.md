# Contributing to AiFlow Engine

This guide defines how the team proposes, implements, reviews, and ships changes. The goal is predictable collaboration without slowing down small, safe changes.

## Engineering principle

Keep the design as simple as possible. Code should be:

- **Readable:** intent is obvious and names use product language.
- **Testable:** business behavior can be tested without starting frameworks or external infrastructure.
- **Independent:** business rules do not depend on NestJS, PostgreSQL, RabbitMQ, S3, or a provider SDK.
- **Maintainable:** a change stays inside the module that owns the behavior whenever possible.

Clean architecture means clear dependency boundaries, not more folders or layers. Implement today's requirement, keep external systems behind small interfaces, and introduce reusable abstractions only for a real boundary or demonstrated reuse. Reliability and security requirements are not optional complexity.

## Policy map

| File                                                                 | Purpose                                         | Read when                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)                                             | Operational rules for coding agents             | Using an automated coding assistant                                  |
| [`SECURITY.md`](SECURITY.md)                                         | Vulnerability reporting and data-handling rules | Touching auth, tenants, documents, secrets, or integrations          |
| [`docs/architecture/principles.md`](docs/architecture/principles.md) | Durable system boundaries                       | Changing modules, dependencies, storage, messaging, or runtime roles |
| [`docs/contracts/`](docs/contracts/)                                 | Versioned external behavior                     | Changing APIs, messages, auth, provider, or UI integration           |
| [`docs/decisions/`](docs/decisions/)                                 | Architecture decisions and their reasons        | Making a structural or costly-to-reverse choice                      |
| [`docs/roadmap.md`](docs/roadmap.md)                                 | Phase order and delivery gates                  | Selecting implementation scope                                       |

## Development workflow

1. Start from the latest `main` and create one branch for the roadmap phase outcome.
2. Confirm the active roadmap phase and relevant contract before coding.
3. Write down the intended commit slices before a large implementation.
4. Implement and commit one coherent capability at a time, including its focused
   tests and documentation where practical.
5. Run the local quality gate.
6. Open a focused pull request and complete the template.
7. Use squash merge after required checks and reviews pass.

Phase delivery branches use `phase<number>/<outcome>` in lowercase kebab-case,
for example `phase1/foundation` or `phase2/direct-upload`. Keep the whole phase
outcome on that branch; do not create a branch for every small task or commit.
For non-roadmap work, supported prefixes are `feat/`, `fix/`, `refactor/`,
`test/`, `docs/`, `chore/`, and `ci/`, for example
`fix/duplicate-webhook-delivery`.

Do not push directly to `main`. Repository administrators should enable branch protection, required checks, required CODEOWNER review, conversation resolution, and prevention of force pushes/deletion.

## Local setup and quality gate

Use the versions declared in `package.json`:

```bash
bun install --frozen-lockfile
bun run check
bun run build
```

Run `bun run format` to apply formatting. A contributor may run narrower tests while developing, but the full quality gate is required before review.

## Commit and pull request titles

Commit messages and squash-merge PR titles use Conventional Commits:

```text
<type>(optional-scope): <imperative summary>
```

Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, and `revert`.

Examples:

```text
feat(executions): persist idempotent stage transitions
fix(storage): reject mismatched object checksums
docs(contracts): define OCR callback authentication
```

Keep the header at 72 characters or fewer. Use a `BREAKING CHANGE:` footer only when the migration and compatibility plan is documented and approved. Validate a message file with:

```bash
bun run commitlint --edit .git/COMMIT_EDITMSG
```

### Commit structure

- Split a phase into dependency-ordered commits that each tell one clear story.
- Prefer a complete capability slice—implementation plus its focused tests—over
  commits organized only by file type.
- Separate cross-cutting documentation, build configuration, or operational work
  when it is substantial enough to review independently.
- Keep refactors separate from behavior changes unless the refactor is required
  to make that behavior possible.
- Do not use `wip!` commits in a pull request. Fold temporary fixups into the
  commit they correct before publishing.
- Run the most relevant available check before each commit. Every pull request
  must still pass the full quality gate.

There is no fixed commit count or line limit. A normal phase may contain several
small, meaningful commits; avoid both one giant phase commit and artificial
one-file commits.

## Coding and review conventions

- Follow strict TypeScript and the repository ESLint/Prettier configuration.
- Prefer small modules with explicit names over generic `utils` or shared dumping grounds.
- Keep provider terminology inside connector/adaptor packages; core types use canonical product language.
- Keep public APIs and messages versioned. Additive changes stay within a version; breaking changes require a new version and migration plan.
- Include stable error codes and correlation identifiers at boundaries.
- Explain comments in terms of constraints or intent; do not restate obvious code.
- Avoid speculative abstractions. Add one for a real external boundary or after demonstrated reuse.

Reviewers verify correctness, contract compatibility, tenant isolation, idempotency, failure recovery, observability, and operational safety—not only formatting.

## Testing expectations

| Change                          | Minimum evidence                                                      |
| ------------------------------- | --------------------------------------------------------------------- |
| Domain rule or state transition | Unit tests for success, rejection, and replay/duplicate behavior      |
| Repository, outbox, or inbox    | PostgreSQL integration test including transaction behavior            |
| Publisher or consumer           | RabbitMQ integration test including redelivery and DLQ behavior       |
| Storage adapter                 | S3-compatible contract test including checksum and streaming behavior |
| API or message contract         | Schema/contract tests and updated fixtures                            |
| Connector                       | Shared connector contract suite plus provider-specific tests          |
| Bug fix                         | A test that fails before the fix and passes after it                  |

Do not reduce coverage or weaken assertions merely to make a check pass. If a test is impractical, record the reason and alternate evidence in the PR.

## Database and rollout changes

Every persistent-state change includes:

- a forward migration with an explicit owner;
- compatibility behavior during mixed-version deployment;
- recovery or rollback instructions;
- backfill and performance impact when relevant;
- updated retention/deletion behavior when relevant.

Do not combine a schema contract break and destructive data deletion in one release.

## When an ADR is required

Write an ADR before implementing a change that introduces or replaces a framework, runtime role, service, datastore, broker pattern, public contract strategy, security boundary, tenancy model, or costly-to-reverse operational dependency. Use [`docs/decisions/0000-template.md`](docs/decisions/0000-template.md).

Small implementation details, reversible refactors, and choices already governed by an accepted ADR do not need a new ADR.

## Definition of done

A change is done when:

- acceptance criteria and the active phase scope are met;
- code, tests, contracts, migrations, and operator notes agree;
- security and tenant boundaries are reviewed;
- `bun run check` and `bun run build` pass;
- the PR has no unresolved review comments;
- rollout, monitoring, recovery, and compatibility impacts are documented where relevant.

Policy exceptions must be explicit in the PR, name an owner and expiry/remediation issue, and receive CODEOWNER approval. Architecture exceptions also require an ADR. Silent exceptions are not accepted.
