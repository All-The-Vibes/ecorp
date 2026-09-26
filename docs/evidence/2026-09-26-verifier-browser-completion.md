# Installed verifier browser: September 26 completion evidence

Issue #136's implementation is already on main through PR #325, merged as
`d61aaa22c1ebe522613a2d5edb5b38d8bb517eaa`. This record describes new regression
and acceptance runs against main `08ed24829e033a39a8913d52be6a136eac1cc2aa`, tree
`f6215c05f1e6d3820065be5114a993dbbb0ea85f`. It does not change the original
development chronology or #117's frozen acceptance lineage.

## Remaining documentation defect

The persisted command example in [the browser guide](../VERIFIER_BROWSER.md)
used `timeout_ms: 120000`. The current policy editor and both server admission
paths accept only 100 through 60,000 milliseconds. The first stack attempt
copied that example and could not save the policy. Its failed receipt is retained.

The corrected example uses 60,000 milliseconds and states the existing bounds.
Parsing the original JSON and calling the actual `verificationPolicyErrors`
function reproduced the rejection. The corrected JSON returned no errors;
100 and 60,000 were accepted, while 99 and 60,001 were rejected. This is a
documentation correction, with no timeout-policy or runtime change.

## Observed validation

- Focused browser resolver, retained verifier and stack-start tests: 98 total,
  96 passed, zero failures, two Unix FIFO cases skipped on Windows.
- Native Windows startup handoff: 16 passed, zero failures, covering ordinary,
  spaced and bracketed paths, valid/invalid/empty/absent policies, readiness and
  process-identity controls. This fixture observes process launch; it is not
  itself browser/server/runner acceptance.
- A fresh owned PostgreSQL/server/runner/Vite stack passed the actual Chrome
  UI-to-server-to-runner workflow. The corrected bounded command policy was
  persisted, launched in an isolated worktree and completed using installed
  Edge. Persisted verifier output matched the on-disk report. That report
  includes host and executable/policy pins, browser versions, and desktop/mobile
  screenshots. No browser errors or unexpected remote application resources
  were observed.
- Separate installed Edge and Chrome runs each passed the module and CLI
  workflows and rejected three invalid policies before the application workflow.
  No browser installation or download was attempted.
- Database authentication controls accepted the fixture's correct password and
  rejected a wrong password. All owned services were stopped after acceptance;
  the fixtures and failed attempts were preserved.

The native stack receipt is `issue136-native-stack-r2.json`, SHA-256
`a8d0de40726c207dbf09968a09567c93a3e587909964924cd917f6ceeb706ff4`.
The browser report SHA-256 is
`7ba748797f3757ff296a0e54db95d0d263006399bcf7b175099022a34a82e8b8`.
Server evidence `2bceba56-3377-402f-930a-2f41f8d63893` retained the verifier
report with SHA-256
`3bd158c73b1f4093e15d41d70353bfb27f3b73a50e8ca99728099f650af298a0`.
The corresponding source bindings, drivers, logs, reports and screenshots are
retained in the September 26 issue-completion run.

## Review and limitations

Review covered the resolver's bounded host policy, literal paths, special-file
and mutation checks, fixed JavaScript with environment-based executable input,
output containment, native process handoff and the existing feedback on PR #325.
Current-main CodeQL was checked for all four language categories, with no
analysis errors or open main alerts; the earlier PR #325 alert 14 is fixed.
This is not a claim that inherited Cargo advisory debt is resolved.

The stack used synthetic development identities and a deterministic provider;
it does not establish real-provider, production, cloud or human acceptance.
Environment delivery of ephemeral database credentials is reduced assurance.
Managed Chromium was absent, so its selection contract has unit coverage but
no native acceptance receipt here. Linux/macOS declared paths have unit coverage;
no native qualification on those operating systems is claimed.

The guide documents using the normal preflight CLI and native Python Playwright
launcher to replace #117's temporary in-memory override. Adoption must preserve
that scenario's governed contract and does not complete #117 automatically.
