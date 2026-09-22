# Check the portable source candidate

`git diff --check` does not inspect untracked files or staged-only differences.
For a portable source deliverable, use the dependency-free command instead:

```powershell
node tools/check_deliverable_diff.mjs `
  --repo 'C:\managed\worktrees\task with spaces' `
  --base '<assigned workspace.base_commit>' `
  --scratch-root 'C:\managed\verification-scratch' `
  --path 'src' `
  --path 'README.md' `
  --provider-artifact 'provider-result.md'
```

The scratch root must already exist **outside** the source worktree. It must be
owned by the caller and must not be shared with untrusted writers. The command
creates a uniquely named child directory there, removes only its index and lock,
and removes that child only when empty. Cleanup failures are errors; unexpected
files remain available for inspection. No OS temporary directory is used.

## Inputs and result

- `--repo` is the worktree root, not a subdirectory; default: current directory.
- `--base` is required. Supply the export's immutable assigned base commit, **not**
  an arbitrary current `HEAD`. Git resolves the value to a commit once and the
  result records its full object ID. No remote lookup occurs.
- Repeat `--path` for exactly the persisted `DeliverableSpec.paths`. Omit all
  `--path` options when export selects the entire worktree. These are **literal**
  portable repository-relative paths (forward slashes), not glob/pathspec syntax.
  Filesystem arguments (`--repo`, scratch root, provider artifacts) accept native
  Windows paths. Quote arguments containing spaces or shell metacharacters.
  Use `--path=-source.txt` for a value beginning with a dash.
- Repeat `--provider-artifact` for the same artifact paths passed to export.
  Relative artifact paths resolve from the worktree root; absolute paths work.
  Existing in-worktree artifacts are reset to the base in the disposable index.
  Outside-worktree and missing artifacts do not select or exclude source.
  Other filesystem errors fail closed. Do not substitute arbitrary source
  exclusions for the exporter-owned artifact list.
- On Windows, provide `--preserve-head` **only** when export receives that same
  verified head. This retains its executable bits and resets every unselected
  committed path to the base before staging. As in the exporter, non-Windows
  selection seeds from the base even when a preserved head is supplied.
- `--timeout-ms` bounds the entire sequence of Git commands (default 30000,
  maximum 120000). Each child receives the remaining deadline, has no interactive
  stdin and has bounded output (8 MiB). There may be at most 256 selected paths
  and 256 provider artifacts. Oversized or malformed inputs fail rather than
  silently selecting fewer files.

The command writes JSON containing `passed`, `baseCommit`, `candidateTree`,
`changes` (status and literal path), and Git's `diagnostics`. Exit codes:

| Exit | Meaning |
| --- | --- |
| 0 | Candidate passes Git's whitespace and conflict-marker checks |
| 1 | Candidate fails those checks |
| 2 | Input, Git, timeout, output-limit, decoding, or cleanup error |

Callers must require **exit 0**, not merely successful JSON parsing or presence of
an object ID. `candidateTree` identifies what was checked; it is not a commit,
signed artifact, accepted completion, or publication authorization.

### Error receipts

Exit 2 writes one JSON line to stderr, with no stdout: `error` is
`deliverable-diff-check`, `original` describes the check failure (or is `null`
when only cleanup failed), and `cleanup` contains each failed owned cleanup
operation (`unlink-index`, `unlink-lock`, `rmdir`) separately, in that order.
Cleanup failures also include `scratchDirectory`: only the internally generated
`ecorp-diff-check-<UUID>` child name, never the caller's scratch-root path. Use it
under the supplied root to correlate the owned attempt with retained contents.
The receipt is bounded below 4 KiB by fixed fields, allowlists and at most three
cleanup entries; it is not a dump of an `Error` or its recursive causes.

Native diagnostics contain `operation`, `category`, and allowlisted `code`,
integer `status`, and `signal` values; unavailable or unknown values are `null`.
Git operations name the subcommand, including `add`, never the `-c` option.
A small allowlist recognizes known English fatal Git diagnostics and emits only
fixed categories: `revision-unavailable` (check the supplied base/preserved head),
`missing-path` (check the literal selection), and `clean-filter-failed` (inspect
the authorized Git attributes/filter). Recognition uses linear-time fixed-string
checks of the final line, not backtracking over child-controlled text. No matched
text is included.
Unrecognized/localized diagnostics retain `revision-resolution-failed` or
`source-selection-failed` for those steps; check the local repository, revision,
literal selections, ignore rules and attributes/filters. These are diagnostic
hints, not authenticated claims from arbitrary filter output or new authority.

