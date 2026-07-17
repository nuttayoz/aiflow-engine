# Custom Extraction Templates Contract v1

Status: Phase 0B proposal for Phase 5 implementation.

This contract defines how AiFlow Engine absorbs the AiFlow-relevant behavior of `personal-template-backend` without turning mutable prompts, provider models, or public template endpoints into workflow-core concepts. A “personal template” becomes a tenant-owned, versioned custom `ExtractionProfile` authoring resource.

The machine-readable definition is [`schemas/extraction-template-definition.v1.schema.json`](schemas/extraction-template-definition.v1.schema.json).

## Repository evidence and scope finding

`personal-template-backend` has materially different code lines:

- `main` at `829d37bed2dc` is an early create-only skeleton;
- `origin/develop` at `c68fb2130c46` includes v1/v2 template CRUD, customer/engine catalogs, single/multiple-file invocation, direct LiteLLM/AI Script calls, and Sentry;
- `origin/feature/doc-collection` at `6c5d368715b3` adds document-collection CRUD and is tagged `dev-v0.1.9.11`.

The inspected AiFlow runtime consumers are:

- `aiflow-trigger-handler` `7d5f9633af44`, which accepts `x-aiflow-my-template-endpoint`, persists it, and forwards it to the extraction API as `service_id`;
- `aiflow-webhook-processor` `85d2d46e78fd`, which fetches template fields by client/endpoint during processing;
- `aiflow-review-result` `e9b9e92d6e31`, which repeats that live template lookup after review.

No personal-template creation/list/edit UI or document-collection consumer was found in the inspected `devportal` or `devportal-backend` source. That absence does not prove there are no production consumers.

Observed behavior:

- a generated endpoint UUID groups one or more mutable template rows;
- each row stores a document-type description, `mapping_key`, optional `table_key`, additional instructions, and optional engine/model relation;
- `mapping_key` means source label or question -> output key;
- `table_key` means table header -> output column key;
- multiple rows under one endpoint are merged into one extraction invocation;
- v2 accepts up to ten files into memory, converts them to base64, and calls AI Script or LiteLLM directly;
- customer rows duplicate identity/profile data and a database `superuser` flag;
- route code validates client UUIDs but does not establish bearer authentication or canonical tenant authority;
- some v2 endpoint update/delete flows resolve by endpoint without applying the route's client ID in the service call;
- definitions are updated/deleted in place, so an execution can observe different fields from those selected when its workflow was created;
- application JSON limits reach 200 MB and invocation logs can include provider responses/extracted values;
- schema synchronization is environment-controlled rather than migration-only.

These are evidence for migration, not behavior to preserve. The deployed revision, real callers, database shape, provider path, and collection usage must be confirmed before cutover.

## Product boundary

```text
authorized author
  -> ExtractionTemplate
       -> immutable ExtractionTemplateVersion
            -> custom ExtractionProfile/ProfileVersion projection
                 -> immutable WorkflowVersion freezes profileVersionId
                      -> EXTRACT worker + approved external provider adapter
```

- An extraction template describes what fields to extract. It is not a workflow graph, destination mapping, document store, provider endpoint, model catalog, or synchronous invocation API.
- `packages/templates` owns authoring/versioning rules. `packages/extraction` consumes the resulting immutable profile version through its existing provider-neutral contract.
- The template API never receives document bytes and never invokes LiteLLM, AI Script, OCR, or another extraction provider.
- Workflow/execution behavior never performs a live “latest template” lookup. The workflow version freezes the exact template/profile version before intake.
- Provider/model selection is server-owned extraction-profile configuration. A caller cannot provide a model name, endpoint, API key, provider prompt envelope, or arbitrary URL.
- Tenant and actor identity come from the platform bearer token. AiFlow Engine does not recreate the legacy customer table, email ownership, or database `superuser` authorization model.
- Existing direct-upload and SharePoint entries converge on the same staged-document boundary. Selecting a custom template changes only the extraction profile.
- Adding a future Google or other entry connector does not change template resources.
- No new runtime service, deployment, queue, or database is created for templates.

