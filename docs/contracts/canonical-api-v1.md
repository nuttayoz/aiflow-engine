# Canonical AiFlow API v1

Status: initial Phase 0B contract, 2026-07-14.

This contract defines the API that the existing DevPortal will call directly for new AiFlow functionality. It is independent of n8n, legacy DevPortal workflow payloads, and any specific connector vendor.

The machine-readable workflow-definition envelope is [`schemas/workflow-definition.v1.schema.json`](schemas/workflow-definition.v1.schema.json).

## Decisions

- Public base path: `/api/v1`.
- DevPortal calls AiFlow Engine directly through the platform API gateway.
- All identifiers are opaque strings. Clients must not parse or infer meaning from them.
- Workflow configuration is immutable and versioned.
- Workflow activation is separate from draft creation or editing because connector provisioning may be asynchronous.
- Connector-specific configuration is validated by connector-owned schemas.
- Legacy `payload_version`, `nodes`, `app_connection`, n8n type names, and `x-client-id` are not accepted.
- Document bytes never pass through these JSON APIs, PostgreSQL, or RabbitMQ.

## Version terminology

Three versions have different purposes:

| Term                      | Example                       | Meaning                                                 |
| ------------------------- | ----------------------------- | ------------------------------------------------------- |
| HTTP API version          | `/api/v1`                     | Version of paths, request bodies, responses, and errors |
| Definition schema version | `definition.schemaVersion: 1` | Shape of the provider-neutral workflow definition       |
| Workflow version          | `versionNumber: 3`            | Third immutable configuration revision of one workflow  |

Changing a workflow creates a new workflow version. It does not change the HTTP API version or reuse the legacy `payload_version` concept.

## Authentication and request headers

All DevPortal requests require:

```http
Authorization: Bearer <access-token>
```

Mutation requests that can be retried require:

```http
Idempotency-Key: <client-generated-opaque-key>
```

AiFlow Engine validates the token and derives tenant and actor context from the agreed platform claims. It also verifies access to the project in the request path. A client-supplied tenant or `x-client-id` is ignored or rejected.

The engine returns a correlation identifier in both the response header and error body:

```http
X-Correlation-ID: <correlation-id>
```

The normalized security model is defined in [`auth-tenancy.md`](auth-tenancy.md). Exact claim names and project-authorization platform values remain required Phase 0B inputs.

## Resource vocabulary

| Resource              | Responsibility                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `Workflow`            | Stable identity, project ownership, display metadata, lifecycle, and active version                 |
| `WorkflowVersion`     | Immutable validated workflow definition                                                             |
| `ConnectorDescriptor` | Entry/destination capabilities, display metadata, connection requirements, and configuration schema |
| `Connection`          | Tenant-scoped reference to an authorized external system; secret material is never returned         |
| `ExtractionProfile`   | Available extraction provider capability and output-field schema                                    |
| `UploadSession`       | Authorized direct-to-S3 upload plan and completion boundary                                         |
| `Document`            | Immutable staged object metadata and source identity                                                |
| `Execution`           | One durable end-to-end run through the workflow state machine                                       |
| `ReviewTask`          | Human review state attached to an execution                                                         |

## Workflow definition schema

The stable definition envelope contains five processing concerns:

```json
{
  "schemaVersion": 1,
  "entry": {
    "connectorId": "direct-upload",
    "config": {}
  },
  "extraction": {
    "profileId": "general-invoice",
    "config": {}
  },
  "mappings": [
    {
      "sourceField": "invoice_number",
      "targetField": "documentNumber",
      "required": true
    }
  ],
  "reviewPolicy": {
    "required": false
  },
  "destination": {
    "connectorId": "microsoft-business-central",
    "connectionId": "connection-id",
    "actionId": "create-purchase-invoice-draft",
    "config": {
      "companyId": "company-id"
    }
  }
}
```

The envelope is vendor-neutral. `entry.config`, `extraction.config`, and `destination.config` are validated against the selected descriptor/profile schema. Display labels and icons come from catalogs and are not duplicated as authoritative workflow data.

### SharePoint entry example

The Microsoft connector can replace only the entry binding:

