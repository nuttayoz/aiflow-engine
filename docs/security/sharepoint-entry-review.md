# SharePoint Entry Security and Readiness Review

Review status: Phase 4 application findings are resolved in code and locally
tested. Production release remains blocked on the external Microsoft,
Kubernetes, product-policy, load, and approval evidence listed below.

This review is required because Phase 4 adds a public provider callback,
cryptographic callback/cursor handling, provider downloads, confidential
document staging, new retention records, and new network trust boundaries.

## Implemented controls

- The public callback accepts only the validation challenge or a bounded basic
  notification shape. Resource data is rejected. Valid notifications are
  authenticated with stored subscription correlation and versioned
  `clientState`, deduplicated, durably coalesced, and acknowledged without
  provider work in the request.
- Delta cursors are encrypted with AES-GCM and a versioned key. Callback state
  uses an HMAC-derived value with overlap for safe key rotation.
- Queue messages contain opaque IDs and state guards only. Document bytes,
  tokens, callback secrets, raw provider payloads, cursors, and download URLs
  are excluded from PostgreSQL, RabbitMQ, application logs, and API responses.
- The ingestion worker streams provider content directly into an immutable S3
  reservation with bounded memory, content length, checksum, and exact provider
  version checks before committing a document and execution.
- Tenant-scoped repositories and foreign keys keep connections, watches,
  bindings, ingestions, documents, and executions within one engine tenant.
- Notification, sync, ingestion, pipeline, and destination work use durable
  outbox/inbox records, leases, idempotency, retry state, and a scheduled delta
  backstop.
- Non-production provider fakes are composition-gated. Production cannot
  silently process SharePoint data through a fake adapter.
- Production configuration requires HTTPS callback URLs and approved
  cryptographic key material; infrastructure TLS, KMS, IAM, and network
  enforcement remain platform responsibilities.

## Finding disposition

### SP-SEC-01 — real identity and Graph adapter

Severity: release blocker.

Code status: resolved. The engine implements SaaS multi-tenant admin consent,
tenant-bound client-credentials tokens, bounded Graph HTTP behavior, connection
resource discovery, throttling, and strict preauthenticated redirect
validation. Production composition fails closed without real credentials.

External gate: prove the exact application registration and `Files.Read.All`
permission profile in a sandbox, approve the consent wording, and verify
platform secret injection/rotation.

### SP-SEC-02 — orphan object after interrupted commit

Severity: high.

Code status: resolved. Lease recovery retains the exact immutable reservation.
Before downloading again, the retry heads that key and adopts a complete,
size-matching object; a mismatched object is deleted by exact version before a
new stream. No object can start an execution until metadata, checksum, source
version, binding eligibility, document, execution, and outbox commit
atomically.

External gate: run the worker-kill test against the production S3/KMS policy.

### SP-SEC-03 — deactivation and shared-watch cleanup

Severity: high.

Code status: resolved. Deactivation closes intake first, durably runs managed
cleanup, drains accepted ingestions, preserves shared subscriptions, deletes
only the last reference, reconciles ambiguous/absent provider state, and
completes the workflow operation. Version replacement retires the old managed
binding before switching.

External gate: repeat shared-watch and handover disruption tests against the
Microsoft sandbox.

### SP-SEC-04 — callback ingress and download egress

Severity: high.

Code status: outbound controls resolved. Graph/token origins are fixed by the
adapter; redirects are manual, bounded, HTTPS-only, hostname-allow-listed,
resolved against public addresses, and receive no Graph authorization header.
The callback has strict content type, query, body, collection, shape,
correlation, replay, and fast-acknowledgement controls.

External gate: configure and record TLS termination, body/time/rate limits,
optional Microsoft source filtering, abuse alerts, and pod egress policy at the
production ingress/network layer.

### SP-SEC-05 — fairness, throttling, and load evidence

Severity: high.

Code status: resolved for application admission. Sync and streaming ingestion
have configurable per-engine-tenant and per-connection concurrency limits
enforced with database advisory locks across pods. Excess work is durably
rescheduled, Graph `Retry-After` is preserved, and metrics use low-cardinality
labels. Queue roles remain independently scalable.

External gate: choose deployment-wide/provider-app caps and prove callback
bursts, large-file memory bounds, hot-tenant isolation, Rabbit/KEDA behavior,
pod disruption, and alert thresholds in the production-equivalent cluster.

### SP-SEC-06 — reconciliation completeness

Severity: medium.

Code status: resolved. Invalid cursors trigger a new inventory generation and
metadata-only rebaseline without re-executing unchanged versions. Folder
moves use bounded, cycle-safe ancestry/subtree repair; missing selected folders
degrade the binding. Unknown or absent subscriptions are recreated while
retaining the committed cursor. Local integration tests cover these states.

External gate: exercise the same scenarios against a Microsoft sandbox.

### SP-SEC-07 — retention and deletion policy

Severity: medium.

Code status: partially resolved. Notification events expire after 30 days and
the scheduler purges them in bounded, leased batches. Unresolved watches,
cursors, bindings, ingestions, and engine documents are deliberately retained;
SharePoint deletion never shortens engine retention.

External gate: product/privacy owners must approve inventory, tombstone,
document, audit, orphan-watch, and legal-hold values before enabling their
deletion jobs.

### SP-SEC-08 — resource discovery and customer safety

Severity: medium.

Code status: resolved. DevPortal uses the engine's connection-scoped
site -> library -> folder browser and receives only bounded opaque IDs, labels,
resource kinds, and selection hints. Tokens, Graph URLs, raw payloads, tenant
web URLs, and secret references are not returned.

External gate: complete the signed-in customer acceptance walkthrough.

## Conclusion

The whole Phase 4 implementation is suitable for local acceptance. It is not
permission to process production SharePoint data. Production stays fail-closed
until the Microsoft sandbox, deployment-platform, load, product-policy, and
security approvals above are recorded.
