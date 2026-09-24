# Reproducing this acceptance

Use a fresh isolated checkout and the pinned toolchain, then run the nine commands in validation.json. Run tools/local_stack_lifecycle.test.ps1 with -Suite Startup and an owned output directory to exercise the current synthetic cases. Retained baseline/candidate receipts bind their actual source bytes; do not relabel a current rerun as the earlier regression attempt.

recorded-drivers/ preserves the actual native r5 orchestration with normalized machine paths. Adapt those paths and choose fresh, owned PostgreSQL, source, credential and output directories; inspect the driver ownership guards first. Provision and build the server/runner from the bound source, run qa-pr353-startup-r3.ps1, and exercise the genuine browser verifier lane. Preserve generated receipts and stop only processes proven owned by that fixture. A saved report image is separate from actual application acceptance.