```json
{
  "connectorId": "microsoft-sharepoint",
  "connectionId": "connection-id",
  "config": {
    "siteId": "site-id",
    "driveId": "document-library-id",
    "folderId": "folder-id",
    "includeSubfolders": false
  }
}
```

These Microsoft fields are illustrative until the Graph product/version and subscription contracts are confirmed. They live inside the connector schema, so they do not change the workflow-definition envelope.

### Future Google entry example

```json
{
  "connectorId": "google-drive",
  "connectionId": "connection-id",
  "config": {
    "folderId": "folder-id",
    "includeSubfolders": false
  }
}
```

Adding this connector requires a new descriptor, implementation, and contract tests—not a new core payload version.

## Workflow endpoints

| Method and path                                         | Purpose                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `POST /api/v1/projects/:projectId/workflows`            | Create a workflow and its first draft version                  |
| `GET /api/v1/projects/:projectId/workflows`             | List project workflows                                         |
| `GET /api/v1/workflows/:workflowId`                     | Get workflow metadata and version summary                      |
| `PATCH /api/v1/workflows/:workflowId`                   | Change workflow display metadata only                          |
| `DELETE /api/v1/workflows/:workflowId`                  | Archive/delete according to retention policy                   |
| `POST /api/v1/workflows/:workflowId/versions`           | Create a new immutable draft version                           |
| `GET /api/v1/workflows/:workflowId/versions`            | List workflow versions                                         |
| `GET /api/v1/workflows/:workflowId/versions/:versionId` | Get one immutable version                                      |
| `PUT /api/v1/workflows/:workflowId/activation`          | Activate a selected version, provisioning connectors as needed |
| `DELETE /api/v1/workflows/:workflowId/activation`       | Stop new entry while retaining history                         |

### Create workflow

```http
POST /api/v1/projects/31/workflows
Authorization: Bearer <token>
Idempotency-Key: create-invoice-intake-01
Content-Type: application/json
```

```json
{
  "name": "Invoice intake",
  "definition": {
    "schemaVersion": 1,
    "entry": {
      "connectorId": "direct-upload",
      "config": {}
    },
    "extraction": {
      "profileId": "general-invoice",
      "config": {}
    },
    "mappings": [
      {
        "sourceField": "invoice_number",
        "targetField": "documentNumber",
        "required": true
      }
    ],
    "reviewPolicy": {
      "required": false
    },
    "destination": {
      "connectorId": "microsoft-business-central",
      "connectionId": "connection-id",
      "actionId": "create-purchase-invoice-draft",
      "config": {
        "companyId": "company-id"
      }
    }
  }
}
```

Successful response:

```http
HTTP/1.1 201 Created
```

```json
{
  "data": {
    "id": "workflow-id",
    "projectId": "31",
    "name": "Invoice intake",
    "status": "DRAFT",
    "activeVersionId": null,
    "latestVersion": {
      "id": "version-id",
      "versionNumber": 1,
      "schemaVersion": 1,
      "status": "VALID"
    },
    "createdAt": "2026-07-14T08:00:00.000Z",
    "updatedAt": "2026-07-14T08:00:00.000Z"
  }
}
```

Creation validates the envelope, extraction profile, connector bindings, connection ownership, connector configuration, mappings, and destination action. It does not activate or provision external subscriptions.

### Create a new workflow version

```http
POST /api/v1/workflows/workflow-id/versions
Authorization: Bearer <token>
Idempotency-Key: edit-invoice-intake-02
```

```json
{
  "basedOnVersionId": "previous-version-id",
  "definition": {
    "schemaVersion": 1,
    "entry": {},
    "extraction": {},
    "mappings": [],
    "reviewPolicy": {},
    "destination": {}
  }
}
```

The abbreviated nested objects above represent a complete definition conforming to the schema. `basedOnVersionId` provides optimistic edit context. The server rejects a stale edit when the agreed concurrency rule is violated.

### Activate a version

```http
PUT /api/v1/workflows/workflow-id/activation
Authorization: Bearer <token>
Idempotency-Key: activate-invoice-intake-version-2
```

```json
{
  "versionId": "version-id"
}
```

