# Console presentation preferences

The operational web console and the desktop shell that hosts it offer two independent
preferences in the global header. These affect presentation in this browser profile;
they do not select an account, grant permissions, launch work, or record a decision.
The separate public product site is outside this contract.

## Theme

Choose **System**, **Light**, or **Dark**. System is the default and follows changes
to the operating system preference. An explicit Light or Dark selection takes
precedence. The same-origin bootstrap selects the theme before the application
loads, including after a reload. Browser storage failures keep the preference
in the current tab and show that persistence is unavailable.

`ConsoleTheme.css` owns the semantic palette for surfaces, text, controls, focus,
and status. Existing workspace styles use these tokens. Status includes words
or other visible information in addition to color. Office artwork, brand assets,
screenshots, and evidence retain their original pixels; no inversion filter is
applied. This scoped theme support supersedes the light-only direction recorded
in issue #141 for the operational console. It does not rewrite that historical
decision or change public-site branding.

## View

**Operations** retains the five workspaces and their existing controls.
**Executive** presents authorized mission outcomes, returned task counts,
responsible teams, decisions and blockers, budget assurance, and attributable
result links. Counts are not completion estimates. Missing data, unknown cost,
failed checks, rejected reviews, quarantine, exhausted authority, pending
decisions, and stale or disconnected state remain explicit.

The mode preference is independent of theme and role. Operations components
remain mounted while hidden, preserving drafts and exact evidence selection.
An open connection dialog or agent inspector releases its modal behavior while
Operations is hidden. Returning to Operations restores that context. Selecting
an explicit drilldown opens its exact authorized mission, task, run, or artifact;
the destination is checked again against the current viewer and fresh snapshot.
Unavailable or changed context requires a refresh instead of substituting other
work. A pure theme or mode change preserves a loaded evidence inspection. An
explicit run or artifact drilldown clears the previous inspection and requires
an explicit read of that exact evidence again. Executive uses the existing scoped
readers and sends operational actions through Operations. It adds no execution,
permission, or approval mechanism.

The preferences use `ecorp.console.theme` and `ecorp.console.mode` in local
storage. They contain no account, task, or evidence identity. Existing work
selection and draft stores keep their own actor and Corp boundaries.

## Validation scope

Run the [canonical contributor validation](VALIDATION.md). Browser acceptance
must cover both themes and modes, all workspaces and connection screens,
first paint and OS changes, reload and storage failure, contrast and focus,
keyboard and 390px layouts, reduced motion, draft and modal lifecycle, roles,
reconnect, budgets, and exact historical evidence. Use an owned complete local
stack for browser/server/runner claims. Label synthetic browser states separately
from persisted native records. Local deterministic fixtures do not establish
production authentication, provider inference, human review, or hosted CI.
