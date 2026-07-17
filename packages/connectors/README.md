# Connector Packages

These directories reserve provider boundaries only. They contain no connector behavior yet.

Initial connector targets:

- Direct upload
- Generic webhook
- Microsoft SharePoint
- Microsoft Business Central
- Dynamics NAV

Business Central and Dynamics NAV remain separate adapters because their API, authentication, version, customization, and reconciliation contracts differ. They share only the provider-neutral destination port and connector test suite.

Future Google and other connectors will be added only after the connector SDK contract is implemented and approved.
