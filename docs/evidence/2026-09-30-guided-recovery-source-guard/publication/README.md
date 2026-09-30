# Observed publication validation

The original core packet was checked successfully at 2026-09-30T23:41:16.389168+00:00.
Its tested product tree is 8022064f34762e4f1828bc9d7cb2da6af6a8de88 and its validated publication
tree is 0e6f926cac02c76e024d3f2652535923f48cbe11. The actual process exit, documentation,
personal-path, diff and native Gitleaks logs are included in this directory.
All recorded checks exited zero and Gitleaks reported zero findings.

Every core-packet byte remains unchanged. The files here and the additional R2
publication drivers were added afterward. The original passing receipt does not
validate these later additions or itself. R2 separately validates the extended
packet and reconstructs the original validated tree; its actual result is retained
in the run record and linked from the PR after execution. No hosted checks, merge,
issue completion or independent review are implied.

manifest.json binds the original local receipt/log bytes to their sanitized
published copies and identifies the complete original file set. The existing core
summary intentionally remains immutable; this is the additional publication record.
