import hashlib
import json
from pathlib import Path

base = Path(__file__).parent
records = []

def derive(source, target, changes):
    raw = (base / source).read_bytes()
    text = raw.decode('utf-8-sig').replace('\r\r\n', '\n').replace('\r\n', '\n')
    for old, new, expected in changes:
        if text.count(old) != expected:
            raise SystemExit(f'Unexpected replacement count in {source}: {old[:90]}')
        text = text.replace(old, new)
    output = base / target
    if output.exists():
        raise SystemExit(f'Preserve {target}')
    output.write_text(text, encoding='utf-8', newline='\n')
    records.append({'source': source, 'source_sha256': hashlib.sha256(raw).hexdigest(),
                    'target': target, 'target_sha256': hashlib.sha256(output.read_bytes()).hexdigest()})

derive('run-pr354-native-first-run-r8.ps1', 'run-pr355-native-first-run-r6.ps1', [
    ('354', '355', 10),
    ('focused dispatch-readiness acceptance', 'focused preserved-deliverable acceptance', 1),
    ('qa-pr355-readiness-r7.mjs', 'qa-pr355-deliverable-r6.mjs', 1),
    ('qa-pr355-stack-r3.ps1', 'qa-pr355-stack-r6.ps1', 1),
    ('qa-pr355-browser-preflight-r3.mjs', 'qa-pr355-browser-preflight-r6.mjs', 1),
    ("@{package='crony-server';filter='factory_connection_tests::';name='factory-connection';expected=9},\n        @{package='crony-server';filter='issue256_';name='dispatch-readiness';expected=4}",
     "@{package='crony-store';filter='deliverable_failure_tests::';name='deliverable-failure';expected=3}", 1),
    ('[int]$ServerPort = 29355', '[ValidateSet(29355)][int]$ServerPort = 29355', 1),
    ('[int]$WebPort = 26355', '[ValidateSet(26355)][int]$WebPort = 26355', 1),
    ('[int]$DatabasePort = 25355', '[ValidateSet(25355)][int]$DatabasePort = 25355', 1),
])
derive('qa-pr355-stack-r5.ps1', 'qa-pr355-stack-r6.ps1', [
    ("    [Parameter(Mandatory)][string]$QaRoot,", "    [Parameter(Mandatory)][string]$Repository,\n    [Parameter(Mandatory)][string]$QaRoot,", 1),
    ("$product = 'C:\\Users\\shyamsridhar\\code\\ecorp-pr355-completion-20260922'", "$product = (Resolve-Path -LiteralPath $Repository).Path", 1),
    ("    $env:PGPASSFILE = $priorPgpass\n    $env:PGPASSWORD = $priorPgpassword", "    if ($null -eq $priorPgpass) { Remove-Item -LiteralPath Env:PGPASSFILE -ErrorAction SilentlyContinue } else { $env:PGPASSFILE = $priorPgpass }\n    if ($null -eq $priorPgpassword) { Remove-Item -LiteralPath Env:PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $priorPgpassword }", 1),
])
derive('qa-pr355-deliverable.mjs', 'qa-pr355-deliverable-r6.mjs', [
    ('pr265-run-activity-pr355-20260922-r\\d+', 'pr265-run-activity-pr355-[a-zA-Z0-9-]+', 1),
    ("assert.equal(process.env.ECORP_COMPLETION_PR, '355');", "assert.equal(process.env.ECORP_COMPLETION_PR, '355');\nconst forbidden = Object.keys(process.env).filter(name => /^(PG|DATABASE_URL$|GH_|GITHUB_|AZURE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|COPILOT_GITHUB_TOKEN$)/i.test(name));\nassert.deepEqual(forbidden, [], 'The browser driver must not inherit credential variables or database file locators');\nconsole.log(JSON.stringify({check:'focused-credential-preflight',status:'passed',forbidden_variable_names:forbidden}));", 1),
])
derive('qa-pr354-browser-preflight-r3.mjs', 'qa-pr355-browser-preflight-r6.mjs', [
    ('354', '355', 2),
    ("assert.match(process.env.ECORP_COMPLETION_PRODUCT ?? '', /ecorp-pr355-completion-20260922$/);", "assert.ok(path.isAbsolute(process.env.ECORP_COMPLETION_PRODUCT ?? ''), 'An explicit absolute reviewed checkout is required');", 1),
])
path = base / 'pr355-native-r6-derivation.json'
if path.exists():
    raise SystemExit('Preserve derivation receipt')
path.write_text(json.dumps({'purpose':'Complete first-run build, three SQLx regressions and both actual browser/native acceptance lanes; no private receipt prerequisite. Historical drivers are retained unchanged.', 'files': records}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'derived': len(records), 'receipt': str(path)}))
