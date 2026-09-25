# Write access terms

Version 1.0-draft.3. **DRAFT. Not reviewed by a lawyer. Not yet effective.**

The "Allowance and counting" section is incorporated into this release's copyright
license and is fixed for the release. The remaining sections are operational
product terms: routine updates do not need the license's counsel-review process.
Publish versioned changes with notice before they take effect; they cannot expand
the license's limit on Writes or reduce an existing release's allowance. Record the
accepted version when required for subscription changes.

## Allowance and counting

The free allowance is 100 writes per human per month. Reset is at the start of
each calendar month in UTC, without rollover. Free use includes ordinary
commercial work and needs no Framelink account. Usage is tracked against the
Figma user id and shared across that human's devices and identities.

One logical execution that actually changes a document counts once, regardless
of nodes changed. Partial changes count; failures before changes, screenshots,
and read-only executions do not. Transport retries with the same execution
identity count once. A new execution counts separately. Undo does not refund a
write. These rules apply to development and test writes too.

Free counts may be kept locally and reported in batches. Reinstalling, switching
identities, or batching cannot increase the allowance. Reconcile accurate counts
when connected. A write authorized using truthful information and approved
accounting is not retroactively unauthorized because of a reconciliation error;
correct the count before further writes exceeding the allowance.

## Seats and automation

A seat costs $29 per named human per month and permits unlimited writes, without
paid usage counters, quotas, or per-write fees. Account creation and Figma identity
linking happen on upgrade. Billing and cancellation details appear at checkout.

A human can use multiple devices and agents. Writes are attributed to the Approver,
the human who approves the session in the plugin. Each CI job or automated workflow
needs an Approver who owns it; someone independently requesting writes needs their
own authorization. Merely receiving or collaborating on outputs needs no seat.
Routing a team's requests through one shared bot does not authorize the team.

Organizations can assign seats to employees or contractors. Reassign for genuine
user changes, not rotation among active users to avoid seats. Disclose additional
reassignment rules at purchase if introduced.

## Connectivity and hosting

Check authorization at session approval; cache paid entitlements and revalidate
when connected. Paid users need not report write counts. Cache expiry or a failed
request alone does not revoke a last-validated seat. Revalidate after an outage;
known cancellation, revocation, or reassignment ends paid permission. Deliberately
blocking validation to conceal that change is not outage grace.

Generic infrastructure and agent providers may execute a user's authorized copy
on their behalf. A hosted or managed service providing write functionality to
third parties requires Framelink's written permission under the license. Our hosted relay and MCP endpoint have their own
availability and access terms; a local free allowance does not include paid
hosted access or guarantee a remote service stays available during an outage.
