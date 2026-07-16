# RabbitMQ Messaging Contract v1

Status: Phase 0B proposal for Phase 1 implementation.

This contract defines message shape, topology, delivery semantics, and recovery boundaries. It does not select a TypeScript RabbitMQ library or prescribe deployment manifests.

## Role of RabbitMQ

RabbitMQ transports short-lived commands that tell workers durable work may be eligible. It is not the source of truth, a workflow state store, a business retry timer, or document transport.

A worker must load authoritative state from PostgreSQL and win an atomic state/lease guard before doing work. Message order is not trusted.

Delivery is at least once. Publisher confirms and consumer acknowledgements reduce message loss but do not remove duplicate-delivery cases, so handlers must be idempotent. This matches RabbitMQ's [reliability guidance](https://www.rabbitmq.com/docs/reliability).

## Envelope

All engine-owned messages use [`message-envelope.v1.schema.json`](schemas/message-envelope.v1.schema.json).

```json
{
  "schemaVersion": 1,
  "messageId": "msg_opaque",
  "kind": "COMMAND",
  "type": "aiflow.execution.stage.extract.requested.v1",
  "occurredAt": "2026-07-16T08:30:00Z",
  "tenantId": "ten_opaque",
  "projectId": "prj_opaque",
  "correlationId": "cor_opaque",
  "causationId": "req_or_msg_opaque",
  "actor": {
    "type": "USER",
    "id": "usr_opaque"
  },
  "data": {
    "executionId": "exe_opaque",
    "stage": "EXTRACT",
    "expectedStateVersion": 0
  },
  "trace": {
    "traceparent": "00-trace-id-parent-id-01"
  }
}
```

Rules:

- Identifiers are opaque and never encode tenancy or provider secrets.
- `messageId` identifies one logical publication. An outbox republish after an uncertain confirm keeps the same value.
- `correlationId` follows the end-to-end user or system operation.
- `causationId` identifies the request, message, callback, or scheduler run that caused this message.
- `actor` is the normalized audit identity snapshot. It contains no token, role, or permission list.
- `expectedStateVersion` lets the consumer reject stale or out-of-order work without guessing.
- `trace` is optional W3C trace context and is not an authorization input.
- The encoded envelope, including application headers, is limited to 64 KiB. Larger configuration and results belong in PostgreSQL; document bytes and artifacts belong in S3.

## Command types and data

The envelope schema validates common metadata. Each message type has a separate data contract in code and contract tests.

| Message type                                                           | Required `data`                                                        | Purpose                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `aiflow.execution.stage.extract.requested.v1`                          | `executionId`, `stage: EXTRACT`, `expectedStateVersion`                | Claim extraction work                                   |
| `aiflow.execution.stage.map.requested.v1`                              | `executionId`, `stage: MAP`, `expectedStateVersion`                    | Claim mapping work                                      |
| `aiflow.execution.stage.review.requested.v1`                           | `executionId`, `stage: REVIEW`, `expectedStateVersion`                 | Create or reconcile a review task                       |
| `aiflow.execution.stage.deliver.connector.<connector-id>.requested.v1` | `executionId`, `stage: DELIVER`, `connectorId`, `expectedStateVersion` | Claim destination-specific delivery                     |
| `aiflow.execution.stage.reconcile.requested.v1`                        | `executionId`, `stage`, `expectedStateVersion`                         | Reconcile a persisted wait or unknown outcome           |
| `aiflow.document.ingest.connector.<connector-id>.requested.v1`         | `ingestionId`, `connectorId`, `expectedStateVersion`                   | Claim provider-entry ingestion before `DOCUMENT_STAGED` |

Messages carry only lookup identifiers and concurrency guards. Workers load workflow configuration, connection references, object keys, retry policy, and provider state through tenant-scoped repositories.

New providers add connector-specific message types and bindings. They do not add provider fields to core execution commands.

## Proposed topology

The platform owns cluster-level policies. AiFlow Engine owns declarations inside one environment-specific vhost, proposed as `aiflow-engine-<environment>`.

### Exchanges

| Exchange             | Type                    | Purpose                                                                      |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `aiflow.commands.v1` | durable topic           | Worker commands                                                              |
| `aiflow.dlx.v1`      | durable topic           | Dead-letter routing                                                          |
| `aiflow.events.v1`   | durable topic, reserved | Domain integration events; declare only when a real consumer contract exists |

The command routing key is the message `type` without the leading `aiflow.`. For example, `aiflow.execution.stage.extract.requested.v1` uses `execution.stage.extract.requested.v1`.

### Queues and bindings

| Queue pattern                                  | Binding key                                                     | Scaling boundary                    |
| ---------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `aiflow.q.stage.extract.v1`                    | `execution.stage.extract.requested.v1`                          | Extraction workers                  |
| `aiflow.q.stage.map.v1`                        | `execution.stage.map.requested.v1`                              | Mapping workers                     |
| `aiflow.q.stage.review.v1`                     | `execution.stage.review.requested.v1`                           | Review-adapter workers              |
| `aiflow.q.stage.reconcile.v1`                  | `execution.stage.reconcile.requested.v1`                        | Reconciliation workers              |
| `aiflow.q.connector.<connector-id>.ingest.v1`  | `document.ingest.connector.<connector-id>.requested.v1`         | One installed entry connector       |
| `aiflow.q.connector.<connector-id>.deliver.v1` | `execution.stage.deliver.connector.<connector-id>.requested.v1` | One installed destination connector |

Each source queue has an inspectable dead-letter queue named `aiflow.dlq.<source-name>.v1`, bound to `aiflow.dlx.v1` by the source queue name.

