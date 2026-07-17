# Microsoft Dynamics Destination Contract v1

Status: Phase 0B proposal for Phase 2 implementation.

This contract defines how AiFlow Engine delivers one mapped document result to Microsoft Dynamics 365 Business Central or a separately supported Dynamics NAV installation without duplicating the external business effect. It fixes the provider-neutral delivery boundary while leaving the exact customer product, version, topology, and first approved action as required confirmations.

## Repository evidence and recommendation

The inspected legacy repositories contain no implemented Dynamics/NAV/Business Central connector, credential flow, endpoint, entity write, or reconciliation logic. They contain only future plans and generic DevPortal application/event fields. The engine skeleton reserves separate `microsoft-business-central` and `dynamics-nav` connector packages.

Evidence was inspected at:

- `devportal` `2fc93d8ba136`;
- `devportal-backend` `c546a2fdedf2`;
- `n8n-service` `05e6c32cfe1c`;
- `aiflow-trigger-handler` `7d5f9633af44`;
- `aiflow-webhook-processor` `85d2d46e78fd`;
- `aiflow-review-result` `e9b9e92d6e31`;
- `personal-template-backend` `829d37bed2dc`.

Therefore there is no legacy Dynamics behavior to preserve. The recommended first target is:

```text
Microsoft Dynamics 365 Business Central online
  -> REST API v2.0/custom API page
  -> create one purchase-invoice draft atomically
  -> do not post the invoice in the initial action
```

Microsoft recommends REST API web services for Business Central integrations and describes standard API v2.0 plus custom API routes in its [web-service comparison](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/web-services) and [endpoint structure](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/api-endpoint-structure).

Business Central on-premises and Dynamics NAV are not aliases for the online API. Each requires an independently tested adapter for its exact version, authentication, published API/OData/codeunit surface, network path, customization, and reconciliation behavior.

## Boundary and fixed decisions

- Core execution knows only a destination connector/action and the canonical `DELIVER` stage. Microsoft product names, endpoints, entity names, and authentication stay in connector adapters.
- PostgreSQL is authoritative for delivery intent, stable effect identity, attempt state, retry/reconciliation due time, and the confirmed receipt.
- RabbitMQ only wakes the appropriate connector worker. It never carries mapped business values, credentials, provider URLs, or document bytes.
- The worker reads the exact immutable mapped/review-approved S3 artifact and validates it against the frozen destination action schema before any provider call.
- Every externally visible write has one stable `effectKey` created before the first call and reused across broker redelivery, automatic retry, reconciliation, and the manual execution retry chain.
- An unknown write outcome is reconciled by `effectKey`; it is never blindly repeated.
- A successful receipt is committed once with the execution's `SUCCEEDED` transition and audit event.
- The initial action creates a draft purchase invoice only. Posting, payment, approval, deletion, attachment upload, and mutation of an existing ERP record are separate future actions with separate permissions and effect contracts.
- No automatic fallback occurs between Business Central, NAV, companies, actions, or connections.
- Provider responses and ERP business data remain untrusted confidential input and are validated/redacted at the adapter boundary.

The generic stage states, leases, retries, and manual retry chain are defined by [`execution-lifecycle.md`](execution-lifecycle.md). Mapped input and any future large delivery artifact follow [`storage-v1.md`](storage-v1.md).

## Product-family separation

| Connector ID                 | Candidate target                      | Initial protocol direction                      | Production requirement                                                         |
| ---------------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `microsoft-business-central` | Business Central online               | REST API/custom API using API route/version     | Microsoft Entra S2S, company GUID, least-privilege permission sets, effect API |
| `microsoft-business-central` | Current Business Central on-premises  | REST/custom API when supported                  | Exact version, base URL/network allowlist, OAuth/TLS, deployed extension       |
| `dynamics-nav`               | Confirmed legacy Dynamics NAV release | Version-specific ODataV4 or custom codeunit/API | Exact version/custom objects/auth/network plus equivalent effect-key lookup    |

For Business Central, API endpoints are company-scoped and standard routes use an environment and company identifier. Microsoft documents both forms, including `companies(<companyGuid>)`, in its [API endpoint guidance](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/api-endpoint-structure).

SOAP is not selected for new Business Central work. Microsoft states that SOAP support is being replaced by OData V4 and will be removed in a later release. A legacy NAV SOAP requirement needs an explicit exception, exact-version contract, migration owner, and security review.

