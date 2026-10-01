# Observed publication validation

The original core packet was checked successfully at 2026-10-01T00:17:41.151104+00:00.
Its tested product tree is e19869b13b8a4a59231a2d9babece644f2b9e43c and its validated publication
tree is c112b8f9cc0b170bf9e78c3d2d97e50dae4c8da5. The actual process exit, documentation,
personal-path, diff and native Gitleaks logs are included in this directory.
All recorded checks exited zero and Gitleaks reported zero findings.

Every core-packet byte remains unchanged. The files here and the additional R4
publication drivers were added afterward. The original passing receipt does not
validate these later additions or itself. R4 separately validates the extended
packet and reconstructs the original validated tree; its actual result is retained
in the run record and linked from the PR after execution. No hosted checks, merge,
issue completion or independent review are implied.

manifest.json binds the original local receipt/log bytes to their sanitized
published copies and identifies the complete original file set. The existing core
summary intentionally remains immutable; this is the additional publication record.