## Resource model

### ExtractionTemplate

`ExtractionTemplate` is a stable tenant-owned authoring resource and the custom profile's stable catalog identity.

Conceptual fields:

| Field                                 | Meaning                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `templateId`                          | Opaque stable identity; also projected as custom `profileId` |
| `tenantId`                            | Mandatory ownership boundary                                 |
| `name`, `description`                 | Bounded author-controlled display metadata                   |
| `status`                              | `ACTIVE` or `ARCHIVED`                                       |
| `currentVersionId`, `versionNumber`   | Current immutable authoring version                          |
| `stateVersion`                        | Optimistic concurrency guard                                 |
| `createdBy`, `createdAt`, `updatedAt` | Audit-safe actor/timing metadata                             |

Templates are tenant-owned and reusable by workflows in projects the caller is authorized to manage. Reuse matches the existing tenant-scoped connection-library model. A workflow still requires project authorization and may reference only a template from the same tenant.

### ExtractionTemplateVersion

A version is immutable after creation. It contains:

- `templateVersionId`, template/tenant association, and template-local version number;
- definition schema version, canonical definition, definition hash, and immutable version fingerprint;
- deterministic compiled output JSON Schema and its hash;
- safe server-owned extraction processor/adapter policy reference;
- compatibility/support state and safe failure reason;
- author/correlation metadata and creation time.

For the extraction catalog projection:

```text
profileId        = templateId
profileVersionId = templateVersionId
profileKind      = CUSTOM
```

Built-in extraction profiles remain catalog-managed. Custom templates use the same workflow `extraction.profileId` field and the same OCR execution path; the workflow core does not add `templateId` beside `profileId`.

## Definition v1

Example:

```json
{
  "schemaVersion": 1,
  "sections": [
    {
      "sectionKey": "invoice_header",
      "documentType": "invoice",
      "fields": [
        {
          "sourceHint": "เลขที่ใบแจ้งหนี้",
          "outputKey": "invoice_number",
          "scope": "PAGE",
          "required": true
        },
        {
          "sourceHint": "What is the payment due date?",
          "outputKey": "due_date",
          "scope": "DOCUMENT",
          "required": false
        }
      ],
      "tableColumns": [
        {
          "sourceHint": "รายละเอียดสินค้า",
          "outputKey": "description",
          "required": true
        },
        {
          "sourceHint": "จำนวน",
          "outputKey": "quantity",
          "required": true
        }
      ],
      "additionalInstructions": "Use the tax invoice section when duplicate totals appear."
    }
  ]
}
```

`sections` preserve author order and group related hints; they do not create separate executions. Fields are explicit rather than relying on punctuation/language heuristics:

- `sourceHint` is a label or question supplied as extraction guidance;
- `outputKey` is the stable provider-neutral result key;
- `scope: PAGE` produces one value per page;
- `scope: DOCUMENT` produces one value for the whole accepted document;
- `required` controls output validation/warnings, not provider hallucination;
- `tableColumns` describe the one v1 tabular result per page;
- `additionalInstructions` refines extraction only. It cannot override security, tenancy, source identity, output schema, no-hallucination rules, provider limits, or system instructions.

V1 custom values normalize to bounded strings or null. Typed money/date/number/boolean extraction requires a later additive definition version with explicit normalization rules; types are not inferred from example values.

Validation additionally enforces rules that JSON Schema alone cannot express:

- `sectionKey` values are unique;
- document-level and page-level `outputKey` values are globally unique;
- table-column keys are unique and cannot collide with scalar keys;
- source/output strings are trimmed, normalized, and free of unsafe control characters;
- the serialized canonical definition is at most 256 KiB;
- aggregate sections/fields/instructions stay inside product/provider limits;
- unknown fields, provider model names, URLs, secrets, executable expressions, and caller-owned IDs are rejected.

## Compiled output contract

