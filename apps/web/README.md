# ECorp web console

The React operations client for ECorp: a shared office floor, mission composer, factory cockpit,
rooms, approvals, and audit history. This is the **actual product UI**, not the separately deployed
[interactive front office](https://ecorp-front-office.shyam-sridhar16.chatgpt.site).

## Run the complete product

First provision an owned PostgreSQL database and create or restore the existing Corp, actor,
and enrolled runner using the [initial setup recipe](../../docs/DARK_FACTORY_CONTRIBUTOR_GUIDE.md).
Supply `DATABASE_URL`, `CRONY_CORP_ID`, `CRONY_ACTOR_ID`, and the matching `CRONY_RUNNER_ID`
through the trusted process environment, with the runner credential at `output/runner/credential.json`.
Then, from the repository root:

```powershell
pnpm install --frozen-lockfile
./tools/start_local.ps1
```

Open `http://127.0.0.1:5187`. The script starts or reuses the Rust server, the already enrolled
outbound runner, and this Vite client. This is a startup compatibility change: automatic database
provisioning, demo bootstrap, and runner enrollment have been removed from Start and Restart.
They require the separate initial setup above. Existing data, credentials and owned live processes
are retained. Close the application stack with `./tools/stop_local.ps1` from the root; coordinate
the separately provisioned database lifecycle with its owner.
Prerequisites and source-repository selection are in the [root README](../../README.md#start-locally).

Starting Vite alone does not start the control plane, database, runner, or provider. If those
services are already running and you only need the frontend:

```powershell
pnpm dev:web --host 127.0.0.1 --port 5187 --strictPort
```

Do not start a second frontend on a port owned by another local stack.

## Find the interface code

| Area | Entry points |
| --- | --- |
| Client bootstrap | [`src/main.tsx`](src/main.tsx) |
| Authentication, snapshots, missions, controls, and factory cockpit | [`src/App.tsx`](src/App.tsx) |
| Office floor and worker inspection | [`src/OfficeFloor.tsx`](src/OfficeFloor.tsx), [`src/OfficeInspector.tsx`](src/OfficeInspector.tsx) |
| Source/runtime selection and studio configuration | [`src/missionRuntime.ts`](src/missionRuntime.ts) |
| Visual system | [`src/App.css`](src/App.css), [`src/OfficeFloor.css`](src/OfficeFloor.css), and the other focused stylesheets |
| Build and lint configuration | [`vite.config.ts`](vite.config.ts), [`.oxlintrc.json`](.oxlintrc.json), [`package.json`](package.json) |

Dependencies and versions are declared in `package.json` and the root lockfile. The production build
runs TypeScript project checks before Vite; lint uses Oxlint.

## Keep the office truthful

- The client displays authoritative state; it never supervises provider processes.
- **Mission → Run setup → Verification** is the current composer flow. Source confirmation is
  required, and **Hold at briefing** creates a server-held plan rather than a browser-only pause.
- Comments are messages, not tasks or approvals. Live steering uses the explicit single-holder
  control lease.
- Retired mission workers remain in history but do not populate the current office.
- Keep provider evidence, verification evidence, source deliverables, and publication state distinct.
- Preserve keyboard access, readable states, reduced-motion behavior, and the 390-pixel layout.
- Reuse the [approved ECorp branding](../../docs/BRAND_AND_PRODUCT_SITE.md). Do not substitute
  marketing-tour state for real server or runner state.

## Validate

From the repository root:

```powershell
pnpm build:web
pnpm lint:web
node --test apps/web/src/missionRuntime.test.mjs
```

Before committing, also run the complete repository gate, `pnpm check`.
For user-visible behavior, exercise the complete browser-to-server-to-runner path, not just a static
render. The [evaluation guide](../../docs/EVALS.md) describes isolated browser and system regressions;
do not run destructive fixtures against a shared/manual development stack.

Continue with the [mission journey](../../docs/USER_AND_DEVELOPER_JOURNEY.md),
[architecture](../../docs/ARCHITECTURE.md), and [contributor guide](../../CONTRIBUTING.md).
