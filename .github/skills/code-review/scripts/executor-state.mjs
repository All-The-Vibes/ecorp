// Single designated host only. No scheduler, Git/model invocation, remote effects,
// stale-lock recovery, or proof authenticity claims. Keep STATE_DIR outside Git.
// CLI: node executor-state.mjs STATE_DIR COMMAND; JSON stdin except show; JSON stdout.
// init {owner,repo,model:"gpt-6-astra",policySha:40hex,canary:positiveInteger}
// rubric {owner,base:40hex,head:40hex,sourceRef,sha256:64hex,criteria:[criterionIds]}
//   Bind the trusted rubric source and exact set BEFORE dispatch at that base/head
//   (also required for policy deploy reviews). Immutable; exact repeats are no-ops.
//   Includes CORRECTNESS,DURABILITY,SECURITY,TEMPLATE,VERIFICATION,COMPLETENESS,
//   SIMPLICITY,TRUTHFULNESS plus any actual required rows.
//   Pre-NICE legacy init/sync/begin/save journals replay without a default rubric;
//   missing binding blocks NICE, never silently migrates partial reviewer criteria.
// deploy {owner,previousPolicySha:40hex,policySha:different40hex,reviewers:[Reviewer,Reviewer],
//   validation:{policySha,status:"passed",sourceRef,verifiedAt}}
//   Bootstrap only BEFORE enable. previousPolicySha must equal deployments[-1].policySha.
//   Reviewers retain their actual common reviewed base and head=policySha; bind
//   that exact base/head rubric first. Both reviews and validation
//   must be fresh since the last deployment. Distinct unused Astra IDs/sourceRefs,
//   structured NICE/PASS criteria required. Original config and journal stay intact;
//   deployments appends {previousPolicySha,policySha,reviewers,validation,deployedAt}.
//   Outer owner must read actual independent reviews and authorize adoption;
//   this validates structure only, never deploys files or trusts incoming PR content.
//   Deployment records, but does not consume, that exact review decision. The same
//   unchanged pair may support published/save for the same candidate and round;
//   IDs/sourceRefs cannot be rewritten or reused for a new revision/round.
//   reviewClaim captures the matching active {claimId,round}, or null for policy-only
//   reviews. A policy-only decision cannot later substitute for a new PR round.
// sync {owner,complete:true,prs:[{number,base,head,reviewKey,gateKey,sourceRepo,branch,state,baseRef?,draft?,url?,readError?,readFailure?}]}
// baseRef is optional for legacy replay; when supplied it is a nonempty target
// branch identity. Same-SHA retargets invalidate gates, not the technical audit.
// readError, when present, is exactly "DETAIL_READ_FAILED" and blocks that PR only.
// readFailure is optional ONLY with readError; exact safe fields:
//   {operation:"reviews"|"review_comments"|"discussion"|"check_runs"|"statuses",
//    kind:"COMMAND_FAILED"|"INVALID_JSON"|"INVALID_RESPONSE",exitCode:integer|null,
//    signal:"SIGTERM"|"SIGKILL"|"SIGINT"|null}. No raw diagnostics.
// next {owner,gateNumber?:positiveInteger} -> durable audit/check/read-only claim,
//   blocked, or none. gateNumber explicitly rechecks ONE waiting/blocked PR's
//   live dependencies/threads/protections even with unchanged snapshots. Driver
//   calls at most once per waiting PR per wake; there is no implicit retry scan.
//   It cannot steal active work, leave canary scope or skip pending audit input.
//   check claims forbid begin/retry/publication; save waiting/blocked with actual
//   live gate evidence. Fork targets remain read-only, never executable.
// read-only {owner,number,claimId,base,head,receipt:{reviewerId,model:"gpt-6-astra",
//   verdict:"PASS"|"FAIL"|"BLOCKED",sourceRef,completedAt}}
//   Fork/deleted/mismatched sources retain a resumable read-only claim until this
//   receipt. No begin/retry/save/published, fixers, tests, hooks or execution.
//   PASS means read-only review only, never technical NICE or execution authority.
//   Stale claims may only record BLOCKED; their newer revision remains unconsumed.
// begin {owner,number,claimId,base,head} -> same claim with charged round.
// retry {owner,number,claimId,base,head,round:expectedCurrentRound,reviewRef}
//   Requires active reviewing/NAUGHTY and reviewRef in its latest saved evidence. Call
//   BEFORE further local correction, not save waiting (which releases the claim).
//   Keeps claim/snapshot/findings/evidence; charges the next round, refreshes
//   startedAt for new reviews. Stale/replayed round is rejected, never recharged.
// resume {owner,number,claimId,base,head,round,
//   clearance:{sourceRef,verifiedAt}}
//   Explicit local/credential/tooling recovery only. save blocked retains charged
//   unfinished work at prs[number].blockedClaim; resume restores that exact claim,
//   phase, start and budget, without begin or a new round. Clearance must postdate
//   that block. Driver verifies the actual cause cleared; structure is not truth.
//   No automatic retries, competing claim, conflicting revision/source/target,
//   ordinary CI wait, completed cycle, or exhausted 3-round/2-noProgress stop.
// published {owner,number,claimId,base,head,snapshot,push,reviewers}
//   head is the expected OLD remote head; snapshot is actual selected-PR readback
//   at NEW head. Candidate reviewers predate push. This records, never performs,
//   an authorized push; retains round/start and supports exact retry acknowledgement.
//   Each publication is retained on the PR independently of later review rounds.
//   enable requires the exact canonical current-head push, never a new timestamp.
//   Pre-review reviewKey stays on the claim; readback feedback is not reviewed by
//   observing a push. A changed reviewKey returns reconcile (including exact ACK
//   retries): save blocked with that returned claim, then next/begin fresh feedback
//   work within existing bounds. Canonical publication stays retained; no new push.
// save {owner,number,claimId,base,head,phase,evidence,findings,technicalVerdict,reason,reviewers?}
// Phases: auditing/fixing/reviewing/waiting/blocked/complete. Verdict: null/NAUGHTY/NICE.
// NICE needs reviewers and ends technical work (complete or waiting for external gates).
// Completion pins the processed audit/feedback generation; enable also requires
// the current gate signature consumed by a terminal save, not merely old head NICE.
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
// A charged round pessimistically counts as no progress until a terminal save or
// retry proves an open finding fixed in that round (including newly found issues).
// Only that verified progress clears consecutive noProgress; rounds never reset.
// retry stops at the original 3-round/2-noProgress bounds; interrupted rounds stay.
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
// Legacy journals did not record a target. Do not invent one retroactively;
// a first observation still needs a gate check, unlike a known-target conflict.
const targetCompatible = (recorded, observed) => recorded.baseRef === undefined || recorded.baseRef === observed.baseRef
const auditKey = (p) => digest([p.base, p.head, p.reviewKey, p.sourceRepo?.toLowerCase(), p.branch, p.state, p.readError ?? null])
const signature = (p) => digest([auditKey(p), p.gateKey, p.draft ?? false, p.url ?? null,
  ...(p.readFailure ? [p.readFailure] : []), ...(p.baseRef === undefined ? [] : [p.baseRef])])
