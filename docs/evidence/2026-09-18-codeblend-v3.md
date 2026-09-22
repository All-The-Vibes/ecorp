# CodeBlend V3 local assessment — September 18, 2026 UTC

CodeBlend run `20260918-133400+0800` completed at ECorp source
`9a6ebace9a76d6c0e34cfb45f80d7109bec482b0` with **92.0 structure / 68.25 operations / 79.2 composite**.
The evaluator recorded **verified evaluator-observed-local** evidence, Q2
“Verifiable-but-manual”, R4 “Delegable”, and `AI-Ready: false`.
The 90/90 structure/operations objective remains unmet.

This was an uncached full assessment with three actual successful judges in one
round: `claude-opus-5`, `gpt-6-astra`, and `grok-4.6`. The native evaluator log
reports **536.313 seconds** total; its integer telemetry records 536,312 ms.
The launcher took **538.18 seconds**. Within that total, local-loop observation
took **417.636 seconds** and the judge ensemble took 104.417 seconds.

The assessed source and runner build share the commit above. The evaluator was
pinned to `0a9accccd36446c381c118b783e2e9f623643efa` (executable SHA-256
`4229e93d77dce70e4e3493cab6bc5311c2d02551d024de33319c27ae6a323290`). Source status was clean before and after.

Three fresh cases used nine real native provider invocations through ECorp's
Direct mission server and runner on Windows. They used development identity,
operator-driven controls, Copilot SDK 1.0.11 / CLI 1.0.79, and `gpt-6-astra` with
medium reasoning. The standalone judges used CLI 1.0.85. These were controlled
one-line faults, not evidence of unattended production bug discovery.

| Case | Verified native result | Native tokens |
| --- | --- | ---: |
| Line trimming | Actual independently reviewed repair; **14/14** physical and exported checks, including a separate fresh export verification | 162,848 |
| Verifier-policy limit | Actual independently reviewed 32→16 repair; **47/47** physical and exported checks, including a separate fresh export verification | 192,444 |
| Negative control | Incorrect 32→20 candidate failed 1/47; observed 20→24 edit was cancelled; original source with limit 32 restored byte-for-byte and expected 2/47 failures retained | 167,033 |
| V3 total | Nine invocations; all three declared pipelines fulfilled | **522,325** |

Both positive repairs passed all three persisted native verifier checks. Proposal
reviews were real independent-agent reviews with `human_approval=false`.
Physical and exported files differed only by verified CRLF/LF conversion; raw
byte equality was not assumed. Repeating each completed launch left the run count
at two with unchanged events and source. Duplicate receipt consumption was a
read-only no-op with the same receipt and native fingerprint. A subsequent exact
comment append changed the source: the old receipt was refused while a fresh
current-run receipt was accepted. This does not claim an irreversible consumer
effect or a production publication.

The negative native state chain was **failed → cancelled → failed**. The actual
cancelled run had verification pending, zero verifier evidence and no artifact.
Its wrapper `result.json` inherited the preceding candidate's 46/47 oracle fields;
those fields are **not** an interrupted-run test result. Restoration preserved the
original faulty bytes, an escalation artifact, and failed native acceptance. The
consumer exited 1 with `native_acceptance_not_observed`; an escalation artifact is
not a native “escalated” state or an accepted completion.

Prior attempts remain distinct and unchanged:

| Retained attempt | Outcome | Native tokens |
| --- | --- | ---: |
| Earlier calibration | Separate earlier work; excluded from V3 | 202,644 |
| V1, `20260918-065854+0800` | Failed exact stale-source append because of an extra CRLF; no new completed score | 661,017 |
| V2, `20260918-071738+0800` | Native execution verified; judge ensemble failed on denied prompt reads; no new completed score | 621,229 |
| Prior subtotal | 20 runs / 8 missions retained | **1,484,890** |
| Including V3 | 29 runs / 11 missions; no active native run at audit | **2,007,215** |

All 14 prior protected history collection hashes remained unchanged. Token counts
are persisted ECorp native-provider accounting; standalone judge usage and actual
provider billing are outside these totals. A configured cost cap or zero recorded
cost does not prove zero billing.

The user-approved shared-settings correction preceded V3. Exact settings-file
bytes matched before and after the entire qualification and judging run:
`0b11524ecf4adc35b39228ec600ddf5af5ca335f9e170b8dde38628ddd04da93`. This is preservation evidence,
not native OS command, filesystem or network isolation. Existing scoped filesystem,
permission, budget and verifier boundaries remain material. Judge authentication
used process-scoped environment delivery, explicitly reduced assurance; no
credential values are included here.

