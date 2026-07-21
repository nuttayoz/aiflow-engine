# Connector Packages

The provider-neutral SDK and shared contract checks are implemented in Phase 1.
The `direct-upload` entry descriptor and a non-production `phase1-synthetic`
destination are installed at this stage. Provider adapters remain reserved until
their owning roadmap phase.

Initial connector targets:

- Direct upload
- Generic webhook
- Microsoft SharePoint
- Microsoft Business Central
- Dynamics NAV

Business Central and Dynamics NAV remain separate adapters because their API, authentication, version, customization, and reconciliation contracts differ. They share only the provider-neutral destination port and connector test suite.

Each installed entry/destination capability declares the `NONE`, `VALIDATE_ONLY`, or `MANAGED` activation behavior defined by [`workflow-provisioning-v1.md`](../../docs/contracts/workflow-provisioning-v1.md). Managed provider resources remain adapter-owned behind the same durable provisioning operation contract. A provider may share a reference-owned watch only under its accepted connector contract; SharePoint shares one drive-root watch per tenant connection and drive as defined by [`sharepoint-entry-v1.md`](../../docs/contracts/sharepoint-entry-v1.md).

Future Google and other connectors will be added only after the connector SDK contract is implemented and approved.
