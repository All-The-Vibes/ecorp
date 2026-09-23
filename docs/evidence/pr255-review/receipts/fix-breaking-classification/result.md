# PR255-BREAKING-CLASSIFICATION (A-003 / PR255-B-003)

Prepared the bounded prose correction; parent verification/publication remains pending.

- Modified only `docs/FACTORY_CLAIM_AUTHORITY.md` in the checkout: breaking production admission, old-server incompatibility, coordinated server/client/controller/config rollout, independently approved pins and unchanged legacy semantics.
- `pr-body-candidate.md` starts from the exact decoded `body` in the supplied `current-pr.json`. Only the classification line and one rollout bullet differ. Historical source/test/approval identities and counts, partial/non-closing scope and no-merge boundaries remain verbatim. Parent will prepend the distinct current-correction status.
- `document.diff` and `pr-body.diff` contain the exact text diffs. `before-hashes.json` and `evidence.json` retain before/after SHA-256 values, source references and checks. The original input JSON is unchanged.

## Applicability and checks

Behavioral RED/GREEN is not applicable to this prose-only correction; no fake behavioral RED or production regression run is claimed. Before: the body explicitly classified mandatory production pin admission as non-breaking. After: it explicitly classifies the admission/API break and documents the required rollout. Source inspection confirms missing production pins are rejected before controller persistence/new-claim insertion, while the CLI requires the authority endpoint.

Exact reversal of the two body edits reproduces the source body; removal of the inserted documentation prose reproduces the original document. All seven inspected server/store/CLI/domain enforcement file hashes are unchanged. The scoped document whitespace check passed. No new examples or commands were added; existing CLI examples were not executed.

No production/test/other-document edits, commits, GitHub/state writes, agents or service actions. Other workers' UI/QA and server-test work was not touched. No merge, deployment, production or multi-host acceptance; stop here for the parent's verification/publication.