Other categories distinguish `timeout`, `output-limit`, `spawn-failed`, `signal`,
`git-exit`, `filesystem`, `invalid-input`, `invalid-output`, and `unknown-error`.
Check the deadline/output size, local Git installation, or owned scratch
permissions/contents as appropriate. Fixed authored validation messages remain
available as `message`; native error messages, paths, argv, environment, and raw
Git/provider/filter output are never copied into an error receipt. The `details`
field explicitly says `Untrusted error details suppressed`. This is suppression,
not universal regex redaction: unknown child stderr is suppressed, not sanitized
or fully preserved. Inspect retained scratch contents only through an
authorized local diagnostic path; cleanup errors never permit recursive removal.

The library still retains the underlying `cause` and aggregate member errors in
memory. Successful/whitespace-result JSON, including source paths and Git patch
diagnostics, is unchanged; the secret-safe error contract applies to exit 2.

## Selection parity, not another exporter

The helper mirrors `crates/crony-runner/src/deliverable.rs`:

1. Seed a new index with `read-tree` of the assigned base (or the native Windows
   preserved-head selection described above).
2. Run platform-matched `git -c core.filemode=… add -A -- <literal paths>`, with
   `GIT_INDEX_FILE` and `GIT_LITERAL_PATHSPECS=1`.
3. Reset existing in-worktree provider artifacts to the base.
4. Inspect the cached candidate against that same base with `git diff --check`.

Thus tracked changes, committed differences from the base, staged source still
present on disk, deletions, and non-ignored untracked source are checked. The
**physical worktree wins over staging**: bad bytes present only in the real index
are not exported if the physical file is clean, and clean staged bytes cannot
hide bad physical bytes. A staged-only addition removed from disk is not exported.
Even an unmerged real index is untouched; unresolved conflict markers in the
physical candidate fail, while a physical resolution is checked normally.

Git's ordinary ignore rules exclude untracked ignored evidence and ignored
runner-internal files. No new blanket ignore list is introduced: ignored files
already tracked by the **seeded revision** remain selected, and non-ignored files
are not silently dropped. A force-added ignored file tracked only in the real
index or a later commit is still absent when the base-seeded exporter ignores it.
Provider artifacts are a separate explicit reset, including tracked artifacts. Export's
existing write-scope, secret/internal-path, link/reparse-point, size, verification
and authorization checks remain mandatory; this helper is **only** a patch check,
not a replacement for those safety checks. An internal path rejected by export
does not become exportable because its whitespace is clean.

Git attributes, clean filters, whitespace configuration, binary detection and
line-ending conversion apply just as when building the export index. The helper
does not rewrite CRLF bytes. It writes ordinary local Git objects while staging
and recording the candidate tree, but does **not** alter the real index, source
files, HEAD, branches, refs, or repository configuration. It is not a sandbox for
hostile Git configuration or filters and must run only in an already authorized
workspace. Concurrent edits are not frozen; existing runner lifecycle/verification
boundaries remain responsible for binding evidence to the eventual export.

## Regression evidence and integration

Run the focused, real-Git regression suite without a server, database or provider:

```powershell
node --test --test-concurrency=1 tools/check_deliverable_diff.test.mjs
```

The suite reproduces the old false pass, then checks red and green untracked
source with the CLI; compares complete candidate-tree IDs with an independent
replay of the native export recipe; covers ignored/provider paths, literal
selection, staging conflicts, CRLF, Windows preserved-head behavior and errors;
and checks source-file and real-index hashes plus unchanged HEAD/refs.
CLI failure regressions distinguish real missing revisions/selections from an
owned Node clean filter rejected by native Git (including both `add`/128 cases).
Hostile repeated delimiters, including near-8-MiB stderr, must still produce
exit 2, a safe receipt and owned scratch cleanup before a five-second watchdog.
They also exercise native
timeout/output-limit/spawn errors through a narrowly replaced child call, and
separate original/cleanup failures. Synthetic sensitive markers, control
characters and oversized unknown text must not reach error receipts.
Set `ECORP_DIFF_TEST_ROOT` to an explicitly owned external evidence directory to
retain all fixtures, CLI output and before/after preservation snapshots instead
of removing fixtures after the run.
A source-recipe hash intentionally fails when the native selection implementation
changes, requiring an explicit parity review rather than an unnoticed stale copy.
This is selection/command evidence, not a live runner or browser acceptance claim.

For a persisted command verifier, use the existing command mechanism with these
exact export inputs and require exit 0. This change does not automatically rewrite
existing persisted verifier policies or infer their base/artifact list. Do not
claim this command was run for a mission that still used only `git diff --check`.
The top-level `*.test.mjs` suite is discoverable by the repository-wide test gate
being added in issue #317; this issue does not edit its package, workflow, or
marked documentation contracts.
