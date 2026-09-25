# Adoption review

**DRAFT. Not reviewed by a lawyer.** These notes are not license conditions.

## Owner TODOs

- **Allowance:** choose monthly writes per human in `TERMS.md`; confirm one
  execution, regardless of batch size, is the intended unit.
- **Licensor:** fill the license's legal name and contact; verify ownership and
  contribution rights.
- **Contributions:** choose an agreement or a maintainer-only policy for commercial
  additions before accepting outside code under commercial terms.

## Adoption checklist

1. Separate MIT and commercial source; apply commercial headers only to eligible
   additions. Preserve earlier public MIT grants and third-party notices.
2. Obtain counsel review of the copyright license and acceptance flow. Operational
   terms can subsequently change through ordinary product review within the grant.
3. Implement the allowance, attribution, reconciliation, and outage rules. This
   drafting change implements no entitlement enforcement.
4. Resolve TODOs, adopt versions, remove draft stamps, and update announcements.
5. Run `pnpm validate` and `pnpm check:package`; inspect plugin distribution notices
   and attribution on independently distributed generated artifacts.
