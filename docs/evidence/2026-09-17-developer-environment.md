# Developer environment and registry portability — September 17, 2026

The Linux Dev Container built and ran through native Dev Containers CLI 0.89.0. Its contributor checks passed after correcting an offline checkpoint-fixture portability defect. The portable pnpm lockfile then passed fresh installs through both an operator-approved enterprise registry on Windows and the public default on Linux. Finally, the actual Windows checkout passed the complete `pnpm check` command in **244.441 seconds**.

The [machine-readable evidence](assets/codeblend-readiness/developer-environment.json) records source, image, executable and lock hashes; exact commands, counts and timings; and owned-container cleanup. It excludes private registry endpoints, personal settings and workstation paths. Setup instructions are in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Tested container

The image uses official Linux/amd64 Rust **1.98.1** and Node **24.19.0** images pinned by digest, plus pnpm **11.19.0**. The native CLI archive's integrity was verified before use. Native configuration reading, container creation, the configured frozen-install/version-doctor command, and a subsequent CLI-executed doctor all passed. This is CLI evidence; no editor UI acceptance is claimed.

Both container sessions ran as UID/GID 1000, dropped all capabilities and used `no-new-privileges`. Inspection confirmed no privileged mode, host network, Docker socket or host-credential mount. The writable workspace was an independent source clone. A linked worktree whose Git metadata lies outside the mount is not supported by this configuration. Cargo used two build jobs; the SDK's optional Copilot CLI download was disabled.

The initial complete source snapshot contained 641 files on base `a86822071790c271974919b341b9a5bbf47d0346` plus the recorded working changes. The final snapshot manifest was `bf9537097959eaf6bdc14e4051e72b5443ba6f589862862096ab6c1fa58dfad7`; all declared files remained unchanged during its checks. The later observation commit `0eb4435615908f737fdb02165f47ecb095b5db98` did not change the tested Rust bytes.

| Completed validation | Result |
| --- | --- |
| Linux toolchain doctor | All six Node, pnpm, Rust/Cargo, rustfmt and Clippy checks passed |
| Linux Node regressions, compiled native MCP enabled | **931 passed, 0 failed, 5 skipped**; 936 total; 26.773 s wall time |
| Linux targeted Rust: domain, protocol, gateways | **40 passed, 0 failed, 0 ignored** |
| Linux Rust workspace | **525 passed, 0 failed, 333 ignored**; 429.932 s wall time |
| Linux migrations, documentation, rustfmt, Clippy, web build and lint | Passed |
| Final Windows `pnpm check`, native MCP enabled | Node **966 passed, 0 failed, 0 skipped**; Rust **555 passed, 0 failed, 333 ignored**; every repository gate passed |

The final Windows gate used Node **22.23.2**, Rust **1.98.1**, pnpm **11.19.0**, the portable lock and the operator-approved registry. Linux used Node **24.19.0**. Platform-selected tests account for different totals. The five Linux skips are the Windows/PowerShell local-stack ownership and AST checks plus three Windows launcher-lock cases; their exact names and reasons are retained in the JSON. Rust opt-in database/platform cases remain ignored, not passed.

## Checkpoint fixture correction

The first Linux Node run retained **62 failures** in `e2e_checkpoint_verification.test.mjs`: historical Windows receipts were assessed using POSIX defaults. That full attempt reported 848 passed and 24 skipped out of 934 tests; native MCP cases were not enabled in that initial attempt.

The fix threads an explicit path implementation through the pure original/recovery assessments and suite coordinator. Offline Windows-contract fixtures consistently pass `path.win32`. Runtime callers still default to native host paths; `localAbsolute` and containment guards are unchanged, and there is no CLI option for overriding path semantics. New regressions prove explicit Windows assessment works on either host while default execution rejects a foreign namespace.

Focused Windows tests passed **155/155 before** and **157/157 after**. The corrected Linux focused suite passed **157/157**, without skips. The final Linux suite enabled the compiled native MCP binary and retained only the five Windows-specific skips above.

## Portable registry resolution

The lock normalization removed **71 redundant registry-derived tarball URLs**. Independent parsed-graph comparison and exact reversible reconstruction verified that versions, integrity fields, importers, snapshots and settings were unchanged. All **71 original SHA-1 integrity pins remain unchanged**; this is not an integrity-algorithm upgrade. Package locations are resolved by pnpm through the host-selected registry, and the repository `.npmrc` no longer fixes a registry endpoint.

The original lock hash was `27ee37bd138599c2db5ce7cf7b65ed8ea7e1e47e69dffe511378832e669f981c`. The adopted portable lock hash is `46fa9b35fac3c25ffb755ac355c01b7b94c4a0ab1f92986b65a263e7a48d0094`.

| Portable-lock check | Result |
| --- | --- |
| Fresh Windows source, empty store and metadata cache; approved registry | Frozen install passed; **28 downloaded, 0 reused**; all 71 policy entries passed; pnpm reported 9.4 s, 9.667 s wall time |
| Actual Windows checkout | Frozen install, web build and lint passed; complete `pnpm check` subsequently passed |
| Fresh Linux source, no dependencies or user npm configuration; public default | Frozen install passed in **5.349 s**, with the lock hash unchanged; web build and lint passed |
| Linux installed-package comparison | All **28** package names, versions and package-manifest hashes matched the earlier canonical-lock installation |

Linux full regression/Rust validation preceded lock normalization. The portable lock received its own fresh Linux install/build/lint validation; the dependency graph did not change. No TLS or package-policy check was disabled. The initial Windows registry mismatch, Linux path failures and setup failures remain retained separately.

All three containers created across container and lockfile validation were ownership-checked and stopped. Their images, stopped caches and evidence were preserved; existing ProgramBench workloads and daemon settings were untouched. These results establish a contributor build environment and package-resolution compatibility. They do not establish product server/runner/database/provider acceptance, production isolation, hosted CI execution or a benchmark score.