The structural scan consumed fresh native Linux Rust coverage: **49,407 / 72,899
lines (67.7746%)**, 69 compiled files, 856 tests passed and none failed. The runner
stopped-session probe remained unexecuted. That scope is not whole-repository,
web, provider or hosted CI coverage. This V3 result does not establish hosted
observation, unattended production operation, or Factory/publication provenance.

Repository API evidence was captured from 2026-09-18T05:34:09.571877Z through
2026-09-18T05:34:14.2971364Z. Later governance observations differ from that capture; the
original pack and score remain frozen. A later rebase or PR integration is not an
assessment of the new revision and must not inherit this score as a fresh result.

The following SHA-256 pins identify the preserved inputs and outputs. The
[public JSON summary](assets/codeblend-readiness/codeblend-v3.json) includes the remaining report, judge,
runtime, timing and accounting bindings without private paths or account values.

| Artifact | SHA-256 |
| --- | --- |
| `profile.json` | `4a191118264eadc7aad1a8e5d5b9154df824f6702265c6b179aed1d28781e9fd` |
| `inputs.json` | `4fb2a5bedf2524531e267bcf5b9000c1d676224dbfa6737071f6189909addf1b` |
| `native-ops.mjs` | `5af625e451c5163a30c12a0332f093758abecd536f4b5ae90bdaf8b34bab8c75` |
| `verifier.mjs` | `6f55d1d2a8d35c1400adfa92a822eb9da45942453b06d56be8a82f341dfc932a` |
| `independent-verify.mjs` | `74dc6e05b43d7991c9265c188c9ba24cc9f1791deae2f58b7cf1b2289719cb24` |
| `observed-loop.json` | `346487d5e0413d46856be7e117f12e2c0568a8f1284812e23657cd5532885879` |
| `run.json` | `b66f21a4e1c5d9869aa75a4ae0913fdb74c0c154900ecfa1931a5b50fcb56fe0` |
| `composite.json` | `4a07055908150897e218e4dd81d7b320a3b642413ab0f672aed543a795507b4e` |
| `composite.md` | `85d8c73bcefb73f3bf41497b87a1f9ef7a1ff72c211de51c59d1060a39af0549` |
| `consensus.json` | `a7898eeb04015c84b0e8b8e43b23bfd4d7b540a805e6a56f6dd5c0c86cc0865c` |
| `independent-native-acceptance.json` | `b9a54aa870b5b3c8732f923558192f670302a1f41a2b6df25280abce9ce2544e` |

The independent audit checked 135 evidence files and performed no source, database,
settings or runtime mutation, provider invocation, native rerun or oracle rerun.
Native server response and signature bindings were checked; no independent client
HMAC verification or benchmark cryptographic attestation is claimed. The audit
does not assign or infer a judge score.

## Why operations remains below 90

The completed operation score is 68.25/100. Its raw dimensions and weights are:

| Dimension | Raw score (0–4) | Weight |
| --- | ---: | ---: |
| Agent interface and operability | 3 | 9 |
| Automation coverage | 2 | 13 |
| Self-healing CI/CD | 3 | 18 |
| Continuous improvement loops | 2 | 13 |
| Agent execution surfaces | 3 | 9 |
| Policy, safety and change guardrails | 3 | 10 |
| Observability | 4 | 9 |
| Human supervision and integration | 3 | 9 |
| Agentic change throughput | 2 | 10 |

The substantive missing evidence includes recurring maintenance-to-delivery,
governed feedback and learned-rule lifecycles, and the autonomous normal Factory
path. The controlled local repairs above do not establish those capabilities.
Raising automation coverage and continuous improvement alone from 2 to 4 would
add 13 points and reach 81.25, still below the requested 90.

The frozen pack also omitted recognition of the shipped Rust MCP server and a
static rollback path despite the observed controlled restoration. API author
classification does not recognize human-published native Factory work as an agent
author. These are evidence limitations, not permission to change the reported
scores, invent attribution, or replace existing execution mechanisms.

The evaluator rated continuous cleanup **70, Enrollment unverified**: it detected
a repeatable driver but no concrete scheduler enrollment. Documentation drift
coverage is **partial**, with residual advice to add checked-diff or fail-on-stale
semantics to affected PR validation. Neither advisory prose nor a nominal scheduled
workflow proves a governed closed loop.

Existing work tracks the native autonomous Factory path in
[#280](https://github.com/All-The-Vibes/ecorp/issues/280), governed post-publication
revisions in [#95](https://github.com/All-The-Vibes/ecorp/issues/95), and continuous
review/remediation in [#269](https://github.com/All-The-Vibes/ecorp/issues/269).
Those dependencies must retain their authority, ownership and acceptance gates.
