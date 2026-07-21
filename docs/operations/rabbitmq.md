# RabbitMQ Operations

AiFlow uses durable topic exchanges, quorum queues, publisher confirms, manual
acknowledgements, bounded delivery attempts, and one inspectable DLQ per source
queue. A message ID is preserved across redelivery and replay; PostgreSQL inbox
deduplication remains the authority that prevents a repeated stage transition.

## Inspect before replay

Use the existing RabbitMQ management UI or platform tooling to inspect the DLQ,
its depth, the message type, and safe headers. Never copy message bodies into
tickets or chat. Malformed or contract-invalid messages remain in the DLQ and
must be diagnosed rather than replayed.

Local management UI: `http://localhost:55673`.

## Bounded replay

Start the worker that owns the source queue, then run:

```bash
bun run dlq:replay -- --queue=aiflow.q.stage.extract.v1 --limit=100
```

The command validates each envelope, republishes it with mandatory confirmed
delivery, acknowledges the DLQ copy only after confirmation, and stops on the
first invalid or failed item. Exit code `2` means an item was left in place for
inspection. Replaying is safe only after the underlying failure has been fixed.

Do not use broker shovel/move tooling for AiFlow replay because it bypasses the
envelope validation and confirmed-publication boundary.
