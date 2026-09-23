import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, appendFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const configuration = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''))
const { repository, name, program, arguments: args, log, outputDirectory, stagedTree } = configuration
assert.ok(repository && name && program && args && log && outputDirectory && stagedTree)
const prefix = path.join(outputDirectory, name)
const receiptPath = `${prefix}.execution.json`
for (const file of [receiptPath, log]) {
  await assert.rejects(access(file), { code: 'ENOENT' })
}
const git = (...arguments_) => execFileSync('git', ['-C', repository, ...arguments_], { encoding: 'utf8', windowsHide: true }).trim()
assert.equal(git('write-tree'), stagedTree)
assert.equal(git('diff', '--name-only'), '')
const command = [program, ...args].join(' ')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CRONY_PLAYWRIGHT_MODULE)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const receipt = { schema: 1, kind: 'Live browser command runner; direct child-process output, not replayed logs or an application screen', command, source_head: git('rev-parse', 'HEAD'), tested_staged_tree: stagedTree, browser: browser.version(), captures: [] }
let child
let exitCode = null
let exitSignal = null
let processError = null
let output = ''
let writes = Promise.resolve()
const substitutions = [[repository, '<reviewed-worktree>'], [outputDirectory, '<validation-output>'], [process.env.USERPROFILE, '<local-user>']].filter(([value]) => value)
const normalized = value => {
  for (const [from, to] of substitutions) {
    for (const variant of new Set([from, from.replaceAll('\\', '/')])) value = value.replaceAll(variant, to)
  }
  return value
}
const hash = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${String(value).replaceAll("'", "''")}'`
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 })
  await page.route('**/*', route => route.abort())
  await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Live ECorp command runner</title><style>body{background:#111827;color:#e5e7eb;font:15px/1.4 Consolas,monospace;margin:24px}h1{font:24px system-ui;color:#93c5fd;margin:8px 0}p{margin:6px 0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #475569;padding:12px;background:#0b1220;font-size:12px;line-height:1.3}#command{font-size:19px;color:#fff}#status{color:#fde68a}#summary{color:#a7f3d0}.note{color:#cbd5e1;font:13px system-ui}</style><h1>ECorp · live validation command</h1><p class="note">This browser runner launches the child below and displays its output as it arrives. No saved logs are replayed.</p><p id="command"></p><p id="source"></p><p id="timing"></p><p id="status">Preparing child process</p><pre id="summary"></pre><pre id="output"></pre></html>`)
  await page.locator('#command').textContent()
  receipt.started_at_utc = new Date().toISOString()
  await writeFile(log, '', { flag: 'wx' })
  const script = `$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $false; $LASTEXITCODE = 0; & ${quote(program)} ${args.map(quote).join(' ')}; exit $LASTEXITCODE`
  child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: repository, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  receipt.child_pid = child.pid
  const append = data => {
    const text = data.toString('utf8')
    output += text
    writes = writes.then(() => appendFile(log, data))
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const finished = new Promise(resolve => {
    child.once('error', error => { processError = error.message; exitCode = 1; resolve() })
    child.once('close', (code, signal) => { exitCode = code ?? 1; exitSignal = signal; resolve() })
  })
  const render = async () => {
    const lines = normalized(output).replaceAll('\r\n', '\n').split('\n')
    const summary = lines.filter(line => /test result:|tests? [0-9]|pass [0-9]|fail [0-9]|skipped [0-9]|Finished|built in|warnings|errors/.test(line)).slice(-8)
    await page.evaluate(state => {
      document.querySelector('#command').textContent = state.command
      document.querySelector('#source').textContent = `Source HEAD: ${state.head}\nTested staged tree: ${state.tree}`
      document.querySelector('#timing').textContent = `Child PID: ${state.pid} · Started: ${state.started} · Observed: ${state.now}`
      document.querySelector('#status').textContent = state.status
      document.querySelector('#summary').textContent = state.summary.join('\n') || '(no summary emitted yet)'
      document.querySelector('#output').textContent = state.lines.slice(-38).join('\n') || '(waiting for child output)'
    }, { command, head: receipt.source_head, tree: stagedTree, pid: child.pid, started: receipt.started_at_utc, now: new Date().toISOString(), status: exitCode === null ? 'RUNNING — actual child process' : `COMPLETED — exit ${exitCode}${exitSignal ? ` / ${exitSignal}` : ''}`, summary, lines })
  }
  let runningCaptured = false
  while (exitCode === null) {
    await render()
    if (!runningCaptured && exitCode === null) {
      const file = `${name}.running.png`
      const before = new Date().toISOString()
      const liveAtRequest = exitCode === null
      await page.screenshot({ path: path.join(outputDirectory, file), fullPage: true })
      receipt.captures.push({ file, started_at_utc: before, finished_at_utc: new Date().toISOString(), child_running_at_request: liveAtRequest, child_running_at_completion: exitCode === null, sha256: hash(await readFile(path.join(outputDirectory, file))) })
      runningCaptured = true
    }
    await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 250))])
  }
  await finished
  await writes
  receipt.finished_at_utc = new Date().toISOString()
  receipt.exit_code = exitCode
  receipt.signal = exitSignal
  if (processError) receipt.error = processError
  await render()
  const finalFile = `${name}.completed.png`
  const captureStart = new Date().toISOString()
  await page.screenshot({ path: path.join(outputDirectory, finalFile), fullPage: true })
  receipt.captures.push({ file: finalFile, started_at_utc: captureStart, finished_at_utc: new Date().toISOString(), child_running_at_request: false, child_running_at_completion: false, sha256: hash(await readFile(path.join(outputDirectory, finalFile))) })
  receipt.log_sha256 = hash(await readFile(log))
  receipt.source_unchanged = git('write-tree') === stagedTree && git('diff', '--name-only') === ''
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  assert.ok(receipt.source_unchanged, 'Validation source changed during command')
  console.log(JSON.stringify({ command, exit_code: exitCode, receipt: receiptPath, captures: receipt.captures.length }))
  process.exitCode = exitCode
} finally {
  if (child && exitCode === null) child.kill()
  await browser.close()
}