Version creation deterministically compiles the authoring definition into the custom profile's output JSON Schema. The canonical `ExtractionResult.data` shape is:

```json
{
  "document": {
    "due_date": "2026-08-15"
  },
  "pages": [
    {
      "fields": {
        "invoice_number": "INV-1001"
      },
      "table": [
        {
          "description": "Office supplies",
          "quantity": "2"
        }
      ]
    }
  ]
}
```

- Document-scoped keys exist only under `/document`.
- Page-scoped keys exist only under `/pages/*/fields`.
- Table rows use `/pages/*/table/*/<columnKey>`.
- Missing optional values are null or omitted according to the compiled schema; empty string is not silently converted to success.
- Required missing values produce stable warnings or fail according to the frozen profile policy.
- Confidence values remain in the canonical extraction envelope and point to these stable paths.
- Usage/billing units, template name, provider/model identifiers, and raw provider response fields are not extraction data.

Mappings and the review page use only the compiled profile schema/paths. They never parse `mapping_key`, `table_key`, provider prompt text, or a legacy endpoint.

## API contract

| Method and path                                                    | Purpose                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `POST /api/v1/extraction-templates`                                | Create one template and immutable version 1                      |
| `GET /api/v1/extraction-templates`                                 | Cursor-list authorized tenant templates by status/search         |
| `GET /api/v1/extraction-templates/:templateId`                     | Get safe metadata and current-version summary                    |
| `PATCH /api/v1/extraction-templates/:templateId`                   | Change display name/description only                             |
| `POST /api/v1/extraction-templates/:templateId/versions`           | Create the next immutable definition version                     |
| `GET /api/v1/extraction-templates/:templateId/versions`            | Cursor-list immutable version summaries                          |
| `GET /api/v1/extraction-templates/:templateId/versions/:versionId` | Get one authorized definition and compiled output schema         |
| `DELETE /api/v1/extraction-templates/:templateId`                  | Archive the template for new selection                           |
| `GET /api/v1/extraction-profiles`                                  | List built-in and authorized custom profile projections          |
| `GET /api/v1/extraction-profiles/:profileId`                       | Get selected built-in/custom profile metadata and current schema |

Create example:

```json
{
  "name": "Supplier invoice",
  "description": "Fields used by accounts payable workflows",
  "definition": {
    "schemaVersion": 1,
    "sections": [
      {
        "sectionKey": "invoice_header",
        "documentType": "invoice",
        "fields": [
          {
            "sourceHint": "Invoice number",
            "outputKey": "invoice_number",
            "scope": "DOCUMENT",
            "required": true
          }
        ],
        "tableColumns": [],
        "additionalInstructions": ""
      }
    ]
  }
}
```

The request does not accept `client_id`, email/customer details, endpoint UUID, engine/model ID, provider URL, or legacy numeric IDs.

All mutations require `Idempotency-Key`. Creating a new version also requires `basedOnVersionId`; concurrent authors cannot silently overwrite one another. Same key/fingerprint returns the same resource, while different input returns `IDEMPOTENCY_KEY_REUSED`.

List responses contain metadata only. Full definitions, source hints, output fields, and instructions are confidential configuration returned only by authorized detail/version endpoints with `Cache-Control: private, no-store` unless the platform approves an equivalent encrypted tenant-safe cache.

Stable errors include `TEMPLATE_NOT_FOUND`, `TEMPLATE_ARCHIVED`, `TEMPLATE_VERSION_CONFLICT`, `TEMPLATE_VERSION_UNCHANGED`, `TEMPLATE_DEFINITION_INVALID`, `TEMPLATE_OUTPUT_KEY_CONFLICT`, `TEMPLATE_PROCESSOR_UNAVAILABLE`, and common authorization/idempotency errors. A version request whose behavior fingerprint already exists returns `TEMPLATE_VERSION_UNCHANGED` with the existing authorized version ID rather than inserting another row.

Metadata edits and archive requests include `expectedStateVersion`. Version creation uses `basedOnVersionId`. A stale guard returns `TEMPLATE_VERSION_CONFLICT`; no mutation silently overwrites a concurrent change.

