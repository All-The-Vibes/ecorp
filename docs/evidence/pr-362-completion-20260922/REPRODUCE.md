# Reproduce the security regressions

Use an isolated checkout of this PR, native Windows x64, the repository-pinned Rust/Node/pnpm toolchain, Python 3.10 or newer, and OpenSSL (the existing Git-for-Windows installation is supported). The actual nine-gate environment is in `validation.json`; its Node version is 24.21.0 rather than CI's pinned 24.19.0. Do not execute these tests in a live provider or production environment.

From the checkout, execute:

```powershell
cargo test --locked -p crony-cli --bin crony-cli transport::tests::loopback_client_bypasses_environment_proxies -- --exact --nocapture --test-threads=1
cargo test --locked -p crony-gateways --lib tests::loopback_gateway_bypasses_environment_proxies -- --exact --nocapture --test-threads=1
python -B -m unittest discover -s tools -p test_startup_validation_harness.py
```

Each outer Rust command must report one passing test. Its fresh native subprocesses exercise HTTP_PROXY and ALL_PROXY separately, removing both forms of NO_PROXY. The CLI reaches localhost and 127.0.0.1; the gateway reaches both hosts with read-only and read-write access. The native origin checks the expected fixture bearer header and the proxy must receive no connection. The Python command must report five passing tests, including the Windows SystemRoot assertion and an actual verified TLS 1.2 connection. It does not start Docker.

The separate `proxy-effectiveness.json` records the exact commands and source hashes for an explicitly retrospective experiment: only the production `builder.no_proxy()` or `transport.no_proxy()` call was removed, retaining the same tests; both commands then exited 101 with `loopback bearer request connected to the environment proxy`. Original source bytes were restored in `finally`, and both commands passed. The failed and passing logs remain distinct. This is not original test-first chronology. The full workspace and all other contributor checks had already passed on those same restored production/test bytes; the mutation is never committed.

The source-exclusive target for this PR and the nine-gate receipt prevent other worktrees' binaries from substituting for these sources. All historical September 21 receipts and captures remain unchanged and keep their original scope. No new browser-to-runner or real-provider acceptance is claimed by these focused checks.
