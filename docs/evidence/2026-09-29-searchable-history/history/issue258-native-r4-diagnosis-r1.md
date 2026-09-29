# Issue 258 native acceptance r4 diagnosis

The retained r4 attempt failed at the revoked-room browser assertion. It passed nine earlier checkpoints, including native runner continuation during a browser WebSocket disconnect. No product source changed; complete physical source equality and exact owned stack shutdown passed.

The driver's direct history request after deleting Bob's room membership observed HTTP 404 with `Cache-Control: no-store`. Its next action was a full development-page reload. `apps/web/src/App.tsx` bootstraps the demo on page initialization; `crates/crony-store/src/lib.rs` inserts missing Alice/Bob demo memberships during that bootstrap. The reload therefore restores the authority the test intended to keep revoked. The remaining mission card does not establish a history authorization defect.

Revision r5 uses real actor selection to obtain a fresh authorized snapshot without repeating demo bootstrap. It asserts the revoked room, mission and root runs are absent from the native snapshot, the membership remains absent before and after UI navigation, the prior exact saved selection remains unavailable without substitution, and the history endpoint still excludes the revoked room. Existing restoration remains in `finally`.

The r4 failure, screenshots, logs and retained fixture remain unchanged. The new attempt uses a fresh owned root. No acceptance pass is claimed by this diagnosis.
