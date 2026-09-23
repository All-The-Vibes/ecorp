$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
pwsh -NoProfile -File ./tools/local_stack_browser_policy_handoff.test.ps1 -NodePath $nodePath -OutputDirectory (Join-Path $env:GITHUB_WORKSPACE 'output/runner-platform-browser-policy-handoff')
      - run: cargo test --locked -p crony-runner ${{ runner.os == 'Windows' && '-- --test-threads=1' || '' }}
      - run: node tools/platform_runner_contract.mjs
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
name: runner-platform-${{ matrix.os }}
path: output/platform/*
      - name: Preserve Windows connection ACL readiness receipts
        if: always() && runner.os == 'Windows'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
name: runner-platform-windows-readiness-${{ github.run_attempt }}
path: output/runner-platform-windows-readiness/
if-no-files-found: warn
retention-days: 14
      - name: Preserve Windows browser policy handoff receipts
        if: always() && runner.os == 'Windows'
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
name: runner-platform-browser-policy-handoff-${{ github.run_attempt }}
path: output/runner-platform-browser-policy-handoff/
if-no-files-found: warn
retention-days: 14

  desktop-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
persist-credentials: false
      - uses: dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87 # stable
        with:
toolchain: 1.98.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
        with:
version: 11.19.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
node-version-file: .node-version
cache: pnpm
      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:web
      - run: cargo install tauri-cli --version 2.11.4 --locked
      - run: cargo tauri build --debug --no-bundle -- --locked
        working-directory: apps/desktop