The connector ID is immutable for a workflow version. Changing product family or protocol creates a new connection/action version; it never silently redirects an accepted execution.

## Connection contract

A `Connection` contains safe tenant-owned configuration plus an approved external secret reference. Conceptual connector-owned fields are:

| Field                             | Meaning                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `productFamily`, `productVersion` | Confirmed Business Central/NAV target and exact supported release         |
| `hostingModel`                    | `ONLINE` or `ON_PREMISES`                                                 |
| `externalTenantId`                | Microsoft Entra/customer tenant identifier when applicable                |
| `environmentName`                 | Approved Business Central environment                                     |
| `endpointAlias`                   | Server-configured endpoint/network alias; never an arbitrary workflow URL |
| `credentialRef`                   | Reference to approved secret/certificate/identity configuration           |
| `authorizationState`              | Consent/credential state and safe failure projection                      |
| `capabilityVersion`               | Last verified connector/action capability version                         |
| `lastValidatedAt`, `nextCheckAt`  | Health/permission validation timing                                       |

Companies are browsed through `GET /api/v1/connections/:connectionId/resources` and returned as opaque provider-resource IDs plus safe display labels. Business Central online uses its company GUID as the adapter resource reference. A workflow stores the selected company reference in destination config; it never stores only a mutable company name.

Connection creation/authorization and workflow activation validate outside a database transaction that:

1. the endpoint/tenant/environment is approved;
2. credentials can acquire the expected token or authenticate by the approved legacy mechanism;
3. the selected company exists and is accessible;
4. the exact action/custom API version is installed;
5. required read/write/reconciliation permissions are present;
6. the effect-key contract passes a non-mutating capability check or dedicated sandbox test.

An active workflow freezes the connection ID, company resource ID, action ID/version, and validated configuration. Credential rotation updates the connection without rewriting workflow versions. A disabled/revoked connection prevents new calls and leaves existing unknown outcomes reconcilable after authorization is restored.

## Authentication and network

### Business Central online

The baseline is Microsoft Entra service-to-service authentication using OAuth 2.0 client credentials. Microsoft documents that S2S is intended for unattended integrations, uses client credentials, requires the Business Central API application permissions, and requires the application to be enabled with assigned Business Central permission sets in its [S2S authentication guidance](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication).

Rules:

- Use a customer-authorized single/multi-tenant Entra application according to the approved SaaS onboarding model.
- Grant only the Microsoft application scope required for API access and narrowly scoped Business Central permission sets for the selected company/entities/action.
- Never assign `SUPER`; Microsoft explicitly disallows it for applications and recommends least privilege.
- Prefer an approved certificate/federated credential where supported; otherwise keep the client secret in the existing secret manager with rotation and expiry monitoring.
- Cache access tokens only in bounded memory or the approved secret/token facility until shortly before expiry. Tokens never enter PostgreSQL, Redis Pub/Sub, RabbitMQ, logs, Sentry, or workflow definitions.
- Customer consent, enabling the Entra application in Business Central, and permission-set assignment are visible provisioning steps with actionable status—not hidden connector magic.

### On-premises Business Central and Dynamics NAV

The exact endpoint, certificate authority, TLS version, authentication mode, ingress/egress route, proxy/VPN/private connectivity, and published service are required inputs. Arbitrary user-supplied URLs are forbidden; `endpointAlias` resolves through platform-managed allow-listed configuration and blocks loopback, link-local, metadata, and unintended private destinations.

Basic authentication, web-service access keys, Windows-integrated identities, or shared user passwords are not assumed. If a confirmed legacy release offers no approved OAuth/workload identity option, production use requires Security risk acceptance, short-lived/rotated secret storage, TLS, least-privilege service account, network restriction, owner, and migration/expiry plan. Business Central online does not support access-key Basic Auth; Microsoft recommends OAuth2 in its [web-service authentication documentation](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/web-services-authentication).

## Destination action descriptor

Every connector action version publishes:

- stable `connectorId`, `actionId`, and immutable `actionVersion`;
- safe display metadata;
- connection/product/version requirements;
- workflow configuration JSON Schema;
- mapped input JSON Schema and stable target paths;
- supported company/resource discovery types;
- effect-key/idempotency and reconciliation capabilities;
- timeout, retry, quota, and receipt schema;
- permission/capability requirements;
- whether the action is reversible, financial, or requires explicit review.

The initial proposed descriptor is:

