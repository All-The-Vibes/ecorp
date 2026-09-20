# Local advisory retirement after trial completion

The existing pinned schema-1 feedback CLI retired rule `FB-75b26d857a5cf996e965c7593e004c6a5d4d9ae7437c549c277199384c42193d` into a **new local corpus version** at **2026-09-20T22:11:42.302Z**. The output is `corpus-retired.json`, revision **3**, with **0 active records**. Seven validation checks passed.

The original active LF corpus remains byte-identical at SHA256 `524b3218aa8d17173d08df327dd4655f6cf9469a123474f7c5b9d4f3cbd7f6d8`. The retired output has SHA256 `472daadb5a54e7214a88235ecead876769c4992bc2f21973cef0ca9d82e0ca16`. Only the corpus revision/update time and selected record's retirement state changed. Rule identity, guidance, evidence, creation/expiry and original local-review fields remain intact.

The original two FE evidence records retain capture time **2026-09-19T16:17:22.467Z**. No snapshot was recollected or relabeled, and no new freshness-dependent audit ran.

Retained native evidence confirms actual **owner approval**, the exact two-reference adoption revision `9c758cab-538f-47b4-8d5a-7ac54ec9b7b6`, and the completed post run. Independent review remains **false**. Historical local-review identity flags remain unchanged; the separate native owner decision supplies the human approval evidence.

| Observed measure | Baseline | Post-adoption |
| --- | ---: | ---: |
| Correct cases | 3/3 | 3/3 |
| False approvals | 0 | 0 |
| Unsupported authority claims | 0 | 0 |
| Reported tokens | 48,271 | 49,260 |

The trial showed **no accuracy gain** and used **989 more reported tokens** in the post run. No score increase or actual billed-cost conclusion is claimed.

Retirement applies when a consumer selects this new local retired corpus. No default corpus pointer, native/global policy, prior gate, completed run or already-adopted task reference changed. This closure made no native/API request, remote mutation, collector run, model run or human decision. The prior active input and all historical outcomes remain available for reproduction.

Public evidence: this report, `corpus-retired.json` and `CLOSURE_RESULT.json`. Command/selection/process receipts contain local filesystem paths and remain operator evidence.
