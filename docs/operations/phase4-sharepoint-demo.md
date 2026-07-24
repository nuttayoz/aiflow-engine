# Phase 4 SharePoint Entry Runbook

This runbook proves that a SharePoint-origin document reaches the existing
AiFlow execution pipeline without n8n and without sending document bytes
through the API, PostgreSQL, or RabbitMQ.

## Automated proof

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run phase4:prepare
bun run phase4:smoke
```

The smoke command builds the repository, starts temporary API, worker, and
scheduler roles, creates a SharePoint-entry workflow through the public API,
and waits for the seeded post-baseline document to complete. It also proves the
Graph validation challenge, verifies that delta replay does not create a
second execution, and waits for managed deactivation to confirm last-reference
subscription cleanup.

Expected output includes:

```text
filename: sharepoint-demo.pdf
EXTRACT: SUCCEEDED
MAP: SUCCEEDED
REVIEW: SKIPPED
DELIVER: SUCCEEDED
status: SUCCEEDED
deactivation: SUCCEEDED
```

Do not run another local worker against the same RabbitMQ virtual host while the
isolated smoke command is running, because both workers can consume the same
queues.

## Existing DevPortal proof

Start the engine roles:

```bash
bun run start:api
bun run start:worker
bun run start:scheduler
```

Start `devportal-frontend` on port `3001`, sign in through its normal local
flow, and use project `demo-project-a`.

1. Create a Microsoft Business Central connection for the destination.
2. Create a Microsoft SharePoint connection for the entry.
3. Create a workflow and select the SharePoint folder entry.
4. Enter these deterministic local provider IDs:

   | Field     | Local value               |
   | --------- | ------------------------- |
   | Site      | `demo-sharepoint-site`    |
   | Drive     | `demo-sharepoint-drive`   |
   | Folder    | `demo-sharepoint-inbound` |
   | Recursive | enabled                   |

5. Configure the existing invoice extraction/mapping and Business Central
   destination, then activate the workflow.
6. Open the workflow entry/status page. One `sharepoint-demo.pdf` execution
   appears after the metadata baseline and completes through the normal stages.
7. Deactivate the workflow. The UI waits for managed cleanup; after completion
   the workflow is inactive, accepts no new documents, and has no pending
   cleanup.

Each fresh local watch receives one deterministic document after its baseline.
The fake Graph and fake destination adapters are non-production composition
only. Production startup does not silently substitute them for real Microsoft
adapters.

## Real Microsoft acceptance

Use a dedicated sandbox tenant and an HTTPS callback reachable by Microsoft.
Configure `SHAREPOINT_GRAPH_MODE=MICROSOFT_GRAPH`, inject the registered
multi-tenant application's client ID and secret through the platform secret
mechanism, set the exact callback URL and approved DevPortal consent origin,
and explicitly grant the documented `Files.Read.All` application permission.

Run the same DevPortal journey with the resource browser. Confirm site,
library, and folder listing; activation; subscription create/renew/delete;
post-baseline file ingestion; cursor recovery; and deactivation. Do not approve
production until Kubernetes ingress, egress, secret, resource, autoscaling,
metrics, alert, and disruption checks from the security review are recorded.
