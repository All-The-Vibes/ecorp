# First publication validation

The first publication validation passed both documentation checks and its
source, policy and whitespace checks, then failed the unchanged Gitleaks scan.
Two generic-api-key findings corresponded to UUID idempotency values in setup
replay requests. These values are not needed in a public copy. All three replay
requests now expose stable SHA256 fingerprints and original lengths instead;
their original request values and observed operation/connection identities remain
in the private receipts. No scanner rule, ignore list or security policy changed.

The original failed validation, redacted native scanner report/output and process
exit remain here. They are failures, not successful publication evidence. A fresh
validation of the revised packet is required before committing or publishing.
Final-revision positive results and native outputs are recorded in the source-bound
PR comment, which can include the eventual commit hash without self-reference.
