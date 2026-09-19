# Connect to the private ECorp trial

Run this on your Windows client computer in trusted **PowerShell 7.4 or later**. This bundle includes the reviewed `trial-config.json` for tunnel **`ecorp-owner-20260919-4e1fd07a.usw3`**. The trial expires at **2026-09-20 15:39:28 UTC**. Do not add tokens to the config or change the fixed tenant/user allowlist.

The tenant is `16b3c013-d300-468d-ac64-7eda0820b6d3`. The only permitted human object IDs are owner `b56dbcfe-2876-4ab9-9294-e3cebfae0490` and reviewer `28b60676-5c28-4a32-ba00-476a6338ba45`. The service's reviewed group access contains those two users. These identifiers are configuration, not credentials.

1. Use the installed [Microsoft Azure CLI MSI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows). If needed, sign in in a **visible PowerShell window**:

   ```powershell
   az login --tenant 16b3c013-d300-468d-ac64-7eda0820b6d3 --allow-no-subscriptions
   ```

   Use the normal browser/WAM experience. Device-code sign-in was rejected by tenant policy with `AADSTS530033`; the helper does not switch accounts, invoke login, or bypass that policy. It requires the current account tenant and signed-in user's object ID to match one of the two exact reviewed principals.

2. Use the operator-provided `devtunnel.exe`, or obtain it from Microsoft's [official install instructions](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started#install) / [Windows x64 download](https://aka.ms/TunnelsCliDownload/win-x64). Keep its original filename. The helper requires a valid Microsoft Authenticode signature and the official `devtunnel.dll` original filename. It does not download/install software. Do **not** run `devtunnel login` for this connection.

3. Extract this complete bundle, open PowerShell in its directory, and connect using the included configuration and your installed binary path:

   ```powershell
   pwsh -NoProfile -File .\Connect-EcorpTrial.ps1 `
     -ConfigPath .\trial-config.json `
     -DevTunnelPath C:\Tools\devtunnel.exe
   ```

   No execution-policy bypass is used. Review the downloaded scripts and use your organization's normal trusted-script process if policy blocks them.

This trial forwards exactly two ports: web **5188** and API **8791**. Both must be unused on your computer. The script checks before authentication and again immediately before starting the client. It refuses occupied ports instead of redirecting you to an existing local app or silently selecting another port. It opens no browser automatically. Keep the PowerShell window open; Ctrl+C disconnects the client it started.

After the helper reports that it started the client, open **http://127.0.0.1:5188/** in your browser. The API health endpoint is **http://127.0.0.1:8791/health**. A started process alone does not establish connection success; the browser and API checks must succeed through your own connection. The helper accepts web port 5187 for other reviewed trials, but this config selects 5188 and must remain unchanged.

The helper uses the native Azure CLI to obtain a service-audience token in memory, makes one fresh HTTPS read for a **connect-only** token on the exact reviewed cluster/tunnel, and checks the returned IDs and exact two advertised ports. The connect token is passed to the signed client through standard input; it is never an argument, environment variable or saved file. Neither token is decoded or printed. Native stdout/stderr and HTTP failure bodies are never forwarded; only fixed status messages are shown. Azure CLI retains ownership of its normal sign-in cache; the helper does not copy that cache or use a stored owner/connect token fallback.

The verified CLI's `connect` command has no port-selection flag. The helper refuses initial remote-port drift, but it does not enforce a filter against later host-side port changes. The operator must keep the tunnel's two reviewed ports fixed for this trial. It does not request management/host tokens or change the tunnel.

If a fixed refusal code appears, stop and give the operator **only that code**, never token output or a credential file. `SIGN_IN_TENANT`, `SIGN_IN_USER`, `USER_NOT_ALLOWED` and `AZURE_CLI_FAILED` require checking your legitimate Azure CLI session; `PORT_BUSY` requires resolving your own local port conflict; `CLIENT_SIGNATURE` requires the genuine signed client. Request/response failures require operator review of the tunnel's current access and port configuration. There is no retry under another identity.

This is private tunnel transport for a **development-mode ECorp trial**. It is not native ECorp OIDC authentication, an independent-review decision, or authority to select another person's ECorp actor. Use only the actor and review instructions the operator supplies. GitHub notification and connection success do not approve the pending native intent.

At 2026-09-19 16:03:29 UTC, the operator verified HTTP 200 for the retained web build (SHA256 `135a9cf439ef7f772c6ee401cbfe3b94bd77e4810f8cb760fff43e04f285ccf8`) and HTTP 200 for API health (`crony-server`, status `ok`, mode `development`). Unauthenticated web and API requests returned HTTP 302 challenges verified to Microsoft's OAuth authorize endpoint. These are owner HTTP relay checks. They do not prove a real reviewer CLI/browser connection, and no provider execution was performed.

The included test result covers 36 passing mock cases and PowerShell parsing. No live Azure identity call, service request, tunnel connection or actual token is used by the test suite. The reviewer CLI/browser connection remains to be verified. To rerun these offline checks, run `pwsh -NoProfile -File .\Test-ReviewerClient.ps1`; this refreshes `MOCK_RESULTS.json`, so its timestamp and hash will then differ from the packaged manifest.

`MANIFEST.json` records each packaged payload file's byte length and SHA256. The helper does not install software, authenticate ECorp actors, or approve an intent. The bundle contains no executable binary or actual credentials; obtain prerequisites from the official links above.
