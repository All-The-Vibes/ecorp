# Current QA helper reconstruction v2

PR255-B-001 / PR255-QA-PIN, September 21, 2026.

This is a **new current reconstruction**, not a correction to the historical
runtime receipts. Independent review and native acceptance remain parent-owned
gates; the pure test below neither starts nor imports the service helper.

## Exact composition

- Base commit: `b31a38a62330aacba80c3953142e1da957a63ecd`.
- Base path: `tools/owned_test_stack.mjs`.
- Base SHA-256: `d5a475ec96be30a2a02b978c7dd8a43dba528b1aa1cefac0931f9313fb1b4c7b`.
- Complete delta: [`pr237-native-time.patch`](pr237-native-time.patch), unchanged.
- Patch SHA-256 after CRLF-to-LF conversion:
  `6c34349d7acdea6718bec4051a025adca8cc47df860bfe9c957dd91fc4a25732`.
- Output: UTF-8, LF only, no BOM, preserving the base's final newline; 16,321 bytes.
- Output SHA-256:
  `6d0bc7975f68c578a77ac3ebf54b7ee64e99871cfe964d5b9bf6afa2dd58cb1e`.

Read the base with `git show <base>:tools/owned_test_stack.mjs` into a byte buffer,
not a PowerShell text-redirection pipeline. Write it into an owned scratch
directory with a `tools` subdirectory. Feed the complete LF patch to native
`git -c core.autocrlf=false -c core.eol=lf apply --check -`, then the same command
without `--check`. The explicit Git settings prevent ambient Windows CRLF
conversion. The regression implements this recipe using only Node stdlib and Git:

```powershell
node --test tools/issue161/qa-api-provenance.test.mjs
```

The driver still requires the exact dependency HEAD, only the helper modified,
and the exact output SHA-256 **before import**. It does not normalize imported
bytes or accept a second digest. CRLF output, BOMs, extra newlines, edits,
unpatched bytes, wrong commits and additional dirty/untracked files are rejected.
Provisioning a dependency checkout or running start/restart/stop requires its own
owned-fixture authority; this reconstruction test grants neither.

## Historical limit

The original binding remains
`aa0d3c377847c479c69e8be6e1f809bf4b155c53dc6903c1d6922fde4732e144`.
Neither LF nor CRLF reconstruction of the published base and patch yields it.
The explicit local helper history and supplied review evidence did not recover
those bytes. The supplied availability receipt reports the contributor QA roots
unavailable; no private account or credential recovery was attempted.

The historical runtime reports, `runtime-result.json`, and
`qa-finish-evidence.mjs` retain their original claims and binding. That historical
report writer must not be used to attribute new v2 execution to the old digest.
New acceptance must record its actual helper bytes and source separately.
The old runtime's exact helper composition remains unverified here; this does not
establish that the historical run did not occur.