```text
connectorId: microsoft-business-central
actionId: create-purchase-invoice-draft
actionVersion: 1
config: { companyId }
effect: CREATE
posting: false
attachment: false
```

The action input is connector-owned, not a new core entity. A proposed shape for discovery—not yet frozen—is:

```json
{
  "vendorNumber": "V-10000",
  "vendorInvoiceNumber": "INV-2026-001",
  "invoiceDate": "2026-07-17",
  "dueDate": "2026-08-16",
  "currencyCode": "THB",
  "dimensions": [{ "code": "DEPARTMENT", "valueCode": "FINANCE" }],
  "lines": [
    {
      "lineType": "ITEM",
      "itemNumber": "ITEM-001",
      "description": "Office supplies",
      "quantity": "2",
      "unitCost": "1250.50"
    }
  ]
}
```

The selected customer's fields, lengths, mandatory values, tax/business rules, dimensions, line types, and custom extensions must be confirmed before creating the machine-readable action schema.

Rules:

- Business identifiers such as vendor/item/account number are data, never the delivery effect identity.
- Dates use explicit ISO calendar dates; timezone conversion is not guessed.
- Quantities, money, rates, and percentages use bounded canonical decimal strings. Adapter conversion never performs business arithmetic with JavaScript binary floating point.
- Enum and identifier values are validated against the action schema and, where required, provider resources.
- Unknown fields, overlong strings/arrays, unsafe control characters, non-finite values, and precision overflow fail before the provider call.
- The engine injects `effectKey` and payload hash; mappings and callers cannot set or override them.
- The initial action does not upload the original document or OCR output to Dynamics. A future attachment action must stream the exact approved object and define its own size, retention, malware, and idempotency behavior.

Microsoft's standard API v2.0 exposes purchase invoices and lines, including create/update/delete and a separate `post` bound action. The [purchase-invoice resource](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/resources/dynamics_purchaseinvoice) is evidence for the candidate entity, not authorization to post financial documents in v1.

## Effective-once effect contract

### Stable identity

When mapping/review produces the final delivery input, the engine creates one random opaque `effectKey` and `delivery_operations` row before publishing delivery work. The operation is unique for:

```text
(tenantId, rootExecutionId, connectorId, actionId, actionVersion)
```

The same operation/effect key is reused by every automatic attempt and manual retry execution in that root chain. The row stores the exact input storage object/schema and SHA-256 of canonical action JSON. Reusing an effect key with a different payload hash is a permanent integrity conflict and never calls Dynamics.

If corrected business data is required after a failed/unknown delivery, the user needs an explicit future correction/reprocess operation that creates a new effect identity. A normal retry cannot silently mutate financial input.

### Why a custom effect endpoint is preferred

Business Central's standard purchase-invoice API documents ordinary `POST` creation, and line creation may be a separate request. ETags/`If-Match` protect update/delete concurrency; they do not make an uncertain create response idempotent. The built-in API cannot simply be extended with an engine field; Microsoft directs additional fields to a custom API in its [API v2.0 overview](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/).

The preferred production integration is a small customer-installed Business Central extension/custom API that:

1. accepts `effectKey`, `payloadSha256`, action version, and the complete validated draft payload;
2. enforces a unique effect key inside Business Central;
3. atomically creates the header/lines and effect receipt in one Business Central transaction;
4. returns the same resource receipt for replay of the same key/hash;
5. returns a deterministic conflict for the same key with a different hash;
6. exposes read-only lookup by effect key for reconciliation;
7. never posts the invoice unless a separately authorized action explicitly requests it.

The endpoint route/publisher/group/version are customer/extension configuration. They are not hard-coded into core packages.

A standard-API-only adapter is production-eligible only if the customer demonstrates an action-specific unique natural key, atomicity/partial-write behavior, and authoritative lookup that meet the same contract. `vendorInvoiceNumber`, invoice number, filename, or a combination of mapped business values is never assumed unique without ERP-enforced evidence.

Dynamics NAV requires an equivalent idempotent codeunit/OData action or a proven unique-key lookup. If neither exists, create actions are not safely supported; the connector can expose only read/validation capabilities until the customer adds the effect contract.

## Durable delivery operation

`packages/executions` owns one provider-neutral `delivery_operations` record for the root retry chain and destination action.

Conceptual fields:

