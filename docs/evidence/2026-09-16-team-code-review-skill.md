# Team code-review skill validation — September 16, 2026

## Scope

Contributor workflow only: `.github/skills/code-review`, Copilot instructions,
and a package-integrity step in the existing CI job. No ECorp application,
Factory, provider SDK, database, or manual office behavior changed. Work used
an isolated worktree based on `b2523964e7576cafc00e84a51e1044f55826dea7`;
the original dirty checkout was preserved.

The requested security, Ponytail, and Santa instructions are bundled with
immutable source URLs, byte hashes, notices, and explicit host adapters.
No global plugins or scanner packages were installed. See the
[dependency contract](../../.github/skills/code-review/references/dependencies.md).

## Open-PR inventory and template

The live inventory initially contained 13 open PRs: #294, #293, #290, #288,
#283, #278, #275, #273, #265, #255, #251, #237 and #226.
Drafts were #294/#293/#273; #293 targets `feature/281-state-audit-v1`, not main.
#288 and #275 had no check results. This is an inventory, **not a completed
three-audit review or remediation of those PRs**.

PR #278 changed during implementation: its initial `65d26bb...` head had a
failed Windows check; the later `fb938d9ca6fc62232c3c5d85cc05280495344e16`
head added screenshot-evidence requirements and was being checked anew.
Old check results were not reused for the new head.

