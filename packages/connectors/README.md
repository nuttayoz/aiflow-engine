# Connector Packages

These directories reserve provider boundaries only. They contain no connector behavior yet.

Initial connector targets:

- Direct upload
- Generic webhook
- Microsoft SharePoint
- Microsoft Business Central
- Dynamics NAV

Business Central and Dynamics NAV remain separate adapters because their API, authentication, version, customization, and reconciliation contracts differ. They share only the provider-neutral destination port and connector test suite.

Each installed entry/destination capability declares the `NONE`, `VALIDATE_ONLY`, or `MANAGED` activation behavior defined by [`workflow-provisioning-v1.md`](../../docs/contracts/workflow-provisioning-v1.md). Managed provider resources remain adapter-owned behind the same durable provisioning operation contract.

Future Google and other connectors will be added only after the connector SDK contract is implemented and approved.