All work queues are durable quorum queues. RabbitMQ describes quorum queues as the default replicated choice when data safety matters; its [quorum queue documentation](https://www.rabbitmq.com/docs/quorum-queues) also requires careful delivery-limit and dead-letter configuration.

Queue boundaries are per stage or installed connector capability—not per tenant, project, workflow, or connection. This keeps topology bounded while allowing Kubernetes worker deployments to scale independently with queue-specific concurrency.

Only enabled connector modules declare their stable queues and bindings. Runtime user input can never create arbitrary exchanges, queues, or binding keys.

## Publisher contract

The application commits domain state and an outbox row in the same PostgreSQL transaction. An outbox publisher then:

1. claims a batch of unpublished rows with a bounded lease;
2. publishes persistent messages to `aiflow.commands.v1` with mandatory routing;
3. waits for publisher confirms;
4. marks the rows published only after confirmation;
5. republishes the same logical message and `messageId` if the confirmation outcome is unknown.

An unroutable mandatory publication is a deployment/configuration error. The row remains recoverable and an operator alert is raised; the publisher does not silently discard it.

AMQP properties map as follows:

| Property        | Value                                                |
| --------------- | ---------------------------------------------------- |
| `contentType`   | `application/json`                                   |
| `deliveryMode`  | persistent (`2`)                                     |
| `messageId`     | envelope `messageId`                                 |
| `type`          | envelope `type`                                      |
| `correlationId` | envelope `correlationId`                             |
| `timestamp`     | envelope `occurredAt` converted to an AMQP timestamp |

## Consumer contract

A consumer handles a delivery in this order:

1. Enforce the 64 KiB limit and validate JSON, envelope version, message type, and the type-specific data contract.
2. Begin a short PostgreSQL transaction with tenant-scoped repositories.
3. Insert or find the inbox record by logical consumer name plus `messageId`.
4. Load the target and atomically claim eligible work using tenant, target ID, `expectedStateVersion`, and lease conditions.
5. Commit the durable inbox/claim result.
6. Acknowledge the RabbitMQ delivery.
7. If a new claim was won, perform the external or compute work under the persisted lease and commit its guarded result.

The inbox distinguishes `CLAIMED`, `DUPLICATE`, `STALE`, and `REJECTED` outcomes for audit and metrics. A duplicate or stale message is acknowledged after the durable decision and does no work.

Acknowledgement after the durable claim means a crash during actual work is recovered from the lease by the scheduler; it does not require a broker delivery to remain open during OCR, review, or destination calls.

Consumer prefetch and stage concurrency are explicit per worker deployment. They must not exceed the database connection budget or the relevant provider limit.

## Retry and dead-letter rules

There are two separate mechanisms:

### Transport redelivery

Before a durable inbox/claim decision, a transient database or broker interruption may leave the delivery unacknowledged so RabbitMQ can redeliver it. Quorum queue policies must set a finite delivery limit and a dead-letter exchange. The initial proposal is an explicit limit of 20, matching the RabbitMQ 4.x default, but the platform owner must confirm the operated policy.

Malformed, unsupported, oversized, or repeatedly unhandleable messages are rejected without requeue and dead-lettered. Consumers never use an immediate `nack`/requeue loop.

### Business retry

Provider throttling, timeouts, and retryable stage failures follow the [execution lifecycle](execution-lifecycle.md). The attempt result and `nextAttemptAt` are persisted; when due, the scheduler creates a new outbox command. Business retry does not consume a RabbitMQ delivery and does not depend on broker retry queues or plugins.

An uncertain destination result is reconciled before any new write attempt.

### DLQ handling

DLQs are for poison messages, unsupported contracts, topology mistakes, or exhausted transport handling—not normal provider failures.

Operator replay must:

1. inspect the original failure and current PostgreSQL state;
2. pass the same authorization and transition guard as any other recovery action;
3. create a new outbox row with a new `messageId` and the original message as `causationId`;
4. preserve an audit record.

Operators do not edit a message and republish directly to a work queue. A replay that is no longer valid becomes a safe stale command.

## Versioning

- `schemaVersion` versions the common envelope.
- The final `.v1` in `type`, routing keys, exchanges, and queues versions the semantic contract.
- Additive optional fields may be introduced when old consumers ignore them safely.
- Removing, renaming, changing meaning, or making a field required creates a new message type version.
- Producers publish one agreed version during a rollout; consumers may temporarily accept adjacent versions for migration.
- Unknown envelope or message-type versions are dead-lettered and alerted, never guessed.

## Security and tenancy

- The worker validates that envelope tenant/project identifiers match the loaded target; IDs in a message never override database ownership.
- Messages exclude JWTs, authorization headers, roles, provider credentials, connection secrets, document bytes, extracted values, object contents, and presigned URLs.
- Broker users are least privileged by runtime role and vhost.
- TLS and broker authentication are mandatory platform inputs.
- Logs and dead-letter tooling apply the same confidential-data policy as the API.

## Phase 1 acceptance cases

The implementation must prove at least these cases:

1. API termination after commit but before publish still results in publication.
2. An uncertain publisher confirm may duplicate a message but cannot duplicate work.
3. Worker termination before durable claim causes safe transport redelivery.
4. Worker termination after acknowledgement is recovered from the persisted lease.
5. Duplicate, stale, and out-of-order messages do not repeat a transition.
6. Invalid and exhausted transport messages enter the correct inspectable DLQ.
7. Operator replay is guarded, auditable, and safe when state has moved on.
8. No queue or message contains document bytes or confidential credentials.
9. One connector queue can scale independently without creating per-tenant topology.