Main had no canonical PR template. The packaged fallback comes from
[`PR_TEMPLATE.md` at that exact newer commit](https://github.com/All-The-Vibes/ecorp/blob/fb938d9ca6fc62232c3c5d85cc05280495344e16/PR_TEMPLATE.md).
It is explicitly a fallback, not an assertion that #278 has merged. Reviews
must prefer a subsequently merged template at their actual target/base SHA,
including requirements added beyond the starter rubric.

## Local validation

| Check | Observed result |
| --- | --- |
| `node tools/check_migrations.mjs` | PASS |
| `cargo fmt --check` | PASS |
| `cargo clippy --workspace --all-targets -- -D warnings` | PASS |
| `cargo test --workspace` | 547 passed, 323 ignored, 0 failed |
| `pnpm build:web` | PASS through the retained approved registry descriptor |
| `pnpm lint:web` | PASS through the same descriptor |
| `node --test .github/skills/code-review/tests/package.test.mjs` | 2 passed |
| Corrupted upstream resource and missing dependency probes | Both rejected, expected nonzero exits |
| Duplicate manifest entry regression | Accepted before guard (reproduced gap); rejected after guard; legitimate package stayed green |
| `git diff --check` | PASS |

The initial pnpm commands failed with public-registry TLS/supply-chain metadata
errors even with offline install requested. Those failures were retained.
The existing approved proxy descriptor was copied into this worktree's ignored
setup directory; frozen-lockfile installation/build/lint then passed with the
committed lockfile unchanged. No TLS, integrity, or supply-chain check was disabled.
The optional bundled Python skill validator could not import PyYAML; it was not
reported as a pass. The Node check verifies this package's simple frontmatter
and all maintained internal links.

No application browser/server/runner E2E was needed for this instruction-only
change. Ignored database tests are not passes. Screenshot evidence required by
the proposed fallback template is not supplied by terminal logs or this report;
that is a remaining PR-template evidence gate, not grounds to fabricate images.

## Behavioral review

An independent read-only forward test applied the skill to three synthetic
cases: malicious PR-body instructions with unavailable subagents; a weakened
head template and stale checks/reviews; and two Santa PASS receipts without
the required human approval. All three refused merge-readiness while preserving
the separate Santa verdict where applicable. No synthetic input was posted on
GitHub or represented as a real reviewer receipt.

It exposed two wording ambiguities: overall BLOCKED/NAUGHTY precedence and
ordinary reviewer disagreement versus internally inconsistent receipts.
Independent Santa reviewer A also rejected a forward-test case that expected
fixer writes despite the test harness's read-only restriction. Issue-scoped
workers corrected these documentation findings; executable TDD is inapplicable
to those prose corrections, so their evidence is before/after behavioral review.
The duplicate-manifest validator gap has a runnable red/green regression.

The first independent Copilot CLI Santa reviewer returned PASS on the package,
with explicit runtime model `gpt-6-astra`. That did not override reviewer A's
FAIL, and it is not a claim that the corrected package has already completed
another dual review or a live automatic trigger.

## Copilot capability and configuration

Official GitHub documentation was fetched on September 16, 2026:

- [Skills in code review](https://docs.github.com/en/copilot/concepts/agents/code-review#agent-skills):
  repository skills are supported and loaded from the PR **head branch**.
- [Review model usage](https://docs.github.com/en/copilot/concepts/agents/code-review#model-usage):
  automatic Copilot review uses GitHub's model mix; model switching is unsupported.
- [Supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models):
  supported Copilot clients expose GPT-6 Astra separately from automatic review.

A tool-restricted Copilot CLI 1.0.83-5 probe selected `gpt-6-astra`, returned
`READY`, and exited 0 without file changes. A separate read-only package review
also ran with that model. Neither proves that automatic Copilot review uses
Astra, nor that the whole interactive fix/subagent workflow is accepted.

Native repository settings were updated and read back:

- Ruleset **23348877** retains its default-branch scope, deletion and force-push
  protections; only `review_on_push` changed to true. Draft reviews remain true.
- New ruleset **23567459** contains **only** automatic Copilot review, targeting
  all branches except the default branch, with drafts and new pushes enabled.
- The other existing rulesets, approval requirements, security gates, bypass
  actors, paid-usage settings, and merge policy were not weakened or changed.

The package must be present in an existing PR's head to be used there. A merge
to main alone cannot retrofit every old branch. Availability also depends on
GitHub entitlement, policy, quota, runner capacity, and supplied tools.

**Live acceptance pending at this checkpoint:** a bot-authored review using this
skill on the new PR, then a second automatic review on a later pushed SHA.
Independent-subagent remediation and forced Astra selection inside automatic
review are not established; the latter is unsupported by the product.

## Native draft/non-default-target canary — 22:29 UTC

After the local corrections, two fresh independent reviewers returned PASS for
tree `48e626d747884da6b2a681df2de6e388b15cb21c`. The committed tree is identical
at `d66d8079440080e3451e2981aff187c532e980f2`. This was a same-model Santa
adaptation: a native subagent and a separate Copilot CLI Astra session, not
cross-model diversity or human merge approval.

[PR #304](https://github.com/All-The-Vibes/ecorp/pull/304) was opened as a draft
against a task-owned non-default branch at the exact main commit. No manual
review request was made.
[Copilot run 35157451279](https://github.com/All-The-Vibes/ecorp/actions/runs/35157451279)
completed successfully and produced
[review 5229000192](https://github.com/All-The-Vibes/ecorp/pull/304#pullrequestreview-5229000192)
at **2026-09-16T22:29:08Z**, for the exact `d66d807...` head.

The bot's summary contained `ECorp code-review`, the correct base/head, rubric
gates, and 21/21 changed files reviewed. This confirms automatic triggering and
skill use for that draft/non-default-target case. It does **not** establish that
every upstream audit or independent Santa reviewers ran inside the hosted bot.
Its state was `COMMENTED`, not an authorized human/team approval.

It found three actionable gaps:

| Finding | Required correction |
| --- | --- |
| [Head-controlled review policy](https://github.com/All-The-Vibes/ecorp/pull/304#discussion_r4031361921) | Require independent owner/base-policy review for reviewer-policy changes; explicitly state instructions are advisory rather than tamper-proof enforcement |
| [Incomplete template discovery](https://github.com/All-The-Vibes/ecorp/pull/304#discussion_r4031361949) | Enumerate all supported multiple-template directories at the base SHA; never mistake ambiguous selection for absence |
| [Unmanifested vendor files](https://github.com/All-The-Vibes/ecorp/pull/304#discussion_r4031361983) | Compare the complete vendor file set with manifest entries, excluding only the exact local control files |

These corrections are split among separate workers, with a reproduced
unmanifested-file regression for the executable check and before/after semantic
checks for prose. The follow-up also makes Astra mandatory for Copilot fix mode
unless an operator explicitly chooses a different model; a mismatched session
must stop instead of claiming that instructions changed the model.

The PR was then retargeted to main, retaining draft state and `auto_merge: null`.
The unchanged task-owned canary base was removed only after checking its exact
commit and that no open PR still targeted it. Existing protected human review
requirements remain effective.

The next-push review must be observed separately at its actual new SHA. Its final
receipt belongs in the PR/validation report, not retroactively in a commit that
would change that same SHA. Missing screenshots, independent owner approval,
full fix-mode execution, and unsupported automatic-model selection are not
converted into acceptance by this canary.