There is deliberately no `/invoke` endpoint in the template API. Documents enter through engine entry connectors and the normal execution API.

## Lifecycle and workflow binding

1. Create validates authorization, canonical definition, output compilation, configured processor compatibility, and product/provider bounds without invoking a document provider.
2. One transaction creates the stable template, version 1, current-version pointer, idempotency result, and audit event.
3. Editing creates another immutable version and atomically advances `currentVersionId`; previous versions remain readable while referenced.
4. Workflow-version creation resolves the selected custom `profileId` to its exact current supported `profileVersionId` and freezes it with the workflow version.
5. Workflow activation rechecks that the exact template/profile version and configured adapter policy are still installed and permitted. It does not silently move to a newer template version.
6. New template versions affect only workflow versions explicitly created or edited to select them.
7. Archive removes the template from new catalog selection. Existing workflow versions and accepted executions continue using their frozen version.
8. Physical deletion is retention work and is blocked while any workflow version, execution, retry chain, audit requirement, or migration reference needs the version.

An author who wants an existing workflow to use new template fields creates a new workflow version. This keeps extraction paths, mappings, review schema, and destination input mutually compatible.

## Extraction provider boundary

Custom templates do not change the external OCR contract:

- the extraction worker loads the exact `profileVersionId` and compiled schema;
- the adapter translates provider-neutral hints into its approved provider request;
- the exact source document streams from S3 to the provider path defined by [`ocr-v1.md`](ocr-v1.md);
- provider requests use the extraction request's stable submission key and reconciliation behavior;
- provider results are normalized/validated against the compiled schema before S3 acceptance;
- template definitions, hints, or provider payloads never travel through RabbitMQ;
- raw prompts, model names, response bodies, extracted values, and credentials are never logged.

A server-side processor policy may change credentials or rotate an equivalent model without changing the public definition only when its profile-version compatibility contract guarantees identical schema/semantics. A behavior/model change creates a new template/profile version or marks the old version unsupported for new activation; it never rewrites an accepted execution.

## Authentication, tenancy, and permissions

Initial permissions are:

| Permission                | Meaning                                            |
| ------------------------- | -------------------------------------------------- |
| `aiflow.template.read`    | List/read/select authorized templates and versions |
| `aiflow.template.create`  | Create a tenant template/version 1                 |
| `aiflow.template.update`  | Change metadata and create a new immutable version |
| `aiflow.template.archive` | Remove a template from new selection               |

- Tenant and actor come only from validated platform identity.
- A client/body/path `client_id`, customer email, or legacy superuser flag is never authority.
- Cross-tenant template lookup returns the same absence result as an unknown ID.
- Workflow creation requires `aiflow.template.read` plus authorization to the target project/workflow.
- Global all-customer template/customer/model endpoints are not part of the SaaS tenant API. Operator access uses separately audited platform tooling.
- Template instructions and field names are confidential tenant configuration and follow the same redaction rules as workflow mappings.

Exact role mapping and whether template administration is tenant-wide or limited to specific platform roles remain required auth/product inputs.

## Persistence and concurrency

Phase 5 adds `extraction_templates` and `extraction_template_versions` owned logically by `packages/templates`; physical TypeORM mappings remain in `packages/database`.

Required constraints:

- unique `(tenant_id, id)` tenant-scoped resource keys;
- unique `(tenant_id, extraction_template_id, version_number)`;
- unique `(tenant_id, extraction_template_id, version_fingerprint)` so identical extraction behavior does not create duplicate versions;
- tenant-scoped current-version and workflow/profile-version references;
- guarded template `state_version` updates;
- immutable version rows and `RESTRICT` deletion while referenced.

The stable row stores metadata/current pointer only. The version row stores bounded validated definition JSONB, compiled schema JSONB, hashes, safe processor-policy reference, compatibility state, and audit metadata. Its fingerprint covers the canonical definition, compiled schema, and processor-policy compatibility identity. It never stores documents, extracted values, provider requests/responses, credentials, API keys, customer profile data, or arbitrary URLs.

