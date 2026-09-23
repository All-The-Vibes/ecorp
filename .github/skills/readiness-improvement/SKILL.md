---
name: readiness-improvement
description: Improve repository readiness through evidence-backed local validation and the installed CodeBlend evaluator, without claiming hosted authority.
---

# Readiness improvement

Use an isolated contribution worktree and read the root AGENTS.md contracts first.
Do not duplicate the shared review workflow proposed in PR #304. This skill only
defines the readiness measurement/change loop; it grants no tools or permissions.

1. Resolve the current worktree, HEAD and dirty state. Synchronize the approved branch
   before a batch, never during a benchmark. Preserve all unrelated work.
2. Use the separately installed `codeblend-ai-composite` skill and its native executable.
   Evaluate the local path, not the remote URL. Record the evaluator digest, platform,
   CLI compatibility, models, evidence window and source identity. Never edit scores.
3. Read actual findings, distinguish unsupported detection from missing engineering,
   and propose one bounded change with an acceptance test. Keep native Node/Cargo test
   semantics; never rename or add dummy tests to improve a filename heuristic.
4. Preview `pnpm check:preview`, implement the approved local scope, then run focused
   regressions and `pnpm check`. Review machine-readable `output/readiness/` receipts.
   Failed, cancelled, ignored and unexecuted tests remain separate from passes.
5. Re-run the same evaluator settings after a meaningful validated batch. Record every
   attempted result, including regressions and errors, in `docs/AI_READINESS.md`.

Bound each invocation to at most **three meaningful change/measurement cycles**.
Stop earlier after two cycles without evidence-backed progress, on cancellation,
ambiguous ownership, a safety failure, or a required external permission. Summarize
remaining work for an explicitly authorized continuation; do not loop on random judge variance.
The user's larger objective is not proof that a mathematical maximum has been reached.

Never enable live credentials, widen permissions, change branch rules, publish, merge,
or deploy as a score optimization. Document these dependencies for the responsible owner.
Installing a workflow is not evidence it ran, and local results do not establish
production identity, real-provider reliability or recurring hosted operation.

Use the existing deterministic docs tool for its exact generated contract only:
`pnpm check:docs:preview`, review, `pnpm check:docs:write`, `pnpm check:docs`.
It does not repair arbitrary prose or make repository-wide semantic drift claims.
