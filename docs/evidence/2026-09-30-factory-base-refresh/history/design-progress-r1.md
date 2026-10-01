# Issue 84 implementation plan — September 30, 2026

Source: main 878a1774774b0630c904cbaf4b05e1b346777817, isolated branch codex/issue84-base-refresh.

This is a design/progress record, not a validation or completion receipt. The earlier inventory, ownership record and issue 262 receipts remain authoritative for their respective revisions.

The refresh is a new, explicitly authorized verification-only mission linked to an immutable, already verified commit/branch source deliverable. The old completed mission and original commit are never revised. Admission fences the actor, Corp, current Factory claim/version/source revision, repository/ref, exact source deliverable, immutable old/new base, and complete saved verifier policy. No replacement checks or model/session work is accepted by this operation.

The runner uses native Git object transfer, bundle verification, merge-tree and private raw-blob materialization in a fresh owned repository/worktree. Reconstruction must reject conflicting or non-descendant bases and scope expansion. Existing canonical verification and signed artifact uploads remain responsible for completion. Historical provider evidence, where required by the saved policy, must retain its original identity and must never be represented as fresh inference.

Each refresh requires a fresh independent review. Only an explicit, idempotent adoption after passing persisted verification and review may change the Factory item's selected mission/base. Admission/adoption lock the item and reject any existing publication. While a refresh is active, new publication is fenced. Publication thereafter reuses the existing unique publication aggregate and exact verified commit; completed publication replay semantics remain unchanged.

The implementation must bound retries, prohibit generic provider dispatch/resume and contract weakening for refresh missions, retain failed workspaces and review decisions, and revalidate current authority before artifact transfer and adoption. State-audit coverage must be preserved for the new operation.

Native capability evidence obtained locally: Git 2.55.0.windows.5 exposes merge-tree --write-tree and --merge-base. Existing runner canonical verification already provides bounded Git child ownership, environment isolation, raw blob materialization and exact-tree export. No custom merge algorithm or provider permission/session mechanism is planned. Online Git documentation fetches returned no usable content and do not count as inspected evidence.

Hosted merge blocker remains: Actions disabled and required CI/CodeQL/quality/security unavailable. This does not authorize bypassing checks. No issue 84 validation, PR, approval, merge or closure is claimed by this record.