| Field                                         | Meaning                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `deliveryOperationId`                         | Engine UUID and internal operation identity                         |
| `tenantId`, `projectId`, `rootExecutionId`    | Ownership and retry-chain boundary                                  |
| `connectorId`, `actionId`, `actionVersion`    | Frozen destination capability                                       |
| `connectionId`, `companyResourceId`           | Frozen authorized target references                                 |
| `effectKey`, `payloadSha256`                  | Stable provider idempotency/reconciliation identity and exact input |
| `inputStorageObjectId`, `inputSchemaVersion`  | Immutable mapped/review-approved action input                       |
| `status`, `stateVersion`                      | Guarded durable operation lifecycle                                 |
| `currentExecutionId`, `currentStageAttemptId` | Current retry owner                                                 |
| `nextCheckAt`, `reconciliationDeadlineAt`     | Durable recovery schedule                                           |
| `externalResourceType`, `externalResourceId`  | Bounded non-secret receipt identifiers                              |
| `externalResourceNumber`, `externalVersion`   | Safe display/reference and ETag/version when applicable             |
| `appliedAt`, `lastReconciledAt`               | Confirmed effect timing                                             |
| `failureCode`, `lastSafeProviderStatus`       | Allow-listed failure/observation projection                         |

Status is limited to:

| Status       | Meaning                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `READY`      | Input/effect identity is durable and no external call is in flight        |
| `SUBMITTING` | A call may be in flight/applied; lease loss requires reconciliation       |
| `UNKNOWN`    | An outcome could not be confirmed; only reconciliation is allowed         |
| `APPLIED`    | The exact effect and receipt were authoritatively confirmed               |
| `FAILED`     | The operation ended permanently without permission for an automatic write |

Retry scheduling remains on the execution stage. The delivery-operation status answers only whether the external effect is safe to call, unknown, applied, or terminal.

## Delivery flow

1. Mapping/review completion validates the final action input, commits its immutable storage object, creates/reuses `delivery_operations` in `READY`, and publishes the connector-specific delivery command through the outbox.
2. The connector worker loads tenant-scoped execution, operation, frozen workflow/action, connection, company, and exact input artifact.
3. It verifies schema, checksum, payload hash, effect key, connection/capability state, tenant fairness, and provider admission.
4. In one short transaction it claims the `DELIVER` lease, creates the stage attempt, binds it to the operation, and changes `READY` to `SUBMITTING`.
5. Outside the transaction, it acquires credentials and calls the exact configured action with `effectKey`/payload hash.
6. A confirmed same-key/same-hash receipt commits `APPLIED`, closes attempt/stage as `SUCCEEDED`, moves execution to `SUCCEEDED`, and writes safe receipt/audit facts in one transaction.
7. A confirmed no-effect retryable response changes the operation back to `READY`, finishes the attempt, and persists `RETRY_SCHEDULED`/`nextAttemptAt`.
8. A timeout, reset, ambiguous provider error, or worker lease loss while `SUBMITTING` changes or recovers the operation to `UNKNOWN`; no new write occurs until reconciliation.

The operation is created before the outbox command, so a committed intent survives process/broker failure. Provider calls never occur inside a database transaction. A stale/lost-lease worker cannot commit a receipt.

## Reconciliation

The scheduler scans due `SUBMITTING`/`UNKNOWN` operations and publishes the existing `aiflow.execution.stage.reconcile.requested.v1` command. A reconciliation worker uses the custom effect lookup or the separately proven natural-key lookup.

| Observation                                    | Durable action                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Same effect key and payload hash applied       | Commit receipt and execution success idempotently                               |
| Same effect key exists with different hash     | `FAILED` integrity conflict; alert; never modify or create another resource     |
| Authoritatively not applied                    | Return `READY` and schedule one policy-controlled write attempt                 |
| Partially applied                              | `UNKNOWN`; run only the action-specific repair/reconciliation path              |
| Resource applied but later changed by ERP user | Preserve original receipt plus external version; do not overwrite automatically |
| Unauthorized/connection disabled               | Keep reconcilable; alert and wait for explicit credential recovery              |
| Provider unavailable before deadline           | Persist next check with bounded backoff                                         |
| Still unresolved at final deadline             | `FAILED`/`UNKNOWN_OUTCOME` with operator `RECONCILE`; never blind replay        |

A resource ID returned before a crash is useful only after the provider confirms it belongs to the same effect key/hash and company/action. Caller-supplied resource IDs or invoice numbers never decide success.

