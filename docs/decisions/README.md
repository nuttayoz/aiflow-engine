# Architecture Decision Records

Architecture Decision Records (ADRs) preserve important choices, their context, and their trade-offs. They prevent the team from repeatedly reopening settled decisions without new evidence.

## Process

1. Copy `0000-template.md` to the next four-digit number and a short kebab-case title.
2. Set the status to `Proposed` and open it with or before the implementation PR.
3. Record real alternatives, operational consequences, security/data impact, and migration/reversal approach.
4. Obtain approval from the relevant CODEOWNER.
5. Change the status to `Accepted` when the decision is approved. Do not rewrite the reasoning later.
6. To change an accepted decision, add a new ADR with status `Accepted` and mark the old one `Superseded by ADR-NNNN`.

Valid statuses are `Proposed`, `Accepted`, `Rejected`, `Deprecated`, and `Superseded by ADR-NNNN`.

An ADR records a decision; contracts define exact external behavior, and runbooks define operations. Link them rather than duplicating them.

## Accepted records

- [ADR-0001: Use Current Stable Compatible Versions](0001-current-stable-versions.md)