Create/version/archive transactions are short and database-only. Provider calls, document transfer, and extraction do not occur in a template transaction. No template-specific outbox/RabbitMQ command is required for v1 because validation/compilation is deterministic and local.

Known indexes support tenant template lists `(tenant_id, status, created_at, id)`, version history `(tenant_id, extraction_template_id, version_number)`, and exact profile-version resolution. Search is bounded prefix/substring search over name only initially; field/prompt full-text indexing is forbidden without a separate confidentiality and cost decision.

## Scaling and caching

- Cursor pagination replaces offset pagination for unbounded engine APIs.
- Template definitions are small, bounded configuration; they do not justify a separate service, database, Redis cache, or queue.
- Immutable versions may be cached in-process by `(tenantId, templateVersionId, versionFingerprint)`. PostgreSQL remains authoritative and a cache miss is normal.
- Current-version pointer reads are indexed; execution hot paths use the already frozen version ID rather than resolving “latest.”
- Worker concurrency and provider quotas remain extraction concerns, not template API scaling knobs.
- Large definitions, high mutation rates, or catalog search requirements must be measured before adding caches/search infrastructure.

## Legacy document collections and multi-file invocation

The newer feature branch defines “document collections” that group template endpoints and OCR service IDs. No inspected AiFlow runtime or DevPortal consumer proves that feature is part of the engine workflow product. Likewise, v2 direct invocation accepts multiple files as one request, while canonical AiFlow v1 intentionally has one staged document per execution.

Therefore:

- neither document-set execution nor a generic template/service collection is added to workflow core by assumption;
- if collections are only catalog folders, they may later become tenant-owned UI metadata referencing stable extraction `profileId` values and must not affect execution semantics;
- if collections perform routing/classification or multi-document extraction, they need a separate execution/state/artifact/idempotency contract;
- confirmed external users of direct single/multiple-file invocation must migrate to an engine workflow/upload entry or another owning product;
- `personal-template-backend` cannot be retired while a confirmed production collection/invoke consumer has no replacement, but that does not justify smuggling unconfirmed behavior into Phase 5.

## Migration and cutover

Migration is an explicit Phase 6 job, never a runtime fallback:

1. Confirm the deployed commit/tag and export database schema, row counts, endpoint groups, engines/models, active callers, collections, and last-use timestamps.
2. Map each legacy `client_id` to one canonical tenant through the auth/platform owner; email is not an ownership key.
3. Group legacy rows by `(tenant, endpoint)` in deterministic row-ID order and import one `ExtractionTemplate` plus version 1.
4. Convert each row to an ordered section. Convert `mapping_key` labels/questions into explicit source hints/output keys/scopes and `table_key` into table columns.
5. Detect ambiguous question scope, duplicate output keys, conflicting group names/engines, unsafe instructions, invalid mappings, and unsupported models. Flag for owner repair; never silently drop/rename fields.
6. Map the legacy engine/model to one approved server-side processor policy. Unsupported or unknown engines block activation.
7. Compile the output schema and compare representative synthetic current/new results and field paths.
8. Translate each migrated workflow's `(client_id, my_template_endpoint)` into the new custom `profileId`; create an immutable workflow version that freezes the imported profile version.
9. Keep legacy in-flight executions on the legacy template snapshot/path until drained. Do not make them read the new current version mid-run.
10. Inventory and migrate/redirect confirmed direct invoke, public endpoint URL, customer/engine admin, and collection consumers separately.
11. Disable legacy mutation before final export, reconcile counts/hashes/references, retain required audit evidence, then retire routes/database according to the approved retention plan.

Legacy endpoint/numeric IDs are migration aliases, not canonical API identities. A temporary compatibility mapping may live in migration tooling or a bounded ingress adapter; it does not become the workflow-core template key.

## Retention, security, and observability

