# Cargo output guard correction

The first publication assembly returned native exit 1 before creating its packet or assembly/source receipts. The helper applied its single-link evidence reader to `target/debug/crony-server.exe`, a Cargo build output with two hard links. The exact failure and observed native exit are retained in `publication-assembly-failed-r1.json`.

All three native acceptance binaries retain the exact SHA-256 values recorded before acceptance R7. Each has exactly two names: the expected `target/debug/crony-*.exe` and its corresponding `target/debug/deps/crony_*.exe`, within the owned checkout. Earlier receipts do not record link counts, so no claim is made about when Cargo established those links.

The corrected helper uses a separate reader for only these three fixed pairs. It rejects linked or reparse-point ancestors, requires both regular files to identify the same file with exactly two links, verifies the opened file and both paths before and after reading, and still requires the recorded acceptance hash. The general source and public-evidence reader is unchanged and still rejects every hard link.

Guard verification R1 recorded the matching hashes, path-pair checks, rejection of unrelated paths and continued rejection by the general evidence reader. Its attempted full input verification then failed on an overly broad historical frozen-install source assertion, returning native exit 1. It did not establish a successful complete preflight. That failure and the exact helper are preserved separately; follow-up R2 records the narrowly corrected historical scope and its own observed outcome.

The original helper is preserved as `drivers/issue95_publication_r3_pre_cargo_guard.py.txt`. This is a publication-helper correction; no product source, assertion, test deadline, named validation gate or repository security policy changed, and completed product validation was not rerun.
