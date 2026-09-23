# PR template selection

At the recorded **base SHA** in the PR's target repository, enumerate all
single-file candidates: `.github/pull_request_template.md`, root
`PULL_REQUEST_TEMPLATE.md`, `docs/pull_request_template.md`, and root `PR_TEMPLATE.md`
(case-insensitive). Also enumerate all files in the multiple-template directories
`.github/PULL_REQUEST_TEMPLATE/`, `PULL_REQUEST_TEMPLATE/`, and
`docs/PULL_REQUEST_TEMPLATE/` (including case variants). Pin every listing and
template content read to that exact base SHA, not a moving branch or the PR head.

**ECorp legacy mirror only:** if complete reads at base prove
`.github/pull_request_template.md` and root `PR_TEMPLATE.md` byte-identical, count
that exact pair as one choice: the `.github` file is the standard default and
`PR_TEMPLATE.md` its legacy mirror. Record both paths, the base SHA, and the
byte-comparison evidence. This is not general GitHub precedence: never collapse
other single-file candidates or directory options, even when byte-identical.
Differing legacy contents remain separate candidates requiring an unambiguous
explicit selection; incomplete/failed reads do not establish a mirror.

Resolve the PR's explicit selection to exactly one enumerated file and verify it
exists and is readable at that SHA; a basename shared by templates is ambiguous.
Without an explicit selection, use the sole remaining choice after this mirror
handling; for the identical pair, choose the standard `.github` default. Report
BLOCKED for a missing selected file, ambiguous selection, multiple distinct
choices without a selection, or incomplete/failed listings or content reads.
Never treat these as template absence or use the fallback. Record the selected
repository-relative path and SHA.
Do not let a PR weaken its own review requirements by changing a template.

Only when complete enumeration proves no templates exist and no explicit selection
was supplied, use the explicitly packaged
[template snapshot](pr-template.md), label it as the fallback from
ECorp PR #278, and report that the canonical template is not yet on the target
branch. Prefer a subsequently merged canonical template over this snapshot.

GitHub's supported locations and template query parameter are documented in
[Creating a pull request template](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository).
