# Final owner-reviewed paired trial audit

The baseline and post-adoption runs both passed **3/3 automated checks** and assessed **3/3 cases correctly**, with **zero false approval or unsupported authority claims**. This completes the owner-reviewed execution path; it shows **no measured quality improvement**. The historical operations score remains **74.75/100**; no new CodeBlend assessment or judge run was performed.

| Measure | Baseline | Post-adoption |
|---|---:|---:|
| Correct cases | 3/3 | 3/3 |
| Automated checks | 3/3 | 3/3 |
| False approval claims | 0 | 0 |
| Unsupported authority claims | 0 | 0 |
| Reported tokens | 48,271 | 49,260 |
| Attempts | 1/1 | 1/1 |

The post run used **989 more reported tokens**. Its output changed only cited review tuples for PRs 255 and 320; PR 283 and all verdict fields were unchanged. PR255 replaced a bot comment citation with two older recorded human review tuples; PR320 omitted a bot comment citation. Both citation selections passed the unchanged oracle. This is not evidence of a scored quality gain.

All **22 frozen input/history pins** and **20 source pins** matched. Case input, output schema, private expected answers, oracle, paired verifier and original baseline/post request files remain unchanged. The native source checkout was clean at 39632b957819012721c90902925d8fa7a9c7e873. The post contract differs from the baseline only by the exact two owner-approved advisory references, increasing references from 21 to 23. Source, model, reasoning effort, tools, write scope, budgets and verifier remain identical.

The real owner decision was recorded at 2026-09-20T22:05:43.086477Z for source run a70b5696-fd84-4242-be87-87f437c5a43a. Schema-1 application recorded exactly one native revision, 9c758cab-538f-47b4-8d5a-7ac54ec9b7b6, and read back target version 2 with zero runs before the separate post launch. The adopted source remained stable across application. This is owner approval, not independent review.

Baseline run 7f603ad5-3d06-4905-8f4f-c93a6cc55249 and post run d2e28ef7-90ba-4c9c-a170-1d58c06456d2 used different native provider sessions and isolated workspaces, with no resume. Both have native session-termination evidence. The post consumed its one reserved attempt, requested no risky-action approval, and performed no automatic retry.

The original failed LF carrier remains failed (2/3 checks), and the superseded independent-review carrier remains preserved as pending in its retained observation; neither was relabeled as the accepted owner source. Across the five actual provider runs in this continuation, reported tokens total **206,334**. Reported cost 0 does not establish actual billed cost. The original allocation and earlier exhausted history were not reset.

Evidence is frozen as of 19 September 2026 and covers only three selected cases with no eligible negative control. Development identity, retained runtime qualification, bounded snapshots and tool-level rather than OS-level isolation remain explicit limits. No causal improvement, generalization, agent-authored merged-PR throughput or new benchmark score is claimed.

This audit used retained native observations and local byte/hash comparisons only. It made no native mutation, provider call, oracle rerun or notification. The separate local retirement produced corpus revision 3 with zero active records. The original active bytes, guidance, evidence, expiry and local-review fields remain preserved; only revision/update time and retirement state changed. This is not native/global policy revocation, and future consumers must select the retired corpus version. Detailed pins, semantic differences and source receipts are in [FINAL_TRIAL_AUDIT.json](FINAL_TRIAL_AUDIT.json).

The final audit uses the refreshed native observation at 2026-09-20T22:11:40.831Z, whose run timestamp matches the exported post receipt. The earlier observation differed only in workspace preservation metadata and timestamp; results, tokens, checks and contracts did not change. The initial audit and comparison-build refusal are preserved. The comparison result SHA256 is `23c94f8ee0e7b492be7a90ae5ed26143fbf72cf2e5e3deabd1ca6603ac1719b9` and all five of its source-manifest hashes match.