## Failure and retry classification

| Condition                                                   | Category and behavior                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Local admission limit or confirmed provider `429` no-effect | `TRANSIENT`; honor `Retry-After`, jitter, and tenant fairness                |
| Confirmed pre-write connection failure                      | `TRANSIENT`; bounded retry after persisted due time                          |
| Timeout/reset/ambiguous `5xx` after request could reach ERP | `UNKNOWN_OUTCOME`; reconcile effect key before any write                     |
| `400`/validation/business rule or missing master data       | `PERMANENT`; safe field/error code, no same-payload retry                    |
| `401`/`403` or missing permission set                       | Connection/auth failure; alert and require reauthorization/config correction |
| Effect-key same-hash conflict                               | Reconcile as already applied; verify and commit receipt                      |
| Effect-key different-hash conflict                          | `PERMANENT` integrity error and security/operations alert                    |
| ETag/`412` conflict on an allowed future update             | Reconcile current record; never blind overwrite                              |
| Multi-step partial effect                                   | `UNKNOWN_OUTCOME`; action-specific repair, no generic retry                  |
| Provider unavailable until deadline                         | Terminal unknown outcome with operator reconciliation                        |

Automatic transport retries are allowed only for read-only reconciliation or a write whose provider endpoint has proven same-key/same-hash idempotency. The HTTP library never independently retries an unsafe `POST`.

## Timeouts, quotas, and scaling

Proposed starting controls until the selected customer/provider confirms them:

| Control                         | Proposed value                                       |
| ------------------------------- | ---------------------------------------------------- |
| Connect timeout                 | 5 seconds                                            |
| Ordinary read/write response    | 60 seconds                                           |
| Idle-body timeout               | 30 seconds                                           |
| Reconciliation request timeout  | 30 seconds                                           |
| Initial reconciliation deadline | 15 minutes, configurable by action                   |
| Automatic delivery attempts     | 3 only when effect semantics prove retry safe        |
| Per-company write concurrency   | 2 initially; measured/confirmed before increase      |
| Per-tenant fairness             | Bounded independently from global connector capacity |

Business Central online returns `429` when API limits are exceeded and requires a cool-off/retry strategy; Microsoft also documents a 10-minute server request execution limit in its [API limit guidance](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-rate-limits). AiFlow uses much shorter client deadlines for the initial action and keeps long work in durable reconciliation.

The connector enforces shared credential/account, environment, company, action, and tenant limits across worker replicas. Kubernetes queue autoscaling does not bypass ERP capacity. Redis may coordinate a disposable distributed limiter, but PostgreSQL remains authoritative for operation state and due times.

The `microsoft-business-central` and `dynamics-nav` queues/deployments scale independently using existing connector queue patterns. One slow/legacy customer endpoint cannot consume all destination capacity; per-connection circuit state, bulkhead concurrency, and fair admission are bounded.

## Receipt, retention, and disclosure

A successful receipt is bounded PostgreSQL metadata, not a raw provider response:

```json
{
  "connectorId": "microsoft-business-central",
  "actionId": "create-purchase-invoice-draft",
  "actionVersion": 1,
  "companyResourceId": "company-guid",
  "externalResourceType": "purchaseInvoiceDraft",
  "externalResourceId": "resource-guid",
  "externalResourceNumber": "PI-1042",
  "externalVersion": "etag-or-version",
  "appliedAt": "2026-07-17T10:00:00Z"
}
```

The receipt excludes tokens, endpoint URLs, request/response bodies, mapped values, vendor/customer names, addresses, line items, document bytes, and arbitrary provider error text. `effectKey` and payload hash remain restricted operational metadata and are not returned to ordinary DevPortal clients.

Delivery operation/receipt metadata follows the execution's one-year proposal and may be retained longer only for an approved financial/audit requirement. Deleting AiFlow source/mapped objects does not delete or reverse the ERP draft. ERP correction/deletion follows an explicit business action and audit policy.

Large provider-returned content is not expected for the initial action. A later action that returns a report/document uses a `DELIVERY_ARTIFACT` storage object rather than a PostgreSQL field.

## Security and observability

