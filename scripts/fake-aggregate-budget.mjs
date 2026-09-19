import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const root = process.env.ECORP_AGGREGATE_FIXTURE_ROOT
const runId = args.get('--run-id')
const workspace = args.get('--workdir')
assert.ok(root && path.isAbsolute(root) && runId && workspace, 'owned fixture configuration required')
assert.match(args.get('--mission'), /\[budget-late-completion\]/u)
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
await mkdir(path.join(root, 'ready'), { recursive: true })
await mkdir(path.join(root, 'controls'), { recursive: true })
await mkdir(path.join(root, 'attempts'), { recursive: true })
await writeFile(path.join(root, 'ready', `${runId}.json`), JSON.stringify({
  run_id: runId, pid: process.pid, workspace,
}))
emit({ type: 'status', status: 'working', station: 'terminal', message: 'Waiting at owned concurrent-run barrier' })
let finishing = false
async function finish(stage) {
  if (finishing) return
  finishing = true
  await writeFile(path.join(workspace, 'result.md'), `# Aggregate budget fixture\n${'Bounded native evidence. '.repeat(30)}\n`)
  await writeFile(path.join(root, 'attempts', `${runId}.json`), JSON.stringify({
    run_id: runId, stage, artifact_attempted: true, completion_attempted: true,
  }))
  emit({ type: 'artifact', path: 'result.md', media_type: 'text/markdown' })
  emit({ type: 'completed', summary: `Fixture attempted completion after ${stage}` })
  clearInterval(timer)
  clearTimeout(deadline)
  input.close()
}
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const control = JSON.parse(line)
  if (control.type === 'circuit_breaker' && ['suspend', 'stop'].includes(control.stage)) {
    void finish(control.stage)
  }
})
let consumed = false
let polling = false
const timer = setInterval(async () => {
  if (consumed || finishing || polling) return
  polling = true
  try {
    let control
    try { control = JSON.parse(await readFile(path.join(root, 'controls', `${runId}.json`), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error }
    if (finishing) return
    consumed = true
    if (control.complete) await finish('healthy')
    else emit({ type: 'usage', input_tokens: control.tokens, output_tokens: 0, cost_microusd: 0 })
  } finally {
    polling = false
  }
}, 50)
const deadline = setTimeout(() => {
  emit({ type: 'failed', error: 'Owned concurrent fixture barrier exceeded 30 seconds' })
  clearInterval(timer)
  input.close()
}, 30_000)
