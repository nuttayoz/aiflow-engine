# Authentication, tenancy, and project authorization contract

Status: Phase 0B contract draft, 2026-07-14.

This contract defines how AiFlow Engine authenticates callers, derives actor and tenant context, authorizes project access, and propagates identity safely into asynchronous work. Exact platform claim names and service endpoints remain configuration inputs listed at the end.

## Current-system evidence

Evidence was read from:

- `devportal` at `2fc93d8ba136846f45df3a5d0f2bfa7e6b1cc38f`
- `devportal-backend` at `c546a2fdedf2fe26719c1effd5ccfe71c068dfe6`

Confirmed current behavior:

- DevPortal already stores an access token and uses `Authorization: Bearer <token>` for project, user, service, and other protected APIs.
- The current backend is configured as a bearer-only Keycloak client and protects most product routes with the realm role `app-user`.
- Several protected handlers decode `sub` and use it as `client_id` after the route guard has validated the token.
- The workflow frontend does not use the normal bearer header. It reads `user.sub` from browser storage and sends it as `x-client-id`.
- The workflow router imports Keycloak but does not protect its routes.
- Current project lookup sends the decoded subject to Key Manager as `clientId`; repository evidence does not define organization/tenant membership or a permission-checking contract.

These are migration facts, not the target security design. In particular, `sub` identifies an actor and must not automatically become the SaaS tenant identifier.

## Fixed decisions

1. Every DevPortal-to-engine request uses the existing platform access token through the API gateway.
2. AiFlow Engine independently validates the token; gateway validation alone is not the engine trust boundary.
3. `sub` is the actor identifier. Tenant identity is a separate value.
4. `x-client-id`, tenant headers, tenant body fields, and browser-selected ownership are rejected as authorization inputs.
5. Every tenant-owned database query requires explicit tenant context.
6. Project access is checked through an authorization port backed by the authoritative platform project/auth service.
7. Raw bearer tokens are never stored in PostgreSQL, S3 metadata, RabbitMQ, logs, traces, or audit payloads.
8. Workers consume a trusted identity snapshot created by the API transaction; they do not receive or revalidate the end-user token.
9. Provider callbacks use provider-specific authentication and server-side correlation, not browser/user headers.
10. The temporary demo harness uses the same authentication path as DevPortal. There is no magic identity header or production `DISABLE_AUTH` switch.

## Identity model

The engine-normalized request context is provider-neutral:

```ts
type ActorType = 'USER' | 'SERVICE' | 'SYSTEM';

interface ActorIdentity {
  type: ActorType;
  id: string;
}

interface AuthorizationContext {
  tenantId: string;
  actor: ActorIdentity;
  permissions: string[];
  projectId?: string;
  tokenId?: string;
  correlationId: string;
}
```

- `actor.id` is normally the validated `sub` for user/service tokens.
- `tenantId` comes from a validated tenant claim or an authoritative tenant-membership resolution.
- `projectId` comes from the canonical request path and is authorized against the tenant/actor. It never establishes ownership by itself.
- `permissions` are canonical engine permissions mapped from platform roles/scopes and project authorization.
- `SYSTEM` is used only for scheduler/reconciliation work created by the engine, with an auditable reason and tenant scope.

External identity-provider claim names are mapped at the API boundary. Domain and repository code never imports Keycloak-specific realm/resource claim structures.

## Access-token validation

The production token validator must:

- Accept only an `Authorization: Bearer` access token.
- Validate signature using trusted OIDC discovery/JWKS configuration.
- Allow only explicitly configured asymmetric algorithms.
- Validate exact issuer and intended AiFlow Engine audience.
- Validate expiry and not-before time with a small configured clock-skew allowance.
- Require a non-empty subject and the claims needed by the configured tenant/permission mapper.
- Refresh cached signing keys safely when the provider rotates keys.
- Fail closed when validation, discovery, or required-claim resolution cannot be completed.
- Distinguish access tokens from refresh/ID tokens according to the provider contract.
- Never log the token, signature, authorization header, or decoded sensitive claims.

DevPortal owns access-token refresh. AiFlow Engine returns `401` for an expired/invalid token and does not accept a refresh token.

Initial configuration vocabulary:

```text
AUTH_ISSUER
AUTH_AUDIENCE
AUTH_JWKS_URI                    # optional when discovery supplies it
AUTH_ALLOWED_ALGORITHMS
AUTH_TENANT_CLAIM
AUTH_ROLES_CLAIM
AUTH_SCOPES_CLAIM
PROJECT_AUTHORIZATION_ENDPOINT
```

Secrets and service credentials come from the existing Kubernetes secret mechanism, not committed environment files.

## Tenant resolution

Preferred production contract:

```json
{
  "sub": "actor-id",
  "tenant_id": "tenant-id"
}
```

The exact tenant claim name is configurable, but the semantic value must be the active organization/customer boundary.

