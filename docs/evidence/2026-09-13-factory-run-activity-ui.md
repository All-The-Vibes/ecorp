# Factory run activity: first UI slice (#259)

## Scope and source

Implementation for review on `codex/issue-259-factory-ux`, based on
`b2523964e7576cafc00e84a51e1044f55826dea7`. This is a first Factory-panel slice,
not completed issue acceptance, a deployment, or a new provider run.

The approved information hierarchy is implemented using the current
`WorkResultCard` palette, typography, facts and native disclosures. The earlier
standalone design preview is not used as a replacement visual system. No public
product-site files, global theme or Executive-mode behavior are changed.

## Implemented behavior

- `runActivity.ts` projects the exact selected mission/task/run from the existing
  authorized snapshot. The existing evidence selector prioritizes pending reviews;
  exact tool-approval waits then take precedence over unrelated newer work.
  Missing or conflicting task identity does not select a replacement run.
- Factory's raw status is explicitly labeled **Intake**. Its result card separately
  describes execution, review, suspension, protected stops, quarantine and unknown
  connection state. A Running intake record is not evidence of an active provider.
- Existing result/source/publication components and operational controls remain.
  The contextual primary navigation targets the inspected run through the existing
  entity-navigation handler, not an unrelated remembered evidence selection.
- The new facts expose the task in focus, assigned agent, control at the snapshot,
  provider execution, runner presence and snapshot receipt time.
- Native termination receipts and later teardown uncertainty remain distinguishable.
  Lost and disconnected do not assert process death. Verifier-only work does not
  appear as a running model.
- The activity disclosure shows at most five supported events from that run,
  ordered/deduplicated by journal identity and sequence. Labels are allowlisted;
  provider output, prompts, tool signatures/arguments and raw payloads are omitted.
- Run intervals require timestamped start/end evidence within the visible snapshot.
  They are explicitly recorded intervals, not live elapsed time, ETA or inferred
  completeness. Snapshot limits and missing evidence remain visible.
- Receipt/failure metadata is attached to the existing viewer-scoped snapshot state.
  No new endpoint, polling loop, process manager, authority or provider request is added.

## Verification performed

- Complete frontend suite: **272 passed**, including 22 new pure-projection,
  component-rendering and source-integration tests.
- TypeScript and production Vite build: passed.
- Frontend lint: passed.
- Migration consistency: 41 immutable checksums passed; no migration was changed.
- Rust repository gate: `cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, and
  `cargo test --workspace` passed. Tests marked ignored by the workspace were
  not executed; this does not establish database-backed integration acceptance.
- `git diff --check`: passed (Git notes its existing Windows line-ending policy).
- Actual component browser fixture at `/qa/run-activity.html` imports the real app
  stylesheets, `WorkResultCard`, projection and detail component. Nine synthetic
  states were exercised: active, suspended, outcome review, completed,
  disconnected, snapshot failure, quarantine/stop, verifier-only and runner loss.
  All retained collapsed disclosures initially and had no horizontal overflow.
- Desktop inspection at 1280px had no horizontal overflow. Tab navigation reached
  the native summary with visible focus, and Enter expanded the activity. The
  browser reported no warning/error console entries during that inspection.
- The screenshot session did not apply a requested 390px viewport override:
  the page still reported 1280px. The screenshots below are desktop evidence,
  not narrow-screen proof. Recheck responsive behavior with a confirmed viewport
  during acceptance; temporary browser overrides were reset after capture.
- The fixture sends no operational requests and never imports App/bootstrap. It
  is component-browser evidence, not a browser/server/runner acceptance run.

## Remaining acceptance and limits

Docker's Linux engine pipe was unavailable, `DATABASE_URL` was not available to
the task, and no native PostgreSQL command or installation was found in the
targeted prerequisite checks. No private database, retained runner identity or
other contribution stack was borrowed or reset. The canonical local checkout and
services remain untouched.

The full, explicitly owned browser/server/runner fixture has therefore **not run**.
Before accepted completion, exercise the actual Factory integration against a
matching-source isolated stack, including reconnect/read failure, role/room changes,
pending review versus a newer worker, exact-run navigation, and source retention.
Actual native provider activity content beyond the safe fixed labels is not claimed.

Mission/agent-inspector reuse, broader trace/history navigation and full issue #259
acceptance remain separate follow-up slices. The repository commit gate passed;
the user requested a commit/push of this first slice and screenshot evidence on
#259. This is feature-branch review material, not completed issue acceptance, a
Factory publication, a PR, a merge or a deployment. The issue remains In Progress.

## Screenshot gallery

Captured from `/qa/run-activity.html` using the actual components and stylesheets,
with clearly labeled synthetic data. These are UI state views of the first
Factory-panel slice, not separate production routes or live provider sessions.
The screenshots use native GitHub issue attachments; no private runner or
database content is present. The expanded detail capture is a scrolled viewport,
not a stitched or simulated full-page image.

### Running

Task, agent, provider execution and snapshot freshness are visible together.

![Running Factory run with current UI](https://github.com/user-attachments/assets/d129c28b-d32a-437a-8f3c-92c7249f4003)

### Blocked / suspended

Running intake is distinguished from the cancelled mission/run and confirmed
provider termination; preserved source is not described as a verified result.

![Suspended run with separate intake and execution states](https://github.com/user-attachments/assets/5a6de17f-b00a-4fe0-ba96-4b44c16bdbb0)

### Awaiting review

The exact run needing a decision is distinct from active execution.

![Awaiting-review Factory run](https://github.com/user-attachments/assets/335c4650-8d8c-4833-9bc9-2263ddb44e6f)

### Completed

Accepted completion is distinct from publication, merge and deployment.

![Completed Factory run and result navigation](https://github.com/user-attachments/assets/7eeeeb87-ca78-4087-a192-2b49264fbd23)

### Disconnected

Retained records remain inspectable without claiming current provider liveness
or that a disconnected browser stopped the runner.

![Disconnected Factory state with freshness warning](https://github.com/user-attachments/assets/b91d0de9-806c-4700-8be3-5b60a24d34cd)

### Expanded activity and execution context

The native disclosure shows five safe event labels and separates intake, mission,
selected run and recorded interval. Raw provider text and tool arguments are absent.

![Expanded bounded event timeline and execution context](https://github.com/user-attachments/assets/92ee5bba-b248-4c08-bf85-7cd42fa03b10)