Activation returns `200 OK` when no asynchronous provisioning is required and `202 Accepted` when connector resources such as SharePoint subscriptions must be provisioned. In the asynchronous case the response includes an operation identifier and the workflow reports `PROVISIONING` until it becomes `ACTIVE` or `PROVISIONING_FAILED`.

Deactivation is idempotent. It stops new entry and subscription intake but does not cancel already accepted executions.

## Catalog and connection endpoints

| Method and path                                                 | Purpose                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/v1/connectors`                                        | List descriptors, filterable by `capability=entry                           | destination` |
| `GET /api/v1/connectors/:connectorId`                           | Get descriptor, actions, connection requirements, and configuration schemas |
| `GET /api/v1/extraction-profiles`                               | List extraction profiles available to the project/tenant                    |
| `GET /api/v1/extraction-profiles/:profileId`                    | Get profile metadata and output-field schema                                |
| `POST /api/v1/connections`                                      | Create a connection shell/configuration                                     |
| `GET /api/v1/connections`                                       | List tenant connections, filterable by connector                            |
| `GET /api/v1/connections/:connectionId`                         | Get safe metadata and health/authorization status                           |
| `PATCH /api/v1/connections/:connectionId`                       | Update safe metadata or connector-owned configuration                       |
| `DELETE /api/v1/connections/:connectionId`                      | Delete when references and policy allow                                     |
| `POST /api/v1/connections/:connectionId/authorization-sessions` | Start an OAuth/consent flow                                                 |
| `GET /api/v1/connections/:connectionId/resources`               | Browse provider resources through connector capabilities                    |

Connection responses never expose refresh tokens, client secrets, encrypted provider blobs, presigned URLs, or raw secret-manager references.

## Upload and execution endpoints

| Method and path                                                                       | Purpose                                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /api/v1/workflows/:workflowId/upload-sessions`                                  | Authorize an upload and return a short-lived S3 plan                  |
| `POST /api/v1/upload-sessions/:uploadSessionId/parts/:partNumber/upload-capabilities` | Issue/refresh one checksum-bound multipart capability                 |
| `POST /api/v1/upload-sessions/:uploadSessionId/complete`                              | Verify uploaded object metadata and durably create document/execution |
| `DELETE /api/v1/upload-sessions/:uploadSessionId`                                     | Abort an incomplete upload session                                    |
| `GET /api/v1/workflows/:workflowId/executions`                                        | List workflow executions with filters/pagination                      |
| `GET /api/v1/executions/:executionId`                                                 | Get state, stage summary, failure, and audit-safe metadata            |
| `POST /api/v1/executions/:executionId/retries`                                        | Request a guarded retry from an allowed failed state                  |

Upload-session creation accepts only file metadata such as name, content type, size, and checksum. The server selects and returns a self-describing single-part or multipart plan; client input cannot weaken validation. Completion returns an `executionId`; background processing never holds the upload HTTP request open.

The storage-object boundary, upload plans, exact S3 verification, expiry, idempotent completion, and deletion behavior are defined in [`storage-v1.md`](storage-v1.md).

The provider-neutral states, attempts, transition guards, failure categories, and manual-retry behavior are defined in [`execution-lifecycle.md`](execution-lifecycle.md). Extraction profiles, immutable output schemas, and external OCR behavior are defined in [`ocr-v1.md`](ocr-v1.md). Microsoft destination connections/actions, stable effect identity, and receipts are defined in [`dynamics-destination-v1.md`](dynamics-destination-v1.md).

## Review endpoints

