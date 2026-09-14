# Agent DX open questions

Questions left open after discussion. Keep source reports and reproduction details in the [triage index](AGENT-DX-TRIAGE.md); record decisions here as they are settled.

## Extending existing variant sets

**Status:** Needs a focused recommendation before implementation. Related triage items: **25** (extension) and **9** (clone bindings).

**Direction discussed:** Creating a set and adding components to an existing set fit naturally within `flcm.variants`.

**Established:** The variants function currently creates a new set from standalone components. Generic cloning provides a route to duplicate an existing member into its set; direct insertion of a built frame into a set is blocked. Existing probes show variant clones can lose text and visibility bindings, so the clone route alone does not establish preservation.

**Questions to settle:**

1. How should callers specify an existing destination set and the new members’ axis values?
2. Which validation is needed for axes, duplicate combinations, and component-property definitions?
3. What does native cloning or adding a standalone component preserve, and what must our implementation preserve explicitly for bindings and existing instance overrides?

**Next evidence:** Inspect the existing clone and component-combination paths, then use focused live controls for both adding a standalone component and duplicating an existing variant. Check set/member identity, bindings, variant values, and existing instance overrides before and after. Use the findings to recommend one coherent extension API.

## Settled: property binding and deletion (triage10)

User confirmed the observed behavior is expected: binding applies the component property's default; deleting the property leaves the current text as ordinary text. No product or documentation change requested for this item.

## Watch: exposing every text layer as a component property

User observed overly broad text-property exposure in the original sessions. No explicit blanket recommendation was found in the documentation inspected; the cause of the agent's choice is unconfirmed. If this recurs, document indiscriminate exposure as an anti-pattern. Direct text overrides are a valid workflow; expose named properties selectively when they improve component usability. No documentation change requested yet.

## Settled: mixed-style text binding (triage11)

User accepts flattening rich text when binding a plain-text component property and requested skipping further investigation or a fix. This is an accepted product behavior decision; native attribution has not been independently verified.

## Watch: text sizing defaults (triage16)

User accepts the existing fill-sizing and bulk-edit workflow; no additional example is needed. Subsequent decision: a contextual default is approved for newly authored text with omitted width in a width-bounded auto-layout column; use fill width and content-driven height when omitted. Other contexts retain their defaults. Before proposing a default change, establish whether problematic sizes were explicitly requested, inherited/copied, or supplied by constructor defaults, and assess effects on short labels and other layouts.

## Compact hierarchy inspection (triage31)

**Status:** Deferred product design. Original oversized result came from a custom raw recursive script, not flcm.get. Archaeology evidence: /tmp/figma-large-read-review.md. Narrower roots/depth/fields worked.

Consider a reusable compact structural summary. Settle useful fields, depth/node/output limits and explicit incomplete-coverage reporting, plugin and REST surface consistency, and relationship to existing search/slim handles. User deferred design and implementation. The proposed confirmation gate for oversized results is not being pursued.

## Slot node readability after placement (triage1–3)

**Status:** Open; deeper investigation requested. User wants a reliable intended workflow and has not accepted the preliminary avoid-read, clone-replacement, or rejection/rollback candidates as the solution. After plain-frame/nested-instance/direct-instance controls, investigate alternative access and placement mechanisms, fresh resolution, identity transitions and asynchronous behavior with evidence. Preserve identity, content and geometry where possible. Treat constructed variant slot content separately from donor moves. Recommend a solution only after reproductions and independent readback establish its reliability.
