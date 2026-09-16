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
