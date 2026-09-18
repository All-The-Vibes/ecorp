# Dependencies and host bindings

This package includes the original instructions and licenses. Cloning the
repository is sufficient to obtain the skill dependencies; **no personal Codex
plugin, global installer, MCP server, or paid scanner package is required**.
The originals are reference resources, not separately registered slash commands.
The code-review skill loads them by the paths below. Invocation syntax varies
by host; reading and applying the named resource is the portable operation.
Upstream instruction files use `.md` resource names, not nested `SKILL.md` files,
to avoid unintended skill discovery; their bytes are unchanged.

## Bundled sources

| Requested phase | Pinned source and included dependency |
| --- | --- |
| `/atv-security` | ATV-StarterKit 2.6.3, commit `ad996736b879be87c7755df5c5017d5336203bbc`: [skill](../upstream/atv-security.md), [MIT license](../upstream/atv-security/LICENSE), [AgentShield taxonomy notice](../upstream/atv-security/AGENTSHIELD-LICENSE) |
| `/ponytail-audit` | Ponytail 4.10.0 source commit `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`: [audit](../upstream/ponytail-audit.md), required [ponytail-review](../upstream/ponytail-review.md), [MIT license](../upstream/ponytail-audit/LICENSE) |
| `/santa-loop` | ECC 2.2.1, commit `8321021c54d670126ce3b2969d5deb880b4b0c2a`: [command](../upstream/santa-loop.md), required [santa-method skill](../upstream/santa-method.md), [code-reviewer reference](../upstream/code-reviewer.md), [MIT license](../upstream/santa-method/LICENSE) |

Santa Loop is an upstream **command**, not an upstream skill named santa-loop.
Its Santa Method origin credit is retained. Its optional integration suggestions
(`verification-loop`, `eval-harness`, `continuous-learning-v2`,
`strategic-compact`) are not invoked here. ECorp's existing checks and the
code-review ledger perform those tasks; those plugins are not dependencies.
Ponytail's hooks and active global mode are likewise unnecessary.

[manifest.json](../upstream/manifest.json) records immutable download URLs and
SHA-256 for every upstream file. Do not edit vendor files or auto-upgrade them.
For an update, inspect the new pinned source/license and rerun package and
behavioral checks in a PR. The AgentShield notice is pinned independently;
ATV's source does not identify the original taxonomy's historical commit.

## ECorp adapters (intentional differences from upstream)

Subject to the reviewer-policy trust boundary below, the containing skill's
mode, authorization, rubric, and evidence rules govern all phases. The following
bindings make the original workflows usable here:

- Map upstream `file_search`, `list_dir`, `grep_search`, `read_file`, and `Agent`
  to the host's equivalent read/search/native subagent capabilities. Missing
  capabilities are BLOCKED, not calls to imaginary tools.
- ATV: use `mode=report scope=full`. Include Rust `Cargo.toml`, `Cargo.lock`,
  `crates/**/*.rs`, SQL migrations, and `apps/web` explicitly; upstream's stack
  examples do not enumerate Rust. Interpret static matches in context, including
  test fixtures and the audit's own example patterns. Redact matched secrets.
  In review mode, omit upstream Phase 8 filesystem persistence and Phase 9
  auto-fix: return the report in the review. In fix mode retain evidence only in
  the owned worktree; application fixes follow the outer TDD process.
- Ponytail: load both bundled skills. Preserve its whole-repository scope but
  distinguish base debt from introduced/worsened findings. Its "Ship" wording is
  a complexity opinion, not an actual push, approval, or merge instruction.
- Santa: use the upstream objective rubric, **two fresh independent reviewers**
  with identical inputs, structured criterion results, and the AND verdict gate.
  Neither reviewer receives the generator's reasoning or the other's findings.
  With two valid receipts, both PASS means the *Santa audit* is NICE; either FAIL
  means NAUGHTY, including a valid PASS/FAIL disagreement between reviewers.
  Receipt validation is BLOCKED only for malformed, partial (including a missing
  reviewer receipt), stale, or internally inconsistent receipts, not disagreement
  between valid verdicts. Do not simulate two reviewers in one context or sample
  PRs instead of reviewing each one.
- Replace upstream hard-coded `opus`, `gpt-5.4`, `gemini-2.5-pro`, and the
  reference agent's `sonnet` metadata with the **explicitly selected and
  runtime-confirmed model(s)**. Copilot fix mode requires `gpt-6-astra` for the
  remediation session and its reviewers unless the operator explicitly selects
  another model. If a different model is running, stop before remediation and
  request a correctly selected session; instructions cannot switch the host's
  model by assertion. Two independent Astra sessions are
  an explicitly labeled **same-model ECorp Santa adaptation**, not proof of
  cross-model diversity. Use another model only when the operator selects it.
- Upstream commit/push/ship steps are not implicit authorization. Review mode
  never performs them. Fix mode follows the outer skill's TDD, bounds, current
  head rechecks, and authorized branch-update rules. An upstream approval
  opinion never substitutes for a required GitHub human/team approval.

## Runtime requirements

| Capability | Required for |
| --- | --- |
| Repository contents and native GitHub reads (or authenticated `gh` CLI) | PR status, complete diff, checks, review threads, branch rules and evidence |
| Git | Exact base/head comparison; isolated native worktrees for fixes |
| Native independent subagents, read-only reviewer tools | Two Santa reviewers; one fixer per issue in fix mode |
| Node.js 22+, repository-pinned pnpm 11.19.0, Rust with rustfmt/Clippy | Existing ECorp validation and the package test |
| Repository dependencies from the lockfiles and approved registry | Web build/lint and any affected runtime checks |
| Explicitly owned PostgreSQL/browser/server/runner test environment | Only the applicable integration/E2E lanes from `docs/EVALS.md` |
| Copilot entitlement, organization policy, available quota and Actions capacity | GitHub-hosted automatic review; missing access is not a clean result |
| Branch write permission and explicit remediation scope | Fix-mode publication only, not read-only review |