- Active and referenced versions are retained. Archived unreferenced versions follow the confirmed workflow/audit retention period.
- Definitions and prompts are encrypted with normal PostgreSQL platform controls; no separate S3 artifact is created for small configuration.
- Audit events cover create, metadata edit, version creation, archive, denied cross-tenant access, workflow binding, import, and migration conflict without source hints/instructions.
- Metrics use operation/status/failure class, never tenant, name, output key, source hint, instruction, or definition hash labels.
- Logs include opaque template/version/correlation IDs and safe codes only.
- API/gateway bodies, JSON depth/keys/arrays, instructions, search, rates, and mutation concurrency are bounded.
- User instructions are untrusted content. They cannot enable tools/network, reveal system prompts, select an endpoint/model, weaken output validation, or override security/provider policies.
- Implementation and migration require the security review mandated by [`SECURITY.md`](../../SECURITY.md), especially for authorization, prompt handling, provider configuration, legacy public endpoints, and confidential migrations.

## Required acceptance cases

1. Creation commits one stable template, version, profile projection, idempotency result, and audit fact.
2. Invalid/oversized/duplicate-key definitions create no partial resource.
3. Concurrent version creation from the same base has exactly one winner; retries return the same version.
4. A workflow version freezes one exact custom profile version and never follows `currentVersionId` at execution time.
5. Editing/archiving a template cannot alter an accepted or historical execution.
6. Tenant A cannot list, read, version, archive, or bind tenant B's template.
7. Compiled output paths and schema are deterministic for the same canonical definition.
8. The extraction adapter normalizes valid custom results once and rejects unknown/oversized/wrong-schema output.
9. Document bytes never enter template endpoints, PostgreSQL, RabbitMQ, logs, or template caches.
10. Provider/model names, credentials, prompts, instructions, and extracted values do not leak through list APIs, messages, metrics, logs, or errors.
11. Migration converts label and question mappings explicitly and reports every ambiguous/colliding legacy group.
12. A migrated workflow resolves the same intended endpoint group without a runtime call to `personal-template-backend`.
13. Archived templates disappear from new selection while referenced workflow versions remain executable.
14. Contract tests prove no `/invoke`, client-selected tenant, public endpoint UUID, or database-superuser shortcut exists in canonical v1.
15. Confirmed collection/multi-file consumers are either migrated under an approved contract or block legacy service retirement visibly.

## Required confirmations before Phase 5 implementation

- `TEMPLATE-01` Product/Operations: confirm the deployed `personal-template-backend` revision/tag, database schema, route traffic, owners, and whether develop/collection branches are production behavior.
- `TEMPLATE-02` Product/Auth: confirm tenant-wide author/read/update/archive role mapping and whether templates may be reused across all authorized tenant projects.
- `TEMPLATE-03` Product/OCR owner: confirm label/question semantics, page/document scope, table output, missing/required behavior, limits, and representative fixtures.
- `TEMPLATE-04` OCR/Platform: map legacy engine/model IDs to approved extraction processor policies and confirm custom-profile idempotency, schema, quota, billing, and support behavior.
- `TEMPLATE-05` Product/Security: approve definition/instruction limits, prompt-injection controls, confidential storage/cache rules, and migration handling.
- `TEMPLATE-06` Product/Operations: inventory direct v1/v2 single/multiple-file invoke callers and choose engine-workflow migration, temporary adapter, or another owner.
- `TEMPLATE-07` Product: confirm whether document collections are deployed and whether they are catalog organization, routing, or multi-document execution.
- `TEMPLATE-08` Migration/Auth: provide canonical `client_id` -> tenant mapping, workflow endpoint references, duplicate/conflict policy, downtime/mutation freeze, and retention owner.
- `TEMPLATE-09` DevPortal/Product: identify the actual template authoring UI/client and confirm its target API/UX migration; the inspected DevPortal contains no such flow.

No legacy route retirement, model mapping, direct-invoke compatibility path, collection implementation, or production template migration proceeds until its applicable confirmation is recorded.