| Method and path                                     | Purpose                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/v1/workflows/:workflowId/review-tasks`    | List review tasks, filterable by status                    |
| `GET /api/v1/review-tasks/:reviewTaskId`            | Get safe review-task metadata and adapter link             |
| `POST /api/v1/review-tasks/:reviewTaskId/decisions` | Submit one authenticated, idempotent approval or rejection |

Decision example:

```json
{
  "decision": "APPROVE",
  "revisedData": {},
  "enableFeedback": false
}
```

The review adapter defines how document/result artifacts are exchanged with the existing Review System. A request header such as `x-aiflow-review-approved` is never sufficient authority.

## Response and error envelopes

Successful single-resource responses use:

```json
{
  "data": {}
}
```

List responses use cursor pagination:

```json
{
  "data": [],
  "page": {
    "nextCursor": null
  }
}
```

Errors use:

```json
{
  "error": {
    "code": "WORKFLOW_CONFIGURATION_INVALID",
    "message": "Workflow configuration is invalid",
    "retryable": false,
    "correlationId": "correlation-id",
    "details": [
      {
        "path": "definition.destination.config.companyId",
        "code": "REQUIRED"
      }
    ]
  }
}
```

HTTP status codes retain their normal meaning. Retry decisions must use both status and `error.retryable`; clients must not retry every `5xx` mutation without the same idempotency key.

## Direct DevPortal mapping

| Existing UI area    | Canonical API use                                                               |
| ------------------- | ------------------------------------------------------------------------------- |
| Workflow list/table | Project workflow list plus activation/deactivation                              |
| Step One            | Workflow name and extraction-profile catalog                                    |
| Step Two            | Connector descriptors, connections, resources, mappings, and review policy      |
| Step Three          | Create workflow, then explicitly activate the returned version when selected    |
| Edit wizard         | Get workflow/version and create a new immutable version                         |
| Connections page    | Connection and authorization-session endpoints                                  |
| Demo/upload         | Upload session, direct S3 transfer, completion, and execution query             |
| Review list/page    | Review-task list/get/decision endpoints plus the existing Review System adapter |

DevPortal may continue to use `devportal-backend` for unrelated project, account, payment, and product features. No AiFlow Engine API request is proxied through it.

## Temporary demo harness

Before modifying the real DevPortal, Phase 2 uses a disposable internal UI under `tools/demo-ui` to prove this API and the DevPortal-shaped journey.

The harness mirrors only the necessary UX boundaries:

1. Workflow list and activation status.
2. Step One: workflow name and extraction profile.
3. Step Two: entry connector, destination connector, connections, mappings, and review policy visibility.
4. Step Three: summary, create draft, and explicit activation.
5. Direct browser-to-S3 upload.
6. Execution state, failure details, and guarded retry.

The harness must:

- Call only `/api/v1` through the same generated/typed client intended for the later DevPortal integration.
- Render or validate the same workflow-definition and connector schemas.
- Use the same bearer-token and project-authorization behavior as the future DevPortal client.
- Exercise real PostgreSQL, RabbitMQ, S3, outbox/inbox, idempotency, worker, and reconciliation behavior.
- Mock external OCR or Dynamics boundaries only when the real sandbox is unavailable.
- Never read engine databases, publish RabbitMQ messages, or invoke worker-internal endpoints directly.
- Remain outside the production engine image and deployments.
- Be disposable after the real DevPortal migration; it is not a second product frontend.

Phase 3 begins only after the harness proves the end-to-end flow and freezes canonical request/response fixtures. UI components do not need to be shared with the legacy React application; the API client, JSON schemas, fixtures, and behavior contracts do.

## Legacy migration boundary

Legacy v1 and v2 payloads are inputs to migration tooling only:

```text
legacy workflow -> parse v1/v2 -> resolve credentials/connections -> canonical definition -> validate -> create engine workflow/version
```

The migration records source identifiers for audit and endpoint redirection, but canonical resources do not use n8n IDs or node types as their identity. New DevPortal requests never submit legacy payloads.

## Open items before implementation freeze

1. Supply the platform values required by [`auth-tenancy.md`](auth-tenancy.md): claims, issuer/audience/JWKS, permission mapping, and project-authorization service contract.
2. Confirm the Microsoft product/action/connection/schema values required by [`dynamics-destination-v1.md`](dynamics-destination-v1.md).
3. SharePoint subscription, resource-selection, delta, and permission schemas.
4. Existing Review System adapter and artifact ownership.
5. Confirm the provider and initial profile/schema values required by [`ocr-v1.md`](ocr-v1.md).
6. Workflow activation and provisioning state transition table.
7. Product/platform confirmation of the proposed file size, multipart threshold, checksum algorithm/type, upload expiry, and retention in [`storage-v1.md`](storage-v1.md).
8. Cursor format, default/max page size, and retention visibility.
9. Whether workflow deletion is archive-only or supports later hard deletion.

These open items may refine connector schemas and lifecycle responses. They must not reintroduce provider-specific fields into the definition envelope.