- Derive tenant/project/connection/company/action only from trusted stored records; messages and mapped values cannot redirect the destination.
- Validate TLS certificates and configured hosts. Redirects are disabled unless an exact adapter allowlist and credential-forwarding rule is approved.
- Tokens/certificates/secrets are acquired just in time, least privileged, rotated, and never logged or persisted in engine business tables.
- Never log mapped payloads, provider bodies, financial values, document/vendor numbers, full URLs/query strings, authorization headers, or external personal/business data.
- Map provider errors to stable codes and retain only allow-listed request IDs/correlation metadata needed for support.
- Require security review for customer consent, credential storage, on-prem network access, custom extension permissions, and any legacy authentication exception.

Safe metrics include request/receipt/reconciliation counts, duration, status/failure category, throttling/admission delay, unknown outcomes, circuit state, and queue age by connector/action/hosting model. Tenant/company/connection/execution/effect/resource IDs are high-cardinality trace/log values, not metric labels.

Alerts cover authorization expiry, missing permission sets/action extension, sustained `429`/`5xx`, reconciliation beyond deadline, effect-key/hash conflicts, partial writes, circuit-open connections, and delivery queue age. Third-party/customer ERP outage is reported separately from engine availability.

## Local development and contract tests

Phase 0B adds no Microsoft SDK, AL extension, or runtime dependency.

Phase 2 provides a small fake destination adapter/server that implements:

- same-key/same-hash replay returning one receipt;
- same-key/different-hash conflict;
- confirmed no-effect retryable responses;
- timeout after applying the effect;
- timeout before applying the effect;
- partial-effect/unknown outcome;
- throttling and `Retry-After`;
- authentication/permission failure;
- provider mutation after original receipt;
- connection/company/action isolation.

The same connector contract suite runs against an approved Business Central sandbox and installed effect extension before production. A fake cannot prove Entra consent, Business Central permission sets, actual company/entity rules, API customization, rate limits, ETags, or effect atomicity.

No production/customer ERP data or credentials are copied into local fixtures. The demo uses synthetic vendors/items/invoices in a disposable sandbox company.

## Required implementation evidence

1. One mapping/review result creates one durable delivery operation/effect key before publication.
2. RabbitMQ redelivery, automatic retry, manual execution retry, and worker termination reuse the same effect key and payload hash.
3. Termination before/during/after the provider response creates at most one ERP draft and eventually one engine receipt.
4. Timeout/`5xx` after a possible write performs lookup/reconciliation before another call.
5. Same-key/different-payload and cross-tenant/company/action attempts are rejected without an ERP mutation.
6. Header/lines are atomic, or partial state is detected and cannot enter a generic retry loop.
7. Posting, attachment, update, delete, payment, and approval cannot be invoked through the draft action.
8. Connection disable/credential expiry blocks new writes but preserves unknown-operation reconciliation.
9. Provider `429`, outage, and one slow connection do not starve other tenants/connectors.
10. PostgreSQL, RabbitMQ, logs, traces, metrics, Sentry, and DLQs contain no mapped financial payload, credentials, tokens, or raw provider responses.
11. The stored receipt is tenant-scoped, bounded, auditable, and sufficient to locate the exact ERP effect.
12. Business Central sandbox/custom extension or confirmed NAV endpoint proves effect uniqueness, payload-hash conflict, lookup, permission, and company isolation.

## Product and platform confirmations still required

- `DYN-01`: exact product family, version/release, online/on-premises topology, customer tenant/environment, region, support owner, and sandbox.
- `DYN-02`: first action and semantics—recommended `create-purchase-invoice-draft`; confirm posting/attachment are excluded.
- `DYN-03`: company, header/line entity/custom fields, dimensions, mandatory values, precision/lengths, master-data resolution, and validation rules.
- `DYN-04`: REST API/custom API/OData/codeunit route, publisher/group/version, effect-key extension ownership/deployment/upgrade, and reconciliation lookup.
- `DYN-05`: Entra application/consent model, application permissions, Business Central permission sets, credential type/rotation, and connection onboarding UX.
- `DYN-06`: endpoint/DNS/TLS/private connectivity/allowlist/proxy for on-premises or NAV, plus any legacy-authentication risk acceptance and migration expiry.
- `DYN-07`: actual limits, `Retry-After`, expected latency, maintenance windows, API/extension telemetry, escalation, and availability expectations.
- `PRODUCT-03`: action input schema/mapping paths, review requirements, receipt visibility, correction/reprocess behavior, and financial/audit retention.

These decisions select and configure a connector. They do not change the provider-neutral execution lifecycle, stable effect identity, unknown-outcome reconciliation, or one-receipt completion boundary.
