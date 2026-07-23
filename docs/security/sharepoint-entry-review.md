# SharePoint Entry Security and Readiness Review

Review status: code and local-boundary review complete. Production release is
blocked until the open findings below are closed and approved by the security
and platform owners.

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

## Open production findings

### SP-SEC-01 — real identity and Graph adapter

Severity: release blocker.

The Microsoft Entra app-only identity mode, customer admin-consent journey,
least-privilege permission profile, token acquisition, Graph HTTP behavior, and
preauthenticated download-redirect validation have not been implemented or
proven in a production-equivalent sandbox. Production remains unavailable
until the exact tenant, audience, permissions, endpoints, redirect allow-list,
timeouts, and secret/workload-identity storage are approved and contract
tested.

### SP-SEC-02 — orphan object after interrupted commit

Severity: high.

Lease recovery abandons a timed-out reservation and retries with a new
reservation. A process crash after S3 accepts the provider stream but before
the database commits the exact object version can leave an unreferenced object.
The storage key is immutable and cannot start an execution, but automated
reconciliation/deletion of this unknown-version object is not yet implemented.
A bounded, auditable cleanup mechanism is required before production.

### SP-SEC-03 — deactivation and shared-watch cleanup

Severity: high.

Workflow deactivation closes the generic workflow activation but does not yet
fully drain the SharePoint binding, remove the last shared-drive reference,
confirm subscription deletion, or reconcile version handover. Intake and
cleanup invariants must be implemented and concurrency-tested before
production.

### SP-SEC-04 — callback ingress and download egress

Severity: high.

Application-level request validation exists, but production ingress body/time
limits, rate controls, optional Microsoft source filtering, TLS termination,
and abuse monitoring need platform confirmation. Outbound Graph/token endpoint
allow-listing and preauthenticated redirect protections against downgrade,
loopback, link-local, metadata, unexpected ports, DNS rebinding, and excess
redirects must be enforced and tested by the real adapter and network policy.

### SP-SEC-05 — fairness, throttling, and load evidence

Severity: high.

Sync and ingestion can scale independently and work is serialized per watch,
but explicit admission limits per provider tenant, engine tenant, connection,
and app are not yet implemented. Production-equivalent tests must prove
`Retry-After`, bounded queue growth, hot-tenant isolation, callback bursts,
large-file memory limits, scheduler recovery, and Kubernetes scaling behavior.

### SP-SEC-06 — reconciliation completeness

Severity: medium.

The normal delta path, replay, renewal, and scheduled backstop are implemented.
Cursor invalidation/rebaseline, selected-folder deletion, folder subtree
move/rename repair, subscription handover, and provider-side absence
reconciliation require complete behavior and tests before production.

### SP-SEC-07 — retention and deletion policy

Severity: medium.

The schema supports durable notification, inventory, ingestion, document, and
audit records, but exact product/privacy retention values and cleanup jobs are
not approved. No production launch should occur until those values, legal
holds, deletion ownership, and observable retry/reconciliation behavior are
documented and implemented.

### SP-SEC-08 — resource discovery and customer safety

Severity: medium.

The current UI accepts stable site, drive, and folder IDs manually. A
connection-scoped provider browser should return only allow-listed IDs and
labels accessible to that connection. Raw Graph payloads, tokens, tenant web
URLs, and secret references must never be exposed to the browser.

## Conclusion

The deterministic local proof is suitable for continued engine and DevPortal
development. It demonstrates the intended data plane and reliability model,
not permission to process production SharePoint data. Production stays
fail-closed until every release blocker is implemented, tested against a real
Microsoft sandbox, and approved by the required security/platform owners.
