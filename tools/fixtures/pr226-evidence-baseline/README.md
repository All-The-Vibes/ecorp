These are the exact recovered tests used in the retained PR226 baseline run.
Their SHA-256 is `caee91c1dfca31da8372eb10c22274f2a57cc17be2bf0833c4c99db83b804427`.
The fixture is outside ordinary test discovery and is not the current scanner suite.

Run `python tools/replay_pr226_evidence_baseline.py --repository . --output-directory <new-output> --node <node-24.21.0>` on Windows. The driver checks the immutable source revision, source bytes, recovered tests and all three historical evidence trees before creating output. It copies Git blobs from that revision rather than current worktree files. Successful reproduction means 16 tests ran with 8 passes and 8 expected failures, with no skipped or cancelled tests. The driver returns success only for that historical outcome; its test subprocess still records exit code 1.

The original baseline log SHA-256 is `167c82f65c00570cc9b0b6c7dca4d9b4077386e9ec3c93a1a77f425af5f67b43`. Replay uses TAP for an unambiguous result summary; runtime durations and local paths vary, so replay log bytes are separately hashed. This adds reproducibility to the preserved r4 report without rewriting its author-time limitations or claiming an original red/green development sequence.
