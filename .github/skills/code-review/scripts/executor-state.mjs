// Single designated host only. No scheduler, Git/model invocation, remote effects,
// stale-lock recovery, or proof authenticity claims. Keep STATE_DIR outside Git.
// CLI: node executor-state.mjs STATE_DIR COMMAND; JSON stdin except show; JSON stdout.
// init {owner,repo,model:"gpt-6-astra",policySha:40hex,canary:positiveInteger}
// sync {owner,complete:true,prs:[{number,base,head,reviewKey,gateKey,sourceRepo,branch,state,draft?,url?,readError?}]}
// readError, when present, is exactly "DETAIL_READ_FAILED" and blocks that PR only.
// next {owner} -> durable claim (action audit/check), blocked, or none.
// begin {owner,number,claimId,base,head} -> same claim with charged round.
// published {owner,number,claimId,base,head,snapshot,push,reviewers}
//   head is the expected OLD remote head; snapshot is actual selected-PR readback
//   at NEW head. Candidate reviewers predate push. This records, never performs,
//   an authorized push; retains round/start and supports exact retry acknowledgement.
// save {owner,number,claimId,base,head,phase,evidence,findings,technicalVerdict,reason,reviewers?}
// Phases: auditing/fixing/reviewing/waiting/blocked/complete. Verdict: null/NAUGHTY/NICE.
// NICE needs reviewers and ends technical work (complete or waiting for external gates).
// Findings: {id,status:"open"|"fixed",evidence:[paths]}; fixed requires evidence.
// Reviewer: {reviewerId,model,base,head,verdict:"NICE",completedAt,sourceRef,
//            criteria:[{id,result:"PASS",sourceRef}]}; exactly two fresh identities.
// enable {owner,acceptanceProof:{number,base,head,reviewers:[same saved receipts],
//   ci:{base,head,status:"passed",sourceRef,verifiedAt},
//   push:{repo,branch,before,head,sourceRef,pushedAt},
//   schedulerWake:{id,at,sourceRef},resumeRef,quietNoopRef,
//   copilot:{reviewId,head,automatic:true,sourceRef},audits:{atvRef,ponytailRef},
//   fixers:[{issueId,agentId,model:"gpt-6-astra",sourceRef,redRef,greenRef}]}}
// help: node executor-state.mjs help (or STATE_DIR help), no stdin/state access.
// Timestamps are ISO UTC; sourceRefs are retained paths/URLs, not verified artifacts.
// sync accepts a complete empty inventory. Gate-only changes preserve active work;
// conflicting revisions return next.action=reconcile until published or save blocked
// with ORIGINAL claim/base/head. No stale claim is silently discarded.
// A charged round pessimistically counts as no progress until a terminal save
// proves an existing open finding fixed. Interrupted rounds therefore cannot vanish.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const check = (ok, message) => { if (!ok) throw new Error(message) }
const text = (s) => typeof s === 'string' && s.trim().length > 0
const hex = (s, size = 40) => typeof s === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(s)
const positive = (n) => Number.isSafeInteger(n) && n > 0
const object = (o) => o !== null && typeof o === 'object' && !Array.isArray(o)
function fields(o, required, optional = []) {
  check(object(o) && required.every((k) => Object.hasOwn(o, k)) &&
    Object.keys(o).every((k) => [...required, ...optional].includes(k)), 'missing or unknown fields')
}
const digest = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')
const refs = (a) => Array.isArray(a) && a.every(text)
const same = (a, b) => a.base === b.base && a.head === b.head
const auditKey = (p) => digest([p.base, p.head, p.reviewKey, p.sourceRepo?.toLowerCase(), p.branch, p.state, p.readError ?? null])
const signature = (p) => digest([auditKey(p), p.gateKey, p.draft ?? false, p.url ?? null])
const current = (a, p) => p.present && auditKey(a.snapshot) === auditKey(p.snapshot)
const cycle = (p) => p.cycles.at(-1)
const freshCycle = () => ({ rounds: 0, noProgress: 0, findings: [], evidence: [], reason: null, phase: 'pending', technicalVerdict: null, completion: null })
const repoName = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const timestamp = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
const fresh = (s, start, end) => timestamp(s) && s >= start && s <= end
function validateSnapshot(p) {
  fields(p, ['number', 'base', 'head', 'reviewKey', 'gateKey', 'sourceRepo', 'branch', 'state'], ['draft', 'url', 'readError'])
  check(positive(p.number) && hex(p.base) && hex(p.head) && hex(p.reviewKey, 64) &&
    hex(p.gateKey, 64) && (p.sourceRepo === null || repoName(p.sourceRepo)) && text(p.branch) &&
    ['open', 'closed', 'merged'].includes(p.state) &&
    (p.draft === undefined || typeof p.draft === 'boolean') &&
    (p.url === undefined || text(p.url)) &&
    (p.readError === undefined || p.readError === 'DETAIL_READ_FAILED'), 'invalid PR inventory fields')
}
function validateReviewers(receipts, claim, config, at) {
  check(Array.isArray(receipts) && receipts.length === 2, 'NICE requires two reviewer receipts')
  check(new Set(receipts.map((r) => r?.reviewerId)).size === 2, 'duplicate reviewer IDs')
  for (const r of receipts) {
    fields(r, ['reviewerId', 'model', 'base', 'head', 'verdict', 'completedAt', 'sourceRef', 'criteria'])
    check(text(r.reviewerId) && r.reviewerId !== config.owner && r.model === config.model &&
      same(r, claim) && r.verdict === 'NICE' && text(r.sourceRef) &&
      fresh(r.completedAt, claim.startedAt, at), 'malformed or stale reviewer receipt')
    check(Array.isArray(r.criteria) && r.criteria.length > 0 &&
      new Set(r.criteria.map((c) => c.id)).size === r.criteria.length, 'missing or duplicate criteria')
    for (const c of r.criteria) {
      fields(c, ['id', 'result', 'sourceRef'])
      check(text(c.id) && c.result === 'PASS' && text(c.sourceRef), 'NICE criterion is not PASS with evidence')
    }
  }
  check(digest(receipts[0].criteria.map((c) => c.id).sort()) ===
    digest(receipts[1].criteria.map((c) => c.id).sort()), 'reviewer rubric mismatch')
  check(receipts[0].sourceRef !== receipts[1].sourceRef, 'reviewers need distinct source references')
}

