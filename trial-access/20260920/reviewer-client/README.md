# Private ECorp reviewer connection

Read [REVIEWER.md](REVIEWER.md) for prerequisites, the complete connection procedure, refusal codes and verification limits.

- Windows with PowerShell 7.4+, the Microsoft Azure CLI MSI, and Microsoft's signed `devtunnel.exe`.
- Sign in normally with the permitted tenant and your own reviewed human account. Device-code authentication is blocked by tenant policy; do not use a bypass or `devtunnel login`.
- Keep the included `trial-config.json` unchanged. It selects `ecorp-owner-20260919-4e1fd07a.usw3`, web port 5188 and API port 8791.
- The trial expires **2026-09-21 17:40:00 UTC**.

From this extracted directory, with your own installed client path:

```powershell
pwsh -NoProfile -File .\Connect-EcorpTrial.ps1 `
  -ConfigPath .\trial-config.json `
  -DevTunnelPath C:\Tools\devtunnel.exe
```

Then open **http://127.0.0.1:5188/** and check **http://127.0.0.1:8791/health**. Both local ports must be free. Keep the PowerShell window open during the trial; Ctrl+C disconnects its client.

The operator's HTTP relay checks passed. A real reviewer CLI/browser connection remains unproved. This is private transport for a development-mode ECorp trial, not native ECorp OIDC authentication or an independent approval. The test suite's 36 passing mock cases made no live calls.

The bundle includes source, reviewed config, offline tests/results and a SHA256 manifest. It contains no actual credentials, sign-in cache or executable binary.

This is the renewed20September access window for the same two-person group and exact tunnel/ports. The previous window stopped on schedule. Client code and the36-case mock result are unchanged from the reviewed19September bundle; their hashes are verified again here rather than claiming a new test run. The new access grant and owner HTTP relay checks were freshly verified20September. No human/native approval or provider task is implied.