If the current access token does not contain tenant identity, Phase 1 requires one of these approved alternatives:

1. The authentication service adds an active-tenant claim to the access token.
2. A trusted tenant-membership endpoint resolves `(issuer, subject)` plus selected organization into one tenant.
3. A project-authorization lookup returns the authoritative tenant for project-scoped requests.

Option 3 alone is insufficient for tenant-scoped endpoints such as listing reusable connections. Therefore a token claim or membership resolver is required before the full canonical API can ship.

For migrated single-user accounts, a compatibility mapper may associate a legacy subject with a canonical tenant record. This mapping is migration data only; database ownership and uniqueness must not assume `tenant_id == sub`.

## Project authorization port

The engine application layer depends on this port rather than calling `devportal-backend`:

```ts
interface ProjectAuthorizationPort {
  authorize(input: {
    tenantId: string;
    actor: ActorIdentity;
    projectId: string;
    permissions: string[];
  }): Promise<{
    allowed: boolean;
    tenantId: string;
    projectId: string;
    grantedPermissions: string[];
    policyVersion?: string;
  }>;
}
```

The first adapter calls the existing authoritative project/auth service using an approved server-to-server identity or token-exchange convention. It must not reproduce the current unauthenticated `clientId` query pattern.

Rules:

- Requested project and returned tenant/project must match exactly.
- Missing, mismatched, or ambiguous ownership fails closed.
- A valid token without the required project permission returns `403`.
- Looking up a workflow/connection/execution outside the authorized tenant returns `404` to avoid resource enumeration.
- A short-lived authorization cache is allowed only after its maximum staleness and revocation behavior are agreed.
- The raw user token is not cached and never enters an asynchronous message.
- Project-service outage never becomes an implicit allow. A still-valid approved cache entry may be used only under the agreed availability policy.

## Canonical permissions

External platform roles/scopes map into these initial engine permissions:

| Permission                    | Allows                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| `aiflow.catalog.read`         | Read connector and extraction-profile catalogs                         |
| `aiflow.workflow.read`        | List/get workflows and versions                                        |
| `aiflow.workflow.write`       | Create workflow metadata and draft versions                            |
| `aiflow.workflow.activate`    | Activate/deactivate a validated workflow version                       |
| `aiflow.workflow.delete`      | Archive/delete a workflow according to policy                          |
| `aiflow.connection.read`      | Read safe connection metadata/status                                   |
| `aiflow.connection.write`     | Create/update/delete connections                                       |
| `aiflow.connection.authorize` | Start provider authorization/consent sessions                          |
| `aiflow.execution.read`       | Read documents/executions and failure details                          |
| `aiflow.execution.retry`      | Request a guarded execution retry                                      |
| `aiflow.review.read`          | Read assigned/authorized review tasks                                  |
| `aiflow.review.decide`        | Approve/reject an authorized review task                               |
| `aiflow.operator.inspect`     | Inspect operational state and DLQs without document content by default |
| `aiflow.operator.replay`      | Perform audited operator replay/reconciliation actions                 |

The current `app-user` role may map to an agreed user permission set, but engine code checks canonical permissions, not the literal Keycloak role. Operator permissions are never implied by normal DevPortal access.

## Resource-authorization rules

### Workflows and versions

- Every workflow stores non-null `tenant_id` and `project_id`.
- Workflow IDs are resolved inside tenant/project scope.
- A version inherits immutable tenant/project ownership from its workflow.
- Activation reauthorizes the project and every referenced connection.

### Connections

- Connections are tenant-owned and may be reusable across authorized projects.
- Workflow definitions may reference only a connection owned by the same tenant and supported by the selected connector.
- Safe list/get responses never contain provider tokens, client secrets, encrypted blobs, or secret-manager paths.
- Deletion checks workflow references and permission before changing provider or local state.

### Upload sessions, documents, and executions

- Upload-session creation authorizes the workflow/project before issuing a presigned plan.
- S3 bucket/key are generated server-side and bound to tenant, project, workflow, and upload-session records.
- Completion verifies the exact authorized object key, checksum, size, and session state.
- Execution queries and retries require both tenant scope and workflow/project authorization.

### Review tasks

- Review list, metadata, content, source-preview access, and decisions require bearer authentication plus exact task/project permission.
- Source-preview capabilities are issued only after task authorization and are exact-version, short-lived, read-only, and never decision authority.
- Public review links, if retained through the existing Review System, use a separate expiring one-time presentation capability validated by the review adapter.
- Neither a URL query value nor `x-aiflow-review-approved` selects tenant or authorizes an engine transition.
- Exact decision, provider-presentation, callback, and DevPortal behavior follows [`review-v1.md`](review-v1.md).

## Asynchronous identity propagation

After the API authorizes a command, its database transaction records a minimal trusted snapshot:

```json
{
  "tenantId": "tenant-id",
  "projectId": "project-id",
  "actor": {
    "type": "USER",
    "id": "actor-id"
  },
  "correlationId": "correlation-id",
  "causationId": "command-id"
}
```

