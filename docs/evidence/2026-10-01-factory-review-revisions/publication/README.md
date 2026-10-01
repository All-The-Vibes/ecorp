# Observed publication validation

The core packet passed its separate evidence checks at 2026-10-01T08:09:57.051417+00:00.
Its reviewed source tree after the fixture cleanup is 5072c911cf980d5b48ed78e6d946f491eef94a1a and core publication tree is
c664215edfda94804d72a89a601b76f7c2842f2a. This directory publishes the actual passing receipt,
observed native process exit, documentation and native personal-path checks,
diff check, and redacted native Gitleaks logs. Both packet and all changed-blob
scans returned zero findings under the unchanged repository policy.

The original packet remains byte-for-byte unchanged. These files were added
afterward; the core validation does not validate itself or these additions.
The subsequent R10 validation checks the extended packet and reconstructs the
exact core tree. Its result is retained in the run record and will be reported
against the final commit after execution. Product code is not changed here.

The manifest binds original local bytes to their sanitized public copies and
names the entire core packet. No hosted CI, independent approval, human signoff,
issue closure or merge is implied.