const current = (a, p) => p.present && auditKey(a.snapshot) === auditKey(p.snapshot)
const cycle = (p) => p.cycles.at(-1)
function claimOutput(a, p) {
  const stale = !current(a, p), c = cycle(p)
  return { ...a, evidence: c.evidence, findings: c.findings, action: stale ? 'reconcile' : a.action,
    reason: stale ? 'active revision changed; preserve and reconcile' : a.reason ?? c.reason }
}
const freshCycle = () => ({ rounds: 0, noProgress: 0, findings: [], evidence: [], reason: null, phase: 'pending', technicalVerdict: null, completion: null })
const repoName = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const timestamp = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
const fresh = (s, start, end) => timestamp(s) && s >= start && s <= end
function validateSnapshot(p) {
  fields(p, ['number', 'base', 'head', 'reviewKey', 'gateKey', 'sourceRepo', 'branch', 'state'], ['baseRef', 'draft', 'url', 'readError', 'readFailure'])
  check(positive(p.number) && hex(p.base) && hex(p.head) && hex(p.reviewKey, 64) &&
    hex(p.gateKey, 64) && (p.sourceRepo === null || repoName(p.sourceRepo)) && text(p.branch) &&
    ['open', 'closed', 'merged'].includes(p.state) &&
    (p.baseRef === undefined || text(p.baseRef)) &&
    (p.draft === undefined || typeof p.draft === 'boolean') &&
    (p.url === undefined || text(p.url)) &&
    (p.readError === undefined || p.readError === 'DETAIL_READ_FAILED'), 'invalid PR inventory fields')
  if (Object.hasOwn(p, 'readFailure')) {
    fields(p.readFailure, ['operation', 'kind', 'exitCode', 'signal'])
    const f = p.readFailure
    check(p.readError === 'DETAIL_READ_FAILED' &&
      ['reviews', 'review_comments', 'discussion', 'check_runs', 'statuses'].includes(f.operation) &&
      ['COMMAND_FAILED', 'INVALID_JSON', 'INVALID_RESPONSE'].includes(f.kind) &&
      (f.exitCode === null || Number.isSafeInteger(f.exitCode)) &&
      [null, 'SIGTERM', 'SIGKILL', 'SIGINT'].includes(f.signal), 'invalid safe readFailure descriptor')
  }
}
function validateReviewers(receipts, claim, s, at) {
  check(hex(claim.base) && hex(claim.head), 'invalid reviewed revision')
  const config = s.config, rubric = s.rubrics[`${claim.base}:${claim.head}`]
  check(rubric, 'bind exact trusted rubric before reviewer dispatch')
  check(Array.isArray(receipts) && receipts.length === 2, 'NICE requires two reviewer receipts')
  check(new Set(receipts.map((r) => r?.reviewerId)).size === 2, 'duplicate reviewer IDs')
  const decisions = [...s.deployments, ...Object.values(s.prs).flatMap((p) => p.publications ?? [])]
  for (const r of receipts) {
    fields(r, ['reviewerId', 'model', 'base', 'head', 'verdict', 'completedAt', 'sourceRef', 'criteria'])
    check(text(r.reviewerId) && r.reviewerId !== config.owner && r.model === config.model &&
      same(r, claim) && r.verdict === 'NICE' && text(r.sourceRef) &&
      fresh(r.completedAt, claim.startedAt, at) && r.completedAt >= rubric.boundAt, 'malformed or stale reviewer receipt')
    check(decisions.every((d) => !d.reviewers?.some((old) =>
      (old.reviewerId === r.reviewerId || old.sourceRef === r.sourceRef) &&
      (digest(old) !== digest(r) || (claim.claimId &&
        (d.reviewClaim?.claimId !== claim.claimId || d.reviewClaim?.round !== claim.round))))),
    'retained review decision cannot change candidate, receipt or round')
    check(Array.isArray(r.criteria) && r.criteria.length > 0 &&
      new Set(r.criteria.map((c) => c.id)).size === r.criteria.length, 'missing or duplicate criteria')
    for (const c of r.criteria) {
      fields(c, ['id', 'result', 'sourceRef'])
      check(text(c.id) && c.result === 'PASS' && text(c.sourceRef), 'NICE criterion is not PASS with evidence')
    }
    check(digest(r.criteria.map((c) => c.id).sort()) === digest(rubric.binding.criteria.slice().sort()), 'review must cover exact pinned rubric')
  }
  check(receipts[0].sourceRef !== receipts[1].sourceRef, 'reviewers need distinct source references')
}