Outbox messages carry these identifiers plus resource IDs; they do not carry roles, secrets, provider tokens, presigned URLs, or end-user JWTs. Workers trust messages only from the engine-owned broker topology and still query/update records through tenant-scoped repositories.

Scheduler work uses `actor.type: SYSTEM` and records the job/run identifier. Provider callback work records the authenticated provider/connection identity as a service actor.

## External callbacks and service identities

Callback authentication is defined by each integration contract:

- OCR callbacks authenticate with the provider's signed JWT/HMAC/mTLS mechanism and correlate to a stored provider request as defined by [`ocr-v1.md`](ocr-v1.md).
- SharePoint notifications validate Microsoft subscription/client-state semantics and derive tenant/project from the stored subscription.
- Review callbacks, if enabled, validate the Review System's confirmed signed JWT/HMAC/mTLS or one-time exchange contract and correlate to the stored review task; token syntax or a requester string is insufficient.
- Service-to-service administrative APIs use a dedicated workload/service token with narrow audience and permissions.

A callback body/header may contain a tenant or project hint for correlation, but the engine derives authority from its stored connection/subscription/request record.

AWS access uses EKS workload identity/IRSA for each runtime role. It is separate from end-user/API authorization.

## Demo harness authentication

The temporary demo UI exercises the same bearer-token guard and permission checks as DevPortal.

For local automated tests, a dedicated test issuer/key pair or replaceable in-memory test validator may be injected only by the test composition root. Production artifacts/configuration must fail startup if a test/disabled validator is selected.

Demo fixtures include at least two tenants and users so tenant-isolation failures are visible before DevPortal migration.

## Errors and disclosure policy

| Condition                                           | HTTP status | Canonical error code                |
| --------------------------------------------------- | ----------- | ----------------------------------- |
| Missing bearer token                                | `401`       | `AUTHENTICATION_REQUIRED`           |
| Invalid signature/issuer/audience/type              | `401`       | `ACCESS_TOKEN_INVALID`              |
| Expired token                                       | `401`       | `ACCESS_TOKEN_EXPIRED`              |
| Required tenant context unavailable                 | `403`       | `TENANT_CONTEXT_REQUIRED`           |
| Valid identity lacks action permission              | `403`       | `PERMISSION_DENIED`                 |
| Actor cannot access requested project               | `403`       | `PROJECT_ACCESS_DENIED`             |
| Tenant-scoped resource missing or belongs elsewhere | `404`       | `RESOURCE_NOT_FOUND`                |
| Project authorization dependency unavailable        | `503`       | `PROJECT_AUTHORIZATION_UNAVAILABLE` |

Errors never disclose another tenant's identity, resource name, connection provider details, or document metadata.

## Audit requirements

Security-sensitive actions record:

- tenant, project, actor type/id;
- canonical permission/action;
- resource type/id;
- outcome and stable error code;
- correlation/causation identifiers;
- timestamp and active workflow version where relevant.

Audit records exclude raw tokens, passwords, provider credentials, document bytes, extracted field values, presigned URLs, and full connector configuration containing sensitive values.

## Required tests

1. Missing, malformed, expired, not-yet-valid, wrong-issuer, wrong-audience, unsupported-algorithm, and tampered tokens fail closed.
2. `x-client-id`, tenant headers, and tenant body fields cannot change authorization context.
3. User A cannot read, mutate, activate, upload to, review, or retry tenant B resources, including by guessed opaque ID.
4. Cross-tenant connection references fail validation and do not reveal connection existence.
5. Project permission changes follow the agreed cache/revocation bound.
6. Project-authorization outage follows the fail-closed/cache policy.
7. RabbitMQ messages and logs contain no JWT, authorization header, provider secret, or presigned URL.
8. Callback tenant hints cannot override the stored request/subscription/task owner.
9. System/operator actions require dedicated identity and create complete audit records.
10. The demo harness passes the same guard and tenant-isolation suite used for the future DevPortal client.

## Platform inputs still required

Phase 0B cannot mark this contract implementation-ready until the platform owners confirm:

1. Access token format: JWT versus opaque token.
2. OIDC issuer, discovery/JWKS URI, allowed algorithms, and AiFlow Engine audience.
3. Exact subject, tenant/organization, role, scope, token-ID, and service-identity claim names.
4. Whether one user can belong to multiple tenants and how the active tenant is selected.
5. Project authorization endpoint/protocol, request/response, service authentication, timeout, availability, and revocation expectations.
6. External platform-role to canonical-permission mapping.
7. Gateway behavior: token validation, header stripping, CORS origins, request/correlation identifiers, and rate-limit identity.
8. Service-token/token-exchange convention for engine-to-platform calls.
9. Non-production test issuer/token convention for CI and the demo harness.

These are configuration and integration decisions. They do not change the engine's normalized identity model or tenant-isolation rules.