function apply(s, e) {
  const { command, input: i, at, id } = e
  if (command === 'init') {
    check(s === null, 'already initialized; immutable configuration')
    fields(i, ['owner', 'repo', 'model', 'policySha', 'canary'])
    check(text(i.owner) && repoName(i.repo) && i.model === 'gpt-6-astra' &&
      hex(i.policySha) && positive(i.canary), 'invalid immutable configuration')
    return { state: { config: i, enabled: false, acceptanceProof: null, prs: {}, active: null, sequence: 0, usedReviewers: [] }, output: { initialized: true } }
  }
  check(s && i.owner === s.config.owner, 'owner mismatch or missing initialization')
  let output = { ok: true }, changed = true
  if (command === 'sync') {
    fields(i, ['owner', 'complete', 'prs'])
    check(i.complete === true && Array.isArray(i.prs), 'partial inventory')
    check(new Set(i.prs.map((p) => p.number)).size === i.prs.length, 'duplicate PR number')
    i.prs.forEach(validateSnapshot)
    const inventoryKey = (rows) => digest(rows.slice().sort((a, b) => a.number - b.number).map((p) => [p.number, signature(p)]))
    changed = inventoryKey(i.prs) !== inventoryKey(Object.values(s.prs).filter((p) => p.present).map((p) => p.snapshot))
    if (changed) {
      for (const p of Object.values(s.prs)) p.present = false
      for (const p of i.prs) {
        s.prs[p.number] ??= { snapshot: p, sourceRepo: p.sourceRepo, present: true, seen: null, seenAudit: null, selected: 0, cycles: [freshCycle()] }
        s.prs[p.number].sourceRepo ??= p.sourceRepo
        Object.assign(s.prs[p.number], { snapshot: p, present: true })
        s.prs[p.number].blockedReason = p.readError ? 'DETAIL_READ_FAILED: PR detail evidence unavailable' :
          !sameRepo(p.sourceRepo, s.config.repo) ? 'fork or deleted source: privileged execution blocked' :
          !sameRepo(p.sourceRepo, s.prs[p.number].sourceRepo) ? 'source repository mismatch: privileged execution blocked' : null
      }
    }
  } else if (command === 'next') {
    fields(i, ['owner'])
    if (s.active) {
      const p = s.prs[s.active.number], stale = !current(s.active, p)
      return { state: s, output: { ...s.active, evidence: cycle(p).evidence, findings: cycle(p).findings,
        action: stale ? 'reconcile' : s.active.action, reason: stale ? 'active revision changed; preserve and reconcile' : cycle(p).reason }, changed: false }
    }
    const p = Object.values(s.prs).filter((p) => p.present && p.snapshot.state === 'open' &&
      (s.enabled || p.snapshot.number === s.config.canary) && p.seen !== signature(p.snapshot))
      .sort((a, b) => a.selected - b.selected || a.snapshot.number - b.snapshot.number)[0]
    if (!p) return { state: s, output: { action: 'none' }, changed: false }
    const c = cycle(p), snapshot = p.snapshot
    const action = p.seenAudit === auditKey(snapshot) ? 'check' : 'audit'
    const renewed = c.technicalVerdict === 'NICE' && c.completion.head !== snapshot.head
    const reason = p.blockedReason ?? (
      !renewed && action === 'audit' && c.rounds >= 3 ? 'round limit exhausted' :
      !renewed && action === 'audit' && c.noProgress >= 2 ? 'no-progress limit exhausted' : null)
    Object.assign(p, { seen: signature(snapshot), seenAudit: auditKey(snapshot), selected: ++s.sequence })
    output = { number: snapshot.number, base: snapshot.base, head: snapshot.head,
      action: reason ? 'blocked' : action, reason, claimId: reason ? null : id }
    if (!reason) s.active = { ...output, snapshot, round: null, startedAt: null, baseline: [], publication: null }
    output = s.active ?? output
  } else if (command === 'published') {
    fields(i, ['owner', 'number', 'claimId', 'base', 'head', 'snapshot', 'push', 'reviewers'])
    const a = s.active, p = s.prs[i.number]
    check(a && a.number === i.number && a.claimId === i.claimId && a.round !== null, 'publication requires active charged claim')
    if (a.publication && digest(a.publication) === digest(i)) return { state: s, output: a, changed: false }
    validateSnapshot(i.snapshot)
    fields(i.push, ['repo', 'branch', 'before', 'head', 'sourceRef', 'pushedAt'])
    check(same(a, i) && i.snapshot.number === i.number && i.snapshot.base === a.base &&
      i.snapshot.head !== a.head && i.snapshot.state === 'open' && !i.snapshot.readError &&
      sameRepo(i.snapshot.sourceRepo, s.config.repo) && sameRepo(p.sourceRepo, s.config.repo) &&
      i.snapshot.branch === a.snapshot.branch && p.present &&
      (current(a, p) || signature(p.snapshot) === signature(i.snapshot)), 'publication readback conflicts with retained claim/inventory')
    validateReviewers(i.reviewers, { ...a, head: i.snapshot.head }, s.config, at)
    check(i.reviewers.every((r) => !s.usedReviewers.includes(r.reviewerId)), 'reviewer IDs must be fresh')
    check(sameRepo(i.push.repo, s.config.repo) && i.push.branch === a.snapshot.branch &&
      i.push.before === a.head && i.push.head === i.snapshot.head && text(i.push.sourceRef) &&
      fresh(i.push.pushedAt, a.startedAt, at) && i.reviewers.every((r) => r.completedAt <= i.push.pushedAt), 'push needs exact old/new head and preceding reviews')
    Object.assign(p, { snapshot: i.snapshot, seen: signature(i.snapshot), seenAudit: auditKey(i.snapshot) })
    Object.assign(a, { head: i.snapshot.head, snapshot: i.snapshot, publication: i })
    output = a
  } else if (command === 'begin' || command === 'save') {
    fields(i, ['owner', 'number', 'claimId', 'base', 'head',
      ...(command === 'save' ? ['phase', 'evidence', 'findings', 'technicalVerdict', 'reason'] : [])],
    command === 'save' ? ['reviewers'] : [])
    const a = s.active, p = s.prs[i.number]
    check(a && positive(i.number) && a.number === i.number && a.claimId === i.claimId && same(a, i), 'stale or missing claim/revision')
    check(current(a, p) || (command === 'save' && i.phase === 'blocked' && i.technicalVerdict !== 'NICE'), 'stale revision; retain claim and save blocked or reconcile publication')
    let c = cycle(p)
    if (command === 'begin') {
      check(a.round === null, 'round already begun; resume with next')
      if (c.technicalVerdict === 'NICE' && c.completion.head !== a.head) {
        p.cycles.push(freshCycle())
        c = cycle(p)
      }
      check(c.rounds < 3 && c.noProgress < 2, 'round or no-progress limit exhausted')
      Object.assign(a, { round: ++c.rounds, startedAt: at, baseline: c.findings.filter((f) => f.status === 'open').map((f) => f.id) })
      c.noProgress++
      c.phase = 'auditing'
      c.technicalVerdict = null
      c.completion = null
      output = a
    } else {
      check(['auditing', 'fixing', 'reviewing', 'waiting', 'blocked', 'complete'].includes(i.phase), 'unknown phase')
      check(refs(i.evidence) && i.evidence.length > 0 && text(i.reason) &&
        [null, 'NAUGHTY', 'NICE'].includes(i.technicalVerdict), 'invalid evidence, reason or verdict')
      check(a.round !== null || ['waiting', 'blocked'].includes(i.phase), 'audit/review requires begin')
      check(Array.isArray(i.findings) && new Set(i.findings.map((f) => f.id)).size === i.findings.length, 'invalid findings')
      for (const f of i.findings) {
        fields(f, ['id', 'status', 'evidence'])
        check(text(f.id) && ['open', 'fixed'].includes(f.status) && refs(f.evidence) &&
          (f.status !== 'fixed' || f.evidence.length > 0), 'fixed finding needs evidence')
      }
      check(c.findings.every((f) => i.findings.some((g) => g.id === f.id &&
        f.evidence.every((ref) => g.evidence.includes(ref)))), 'findings/evidence cannot be dropped')
      if (a.round === null) check(digest(c.findings) === digest(i.findings) && i.technicalVerdict === null, 'gate check cannot change audit results')
      check(i.phase !== 'complete' || i.technicalVerdict === 'NICE', 'complete requires structured NICE')
      if (i.technicalVerdict === 'NICE') {
        check(['complete', 'waiting'].includes(i.phase), 'NICE must complete technical work')
        check(i.findings.every((f) => f.status === 'fixed'), 'open findings prevent NICE')
        validateReviewers(i.reviewers, a, s.config, at)
        if (a.publication) check(digest(i.reviewers) === digest(a.publication.reviewers), 'NICE must retain published candidate reviewers')
        check(i.reviewers.every((r) => !s.usedReviewers.includes(r.reviewerId)), 'reviewer IDs must be fresh')
        s.usedReviewers.push(...i.reviewers.map((r) => r.reviewerId))
        c.completion = { base: a.base, head: a.head, startedAt: a.startedAt, reviewers: i.reviewers }
      } else check(i.reviewers === undefined, 'reviewers only accepted with structured NICE')
      const terminal = ['waiting', 'blocked', 'complete'].includes(i.phase)
      if (a.round !== null) a.baseline = [...new Set([...a.baseline, ...i.findings.filter((f) => f.status === 'open').map((f) => f.id)])]
      if (terminal && a.round !== null && i.findings.some((f) => f.status === 'fixed' && a.baseline.includes(f.id))) c.noProgress = 0
      c.findings = i.findings
      Object.assign(c, { evidence: i.evidence, reason: i.reason, phase: i.phase })
      // Gate-only saves preserve the previous technical result and completion receipt.
      if (a.round !== null) c.technicalVerdict = i.technicalVerdict
      if (terminal) {
        if (current(a, p)) p.seen = signature(p.snapshot)
        s.active = null
      }
    }
  } else if (command === 'enable') {
    fields(i, ['owner', 'acceptanceProof'])
    const proof = i.acceptanceProof
    fields(proof, ['number', 'base', 'head', 'reviewers', 'ci', 'push',
      'schedulerWake', 'resumeRef', 'quietNoopRef', 'copilot', 'audits', 'fixers'])
    const p = s.prs[proof.number], c = p && cycle(p)
    check(!s.active && proof.number === s.config.canary && p?.present && !p.blockedReason && p.snapshot.state === 'open' &&
      sameRepo(p.snapshot.sourceRepo, s.config.repo) && c.technicalVerdict === 'NICE' && same(proof, p.snapshot) &&
      same(proof, c.completion), 'canary needs current technical NICE')
    validateReviewers(proof.reviewers, c.completion, s.config, at)
    check(digest(proof.reviewers) === digest(c.completion.reviewers), 'acceptance reviewers differ from saved NICE')
    fields(proof.ci, ['base', 'head', 'status', 'sourceRef', 'verifiedAt'])
    fields(proof.push, ['repo', 'branch', 'before', 'head', 'sourceRef', 'pushedAt'])
    check(same(proof.ci, proof) && proof.ci.status === 'passed' && text(proof.ci.sourceRef) &&
      fresh(proof.ci.verifiedAt, c.completion.startedAt, at), 'verified current CI receipt required')
    check(sameRepo(proof.push.repo, s.config.repo) && proof.push.branch === p.snapshot.branch &&
      proof.push.head === proof.head && hex(proof.push.before) && proof.push.before !== proof.head &&
      text(proof.push.sourceRef) && fresh(proof.push.pushedAt, c.completion.startedAt, at), 'real current push receipt required')
    fields(proof.schedulerWake, ['id', 'at', 'sourceRef'])
    fields(proof.copilot, ['reviewId', 'head', 'automatic', 'sourceRef'])
    fields(proof.audits, ['atvRef', 'ponytailRef'])
    check(text(proof.schedulerWake.id) && fresh(proof.schedulerWake.at, c.completion.startedAt, at) &&
      text(proof.schedulerWake.sourceRef) && text(proof.resumeRef) && text(proof.quietNoopRef), 'native wake/resume/quiet evidence required')
    check(positive(proof.copilot.reviewId) && proof.copilot.head === proof.head &&
      proof.copilot.automatic === true && text(proof.copilot.sourceRef), 'automatic current-head Copilot review required')
    check(text(proof.audits.atvRef) && text(proof.audits.ponytailRef) &&
      Array.isArray(proof.fixers) && proof.fixers.length > 0, 'audit and issue-fixer evidence required')
    for (const f of proof.fixers) {
      fields(f, ['issueId', 'agentId', 'model', 'sourceRef', 'redRef', 'greenRef'])
      check(text(f.issueId) && text(f.agentId) && f.agentId !== s.config.owner &&
        !proof.reviewers.some((r) => r.reviewerId === f.agentId) && f.model === s.config.model &&
        text(f.sourceRef) && text(f.redRef) && text(f.greenRef) && f.redRef !== f.greenRef, 'independent fixer and distinct TDD receipts required')
    }
    check(!s.enabled || digest(s.acceptanceProof) === digest(proof), 'activation proof is immutable')
    changed = !s.enabled
    s.enabled = true
    s.acceptanceProof = proof
  } else throw new Error('unknown command')
  return { state: s, output, changed }
}

