# Observed publication validation

The core packet passed separate evidence validation at 2026-10-01T15:18:18.201621+00:00.
The tested product tree was `636ea213bd1df15e19ffe67fd0ccf1f7326f0693` and the core publication tree
was `7dc084fe162842a3e32208c5ea3f99bbdbc0d013`. This directory contains the passing receipt,
observed process exit, documentation, whitespace and native personal-path checks,
and redacted Gitleaks logs. Both packet and exact changed-blob scans reported
zero findings using the unchanged repository policy and Gitleaks 8.30.1.

The original core packet remains byte-for-byte unchanged. These receipts were
added afterward and do not validate themselves. The extended packet receives a
separate validation whose result and exact final tree remain in the run record
and are reported against the final commit. Product execution is not repeated
for evidence-only additions with identical source and canonical command discovery.

No hosted check, independent approval, human decision, merge or issue closure
is implied. The manifest binds each original artifact to its sanitized copy.