function apply(s, e) {
  const { command, input: i, at, id } = e
  if (command === 'init') {
    check(s === null, 'already initialized; immutable configuration')
    fields(i, ['owner', 'repo', 'model', 'policySha', 'canary'])
    check(text(i.owner) && repoName(i.repo) && i.model === 'gpt-6-astra' &&
      hex(i.policySha) && positive(i.canary), 'invalid immutable configuration')
    return { state: { config: i, rubrics: {}, deployments: [{ policySha: i.policySha, deployedAt: at }],
      enabled: false, acceptanceProof: null, prs: {}, active: null, sequence: 0, usedReviewers: [] }, output: { initialized: true } }
  }
  check(s && i.owner === s.config.owner, 'owner mismatch or missing initialization')
  let output = { ok: true }, changed = true
  if (command === 'rubric') {
    fields(i, ['owner', 'base', 'head', 'sourceRef', 'sha256', 'criteria'])
    check(hex(i.base) && hex(i.head) && text(i.sourceRef) && hex(i.sha256, 64) &&
      refs(i.criteria) && new Set(i.criteria).size === i.criteria.length &&
      ['CORRECTNESS', 'DURABILITY', 'SECURITY', 'TEMPLATE', 'VERIFICATION', 'COMPLETENESS', 'SIMPLICITY', 'TRUTHFULNESS']
        .every((id) => i.criteria.includes(id)), 'invalid or incomplete trusted rubric')
    const key = `${i.base}:${i.head}`, old = s.rubrics[key]
    check(!old || digest(old.binding) === digest(i), 'rubric binding is immutable')
    changed = !old
    if (changed) s.rubrics[key] = { binding: i, boundAt: at }
    output = s.rubrics[key]
  } else if (command === 'deploy') {
    fields(i, ['owner', 'previousPolicySha', 'policySha', 'reviewers', 'validation'])
    const previous = s.deployments.at(-1)
    check(!s.enabled && i.previousPolicySha === previous.policySha &&
      hex(i.policySha) && i.policySha !== i.previousPolicySha, 'deployment requires pre-activation and exact previous/different new policy SHA')
    validateReviewers(i.reviewers, { base: i.reviewers?.[0]?.base, head: i.policySha, startedAt: previous.deployedAt }, s, at)
    check(i.reviewers.every((r) => !s.usedReviewers.includes(r.reviewerId) &&
      !s.deployments.some((d) => d.reviewers?.some((old) => old.sourceRef === r.sourceRef))), 'deployment reviewers and sources must be fresh')
    fields(i.validation, ['policySha', 'status', 'sourceRef', 'verifiedAt'])
    check(i.validation.policySha === i.policySha && i.validation.status === 'passed' &&
      text(i.validation.sourceRef) && fresh(i.validation.verifiedAt, previous.deployedAt, at), 'fresh exact-policy validation evidence required')
    const { owner, ...deployment } = i
    const reviewClaim = s.active?.round && s.active.base === i.reviewers[0].base
      ? { claimId: s.active.claimId, round: s.active.round } : null
    s.deployments.push({ ...deployment, deployedAt: at, reviewClaim })
    output = s.deployments.at(-1)
  } else if (command === 'sync') {
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
    fields(i, ['owner'], ['gateNumber'])
    check(i.gateNumber === undefined || positive(i.gateNumber), 'invalid gate target')
    if (s.active) {
      check(i.gateNumber === undefined || i.gateNumber === s.active.number, 'gate target cannot replace active claim')
      return { state: s, output: claimOutput(s.active, s.prs[s.active.number]), changed: false }
    }
    const target = i.gateNumber === undefined ? null : s.prs[i.gateNumber]
    if (i.gateNumber !== undefined) {
      check(target?.present && target.snapshot.state === 'open' &&
        (s.enabled || i.gateNumber === s.config.canary) &&
        (['waiting', 'blocked'].includes(cycle(target).phase) || target.blockedReason), 'gate target must be eligible and waiting/blocked')
      check(target.seenAudit === auditKey(target.snapshot), 'pending audit input must be processed before gate recheck')
    }
    const p = target ?? Object.values(s.prs).filter((p) => p.present && p.snapshot.state === 'open' &&
      (s.enabled || p.snapshot.number === s.config.canary) && p.seen !== signature(p.snapshot))
      .sort((a, b) => a.selected - b.selected || a.snapshot.number - b.snapshot.number)[0]
    if (!p) return { state: s, output: { action: 'none' }, changed: false }
    const c = cycle(p), snapshot = p.snapshot
    const readOnly = !sameRepo(snapshot.sourceRepo, s.config.repo) || !sameRepo(p.sourceRepo, s.config.repo)
    const action = target || p.seenAudit === auditKey(snapshot) ? 'check' : 'audit'
    const renewed = c.technicalVerdict === 'NICE' && c.completion.head !== snapshot.head
    const reason = p.blockedReason ?? (
      !renewed && action === 'audit' && c.rounds >= 3 ? 'round limit exhausted' :
      !renewed && action === 'audit' && c.noProgress >= 2 ? 'no-progress limit exhausted' : null)
    p.selected = ++s.sequence
    if (!readOnly) Object.assign(p, { seen: signature(snapshot), seenAudit: auditKey(snapshot) })
    output = { number: snapshot.number, base: snapshot.base, head: snapshot.head,
      action: readOnly ? 'read-only' : reason ? 'blocked' : action, reason, claimId: readOnly || !reason ? id : null }
    if (readOnly || !reason) s.active = { ...output, snapshot, round: null, startedAt: readOnly ? at : null, baseline: [], publication: null }
    output = s.active ?? output
  } else if (command === 'resume') {
    fields(i, ['owner', 'number', 'claimId', 'base', 'head', 'round', 'clearance'])
    check(!s.active, 'resume cannot replace an active claim')
    const p = s.prs[i.number], b = p?.blockedClaim, c = p && cycle(p)
    check(b && positive(i.number) && b.claim.number === i.number &&
      b.claim.claimId === i.claimId && same(b.claim, i) && b.claim.round === i.round &&
      b.cycle === p.cycles.length && c.rounds === i.round && c.technicalVerdict !== 'NICE',
    'no matching retained unfinished blocked claim/round')
    check(c.rounds < 3 && c.noProgress < 2, 'round or no-progress limit exhausted')
    check((s.enabled || i.number === s.config.canary) && current(b.claim, p) &&
      p.snapshot.state === 'open' && targetCompatible(b.claim.snapshot, p.snapshot) &&
      !p.blockedReason && sameRepo(p.sourceRepo, s.config.repo) &&
      sameRepo(p.snapshot.sourceRepo, s.config.repo), 'blocked claim revision/source/target conflicts')
    fields(i.clearance, ['sourceRef', 'verifiedAt'])
    check(text(i.clearance.sourceRef) && fresh(i.clearance.verifiedAt, b.blockedAt, at), 'fresh actual clearance evidence required')
    s.active = b.claim
    Object.assign(c, { phase: b.phase, technicalVerdict: b.technicalVerdict, reason: b.reason,
      evidence: [...new Set([...c.evidence, i.clearance.sourceRef])] })
    p.blockedClaim = null
    output = { ...s.active, evidence: c.evidence, findings: c.findings }
  } else if (command === 'read-only') {
    fields(i, ['owner', 'number', 'claimId', 'base', 'head', 'receipt'])
    const a = s.active, p = s.prs[i.number], r = i.receipt
    check(a && a.action === 'read-only' && a.number === i.number &&
      a.claimId === i.claimId && same(a, i), 'read-only requires retained exact claim')
    fields(r, ['reviewerId', 'model', 'verdict', 'sourceRef', 'completedAt'])
    check(text(r.reviewerId) && r.reviewerId !== s.config.owner && r.model === s.config.model &&
      ['PASS', 'FAIL', 'BLOCKED'].includes(r.verdict) && text(r.sourceRef) &&
      fresh(r.completedAt, a.startedAt, at), 'invalid read-only review receipt')
    check(current(a, p) || r.verdict === 'BLOCKED', 'stale read-only claim requires BLOCKED receipt')
    p.readOnlyReviews ??= []
    p.readOnlyReviews.push({ claimId: a.claimId, snapshot: a.snapshot, receipt: r })
    if (current(a, p)) Object.assign(p, { seen: signature(a.snapshot), seenAudit: auditKey(a.snapshot) })
    s.active = null
  } else if (command === 'published') {
    fields(i, ['owner', 'number', 'claimId', 'base', 'head', 'snapshot', 'push', 'reviewers'])
    const a = s.active, p = s.prs[i.number]
    check(a && a.action === 'audit' && a.number === i.number && a.claimId === i.claimId && a.round !== null, 'publication requires active charged audit claim')
    if (a.publication && digest(a.publication) === digest(i)) return { state: s, output: claimOutput(a, p), changed: false }
    validateSnapshot(i.snapshot)
    fields(i.push, ['repo', 'branch', 'before', 'head', 'sourceRef', 'pushedAt'])
    check(same(a, i) && i.snapshot.number === i.number && i.snapshot.base === a.base &&
      i.snapshot.head !== a.head && i.snapshot.state === 'open' && !i.snapshot.readError &&
      sameRepo(i.snapshot.sourceRepo, s.config.repo) && sameRepo(p.sourceRepo, s.config.repo) &&
      targetCompatible(a.snapshot, i.snapshot) && p.snapshot.baseRef === i.snapshot.baseRef &&
      i.snapshot.branch === a.snapshot.branch && p.present &&
      (current(a, p) || signature(p.snapshot) === signature(i.snapshot)), 'publication readback conflicts with retained claim/inventory')
    validateReviewers(i.reviewers, { ...a, head: i.snapshot.head }, s, at)
    check(i.reviewers.every((r) => !s.usedReviewers.includes(r.reviewerId)), 'reviewer IDs must be fresh')
    check(sameRepo(i.push.repo, s.config.repo) && i.push.branch === a.snapshot.branch &&
      i.push.before === a.head && i.push.head === i.snapshot.head && text(i.push.sourceRef) &&
      fresh(i.push.pushedAt, a.startedAt, at) && i.reviewers.every((r) => r.completedAt <= i.push.pushedAt), 'push needs exact old/new head and preceding reviews')
    const reviewedSnapshot = { ...i.snapshot, baseRef: a.snapshot.baseRef, reviewKey: a.snapshot.reviewKey }
    Object.assign(p, { snapshot: i.snapshot, seen: signature(reviewedSnapshot), seenAudit: auditKey(reviewedSnapshot) })
    p.publications ??= []
    p.publications.push({ ...i, startedAt: a.startedAt, reviewClaim: { claimId: a.claimId, round: a.round } })
    Object.assign(a, { head: i.snapshot.head, snapshot: reviewedSnapshot, publication: i })
    output = claimOutput(a, p)
  } else if (command === 'begin' || command === 'retry' || command === 'save') {
    fields(i, ['owner', 'number', 'claimId', 'base', 'head',
      ...(command === 'retry' ? ['round', 'reviewRef'] : []),
      ...(command === 'save' ? ['phase', 'evidence', 'findings', 'technicalVerdict', 'reason'] : [])],
    command === 'save' ? ['reviewers'] : [])
    const a = s.active, p = s.prs[i.number]
    check(a && positive(i.number) && a.number === i.number && a.claimId === i.claimId && same(a, i), 'stale or missing claim/revision')
    check(a.action !== 'read-only', 'read-only claim forbids execution; record read-only receipt')
    check(current(a, p) || (command === 'save' && i.phase === 'blocked' && i.technicalVerdict !== 'NICE'), 'stale revision; retain claim and save blocked or reconcile publication')
    let c = cycle(p)
    if (command === 'begin' || command === 'retry') {
      check(a.action === 'audit', 'gate checks cannot spend audit rounds')
      if (command === 'retry') {
        check(positive(i.round) && a.round === i.round && c.phase === 'reviewing' &&
          c.technicalVerdict === 'NAUGHTY' && text(i.reviewRef) && a.failureEvidence?.includes(i.reviewRef),
        'retry requires exact charged round and retained failed-review phase/evidence')
        if (c.findings.some((f) => f.status === 'fixed' && a.baseline.includes(f.id))) c.noProgress = 0
      } else check(a.round === null, 'round already begun; resume with next')
      if (command === 'begin' && c.technicalVerdict === 'NICE' && c.completion.head !== a.head) {
        p.cycles.push(freshCycle())
        c = cycle(p)
      }
      check(c.rounds < 3 && c.noProgress < 2, 'round or no-progress limit exhausted')
      Object.assign(a, { snapshot: p.snapshot, round: ++c.rounds, startedAt: at, baseline: c.findings.filter((f) => f.status === 'open').map((f) => f.id), publication: null, failureEvidence: null })
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
        validateReviewers(i.reviewers, a, s, at)
        if (a.publication) check(digest(i.reviewers) === digest(a.publication.reviewers), 'NICE must retain published candidate reviewers')
        check(i.reviewers.every((r) => !s.usedReviewers.includes(r.reviewerId)), 'reviewer IDs must be fresh')
        s.usedReviewers.push(...i.reviewers.map((r) => r.reviewerId))
        c.completion = { base: a.base, head: a.head, claimId: a.claimId, round: a.round,
          startedAt: a.startedAt, auditKey: auditKey(a.snapshot), reviewers: i.reviewers }
      } else check(i.reviewers === undefined, 'reviewers only accepted with structured NICE')
      const terminal = ['waiting', 'blocked', 'complete'].includes(i.phase)
      if (a.round !== null) a.baseline = [...new Set([...a.baseline, ...i.findings.filter((f) => f.status === 'open').map((f) => f.id)])]
      if (terminal && a.round !== null && i.findings.some((f) => f.status === 'fixed' && a.baseline.includes(f.id))) c.noProgress = 0
      c.findings = i.findings
      if (i.phase === 'reviewing' && i.technicalVerdict === 'NAUGHTY') a.failureEvidence = i.evidence
      if (i.phase === 'blocked' && a.round !== null) {
        p.blockedClaim = { claim: a, cycle: p.cycles.length, phase: c.phase,
          technicalVerdict: i.technicalVerdict ?? c.technicalVerdict, reason: c.reason, blockedAt: at }
      }
      Object.assign(c, { evidence: [...new Set([...c.evidence, ...i.evidence])], reason: i.reason, phase: i.phase })
      // Gate-only saves preserve the previous technical result and completion receipt.
      if (a.round !== null) c.technicalVerdict = i.technicalVerdict
      if (terminal) {
        if (current(a, p)) p.seen = signature(a.snapshot)
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
      same(proof, c.completion) && c.completion.auditKey === auditKey(p.snapshot) &&
      p.seen === signature(p.snapshot), 'canary needs current processed technical NICE and gates')
    validateReviewers(proof.reviewers, c.completion, s, at)
    check(digest(proof.reviewers) === digest(c.completion.reviewers), 'acceptance reviewers differ from saved NICE')
    fields(proof.ci, ['base', 'head', 'status', 'sourceRef', 'verifiedAt'])
    fields(proof.push, ['repo', 'branch', 'before', 'head', 'sourceRef', 'pushedAt'])
    check(same(proof.ci, proof) && proof.ci.status === 'passed' && text(proof.ci.sourceRef) &&
      fresh(proof.ci.verifiedAt, c.completion.startedAt, at), 'verified current CI receipt required')
    const publication = p.publications?.at(-1)
    check(publication && same(publication.snapshot, proof) &&
      publication.snapshot.branch === p.snapshot.branch &&
      digest(proof.push) === digest(publication.push), 'exact canonical current publication receipt required')
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
  check(['init', 'rubric', 'deploy', 'sync', 'next', 'read-only', 'begin', 'retry', 'resume', 'published', 'save', 'enable', 'show'].includes(command), 'unknown command')
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