function outsideGit(dir) {
  // Inspect both lexical and canonical ancestors so a junction cannot hide a checkout.
  for (const root of [dir, realpathSync(existsSync(dir) ? dir : dirname(dir))]) {
    for (let p = root; ; p = dirname(p)) {
      check(!existsSync(join(p, '.git')), 'STATE_DIR must be outside Git worktrees')
      if (dirname(p) === p) break
    }
  }
}

function main() {
  const [, , target, command, ...extra] = process.argv
  if (target === 'help' || command === 'help') return { help: readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0] }
  check(target && command && extra.length === 0, 'usage: node executor-state.mjs STATE_DIR COMMAND')
  check(['init', 'sync', 'next', 'begin', 'published', 'save', 'enable', 'show'].includes(command), 'unknown command')
  const dir = resolve(target), file = join(dir, 'state.json'), lock = join(dir, 'executor.lock')
  outsideGit(dir)
  const input = command === 'show' ? null : JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''))
  if (command === 'init') {
    // Existing directories (including interrupted init) never qualify for reinitialization.
    check(!existsSync(dir), 'state directory already exists; refusing reinitialization')
    apply(null, { command, input })
    mkdirSync(dir)
  }
  check(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), 'invalid state directory')
  const token = randomUUID(), fd = openSync(lock, 'wx', 0o600)
  try {
    writeFileSync(fd, token)
    fsyncSync(fd)
    let events = [], state = null, previousAt = ''
    if (command !== 'init') {
      check(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'invalid state file')
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      fields(stored, ['version', 'events', 'sha256'])
      check(stored.version === 1 && Array.isArray(stored.events) && stored.events.length > 0 &&
        stored.sha256 === digest(stored.events), 'corrupt state; preserve and investigate')
      events = stored.events
      const ids = new Set()
      // ponytail: replay/rewrite the retained journal; checkpoint only if measured history size needs it.
      for (const e of events) {
        fields(e, ['id', 'at', 'command', 'input'])
        check(text(e.id) && !ids.has(e.id) && timestamp(e.at) && e.at >= previousAt, 'corrupt event metadata')
        ids.add(e.id)
        previousAt = e.at
        state = apply(state, e).state
      }
    }
    if (command === 'show') return { ...state, events: events.length }
    const at = new Date().toISOString()
    check(at >= previousAt, 'clock moved backwards; refusing mutation')
    const event = { id: token, at, command, input }
    const result = apply(state, event)
    if (result.changed !== false) {
      events.push(event)
      const temporary = join(dir, `state.${token}.tmp`)
      const out = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(out, JSON.stringify({ version: 1, events, sha256: digest(events) }) + '\n')
        fsyncSync(out)
      } finally { closeSync(out) }
      renameSync(temporary, file) // Never delete the old state as a rename fallback.
      if (process.platform !== 'win32') {
        const directory = openSync(dir, 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    }
    return result.output
  } finally {
    closeSync(fd)
    // Only release our exact lock; never steal, age out, or remove someone else's.
    if (readFileSync(lock, 'utf8') === token) unlinkSync(lock)
  }
}

try { console.log(JSON.stringify(main())) } catch (error) {
  console.log(JSON.stringify({ error: error.message }))
  process.exitCode = 1
}