Do not put PATs/API keys in skill files, prompts, command arguments, or evidence.
Use the host's existing authentication/credential store. Do not request broader
permissions, enable paid usage, install packages, or change branch protection
merely to make a test green. Standard reviewer access does not grant write access.
The ECorp application's pinned Copilot SDK/CLI pair is **not changed** by this
contributor workflow.

## Copilot and GPT-6 Astra

Verified against official documentation on **September 18, 2026**:

- [Agent skills for code review](https://docs.github.com/en/copilot/concepts/agents/code-review#agent-skills):
  automatic review supports repository skills and reads instructions/skills from
  the **PR head branch**. Existing PRs need the package in their head branch;
  merging it to main alone does not retrofit old branches.
- [Model usage](https://docs.github.com/en/copilot/concepts/agents/code-review#model-usage):
  the automatic reviewer uses GitHub's model mix and **does not support model
  switching**. Neither skill metadata nor repository settings can force Astra.
- [Supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models):
  GPT-6 Astra is available on supported Copilot clients, subject to account policy.
  This is distinct from selecting the automatic reviewer's model.

For an explicitly requested interactive remediation session:

```sh
copilot --no-auto-update --model gpt-6-astra
```

Then ask: `Use .github/skills/code-review/SKILL.md in fix mode for PR <number>.
Use GPT-6 Astra and two independent reviewers; keep the default bounds.`
Verify the model actually selected at runtime and retain its receipt. If the
account/runtime rejects it, stop with MODEL_UNAVAILABLE; do not fall back silently.
No `--allow-all-tools`, credential bypass, or unbounded autopilot is needed.
Copilot CLI 1.0.83-5 accepted this model in the implementation availability probe;
that probe alone does not prove the entire fix/subagent workflow.

For ongoing authorized remediation, use the separate native Codex
[persistent executor](executor.md). Its scheduler, worktrees, durable bounded
state and native Astra agents complete the fix-and-re-review loop; it does not
change GitHub's automatic-review model.

Automatic Copilot review can perform available audit analysis, but a skill does
not give it branch-write or independent-subagent capabilities it lacks. Such
steps must report BLOCKED and hand off to an authorized agent session. Do not
describe automatic review as a guaranteed unattended fix-until-NICE service.

## Reviewer-policy trust boundary

PR-head loading lets a PR change the reviewer's own policy. These instructions
and skills are advisory, not tamper-proof enforcement.

Treat additions, edits, deletions, and renames of reviewer-policy paths as
**BLOCKED** before relying on the bot result. This includes Copilot instructions
(`.github/copilot-instructions.md`, `.github/instructions/**`), any `AGENTS.md`,
review skills and all loaded resources (including `.github/skills/code-review/**`
and the PR-template rubric), and review CI workflows/actions/scripts (including
`.github/workflows/ci.yml` and its invoked checks).

Unblocking requires either an out-of-band review using policy from an
independently trusted, recorded base SHA, or required independent human owner
review of the policy diff for the exact base/head SHAs. A stacked target is not
automatically a trusted policy source; if trust cannot be established, remain
BLOCKED. Record the policy source and external review evidence; re-evaluate after
head or base changes. Neither route waives existing required human/team
approvals. The PR author, its bot verdict, and its modified policy cannot
self-approve these changes.

External protected reviews/CI outside the PR author's control are required to
enforce this boundary: an in-PR instruction or integrity check can itself be
removed or weakened. The `ECorp code-review` marker, NICE text, and green package
tests do not prove policy integrity or enforce a merge gate.

For example, a PR may keep the template/marker intact but edit the skill to skip
security review and remove its package check from CI. Reliance on its bot result
is BLOCKED pending the external review above, even if that bot reports NICE.
Deleting this warning cannot remove the need for externally protected gates.

## Automatic review setup and acceptance

Use GitHub's native [automatic-review rulesets](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review)
for the built-in reviewer, not a privileged Actions workflow. The separately
authorized executor polls for actionable work; it does not replace these rules:

1. Enable automatic Copilot review for **all target branches**, drafts, and new
   pushes. Preserve existing approval, security, update, and branch protections.
   If an existing ruleset also protects branch deletion or force pushes, do not
   broaden those unrelated rules just to cover additional review targets.
2. Leave custom instructions enabled in repository Copilot code-review settings.
   Ensure the package is present on the exact head to be tested.
3. Open a PR, wait for a real `copilot-pull-request-reviewer[bot]` review, and
   verify the reviewed commit and actual package use. Retain the requested
   `ECorp code-review` marker/template report when emitted. If the host's summary
   format omits that advisory label, its exact-run skill-invocation trace for
   `.github/skills/code-review/SKILL.md` is direct evidence that the package was
   loaded; record the absent label rather than inventing it. Neither a marker nor
   an invocation proves every upstream phase ran: inspect the actual report and
   disclose unavailable steps. A requested reviewer or CI job alone is not
   evidence of a completed automatic review.
4. Push an authorized small correction and confirm a **new review for the new
   SHA** without manually requesting it. Repeat with a non-default target/draft
   where permitted. Fork/entitlement restrictions need explicit evidence.

Run the bundled integrity test with:

```sh
node --test .github/skills/code-review/tests/*.test.mjs
```

This checks packaging, not semantic execution. Use
[behavioral cases](../tests/cases.md) for independent skill forward-testing.
Record actual successes and limitations; do not generalize a canary into proof
that every PR, provider account, or remediation loop has completed.
