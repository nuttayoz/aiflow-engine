# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include exploit details, customer data, tokens, or secrets in a pull request.

Report privately to the repository owner through GitHub's private vulnerability reporting feature. If that feature is unavailable, contact the internal security channel or repository administrator and request a private handling path. Include the affected version/commit, impact, reproduction steps, and suggested mitigation when known.

The owner will acknowledge the report, assess severity, coordinate remediation, and disclose details only after affected environments are protected. Do not promise a remediation timeline before triage.

## Data classification and handling

AiFlow processes tenant-owned business documents and extracted business data. Treat document bytes, extracted values, mappings, provider payloads, connection metadata, and audit records as confidential tenant data.

- Store document bytes only in approved encrypted object storage.
- Do not put document bytes, secrets, access tokens, authorization headers, or presigned URLs in PostgreSQL, RabbitMQ, logs, traces, Sentry events, metrics labels, test fixtures, or source control.
- Use opaque object identifiers and checksums in database and queue records.
- Redact provider errors and payloads before recording them. Prefer allow-listed diagnostic fields.
- Use synthetic data in tests and demos. Never copy production/customer documents into local or non-production environments.
- Enforce retention and deletion through auditable, retryable jobs; deletion must cover derived objects and provider copies where the provider contract supports it.

## Authentication, authorization, and tenancy

- Validate token issuer, audience, signature, expiry, and required claims at the trusted boundary.
- Derive actor and tenant context from validated identity. A request body/header tenant value is never authorization by itself.
- Authorize every tenant-owned resource lookup and mutation, including retries, callbacks, downloads, and operator actions.
- Keep service identities distinct from human actors and grant least privilege.
- Use short-lived credentials and workload identity. Do not commit credentials or distribute long-lived shared secrets.
- Authenticate callbacks/webhooks, protect against replay, and process them idempotently.

## Integration and infrastructure requirements

- Use TLS for external and cross-trust-boundary traffic.
- Encrypt PostgreSQL, RabbitMQ, and S3 data at rest using approved platform controls.
- Restrict network and IAM access by runtime role. API, worker, and scheduler receive only the permissions they require.
- Pin dependencies through `bun.lock`, review dependency changes, and address known exploitable vulnerabilities proportionate to exposure.
- Bound payload sizes, timeouts, concurrency, and retries at every external boundary.
- Presigned URLs must be short-lived, operation-specific, content-constrained where supported, and never logged.

## Security review triggers

Request security review for changes to authentication, authorization, tenancy, cryptography, credential storage, upload/download behavior, provider callbacks, document retention/deletion, public endpoints, or network trust boundaries.

Security rules cannot be waived only by a code comment. A temporary exception requires documented risk acceptance, owner, expiry, compensating controls, and CODEOWNER approval.
