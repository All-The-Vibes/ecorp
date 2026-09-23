import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { branchRef } from './git-ref.mjs'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fields = (value, names) => Object.fromEntries(names.map((name) => [name, value[name] ?? null]))
const repositoryName = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)

function validDetail(row, operation) {
  if (!Number.isSafeInteger(row.id) || row.id < 1) return false
  const text = (value) => typeof value === 'string' && value.length > 0
  // Validate only fingerprint inputs, not GitHub's full response schema.
  switch (operation) {
    case 'reviews':
      return (row.commit_id === null || text(row.commit_id)) && text(row.state) &&
        typeof row.body === 'string' && (row.submitted_at == null || text(row.submitted_at))
    case 'review_comments':
      return text(row.commit_id) && text(row.path) && typeof row.body === 'string' && text(row.updated_at)
    case 'discussion':
      // GitHub's issue-comment body is optional (e.g. alternate media representations).
      return (row.body === undefined || typeof row.body === 'string') && text(row.updated_at)
    case 'check_runs':
      return text(row.head_sha) && text(row.name) && text(row.status) &&
        (row.conclusion === null || text(row.conclusion))
    case 'statuses':
      // The commit-status list schema does not require or normally include sha.
      return (row.sha === undefined || text(row.sha)) && text(row.context) && text(row.state)
    default:
      throw new Error('Unknown detail operation')
  }
}

class ReadFailure extends Error {
  constructor(operation, kind, message, error) {
    super(message)
    this.readFailure = {
      operation, kind,
      exitCode: Number.isSafeInteger(error?.status) ? error.status : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(error?.signal) ? error.signal : null,
    }
  }
}

// Read-only. Authentication stays in gh's credential store, not the arguments.
export function snapshot(repo, invoke = (args) => execFileSync('gh', args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
})) {
  if (!repositoryName(repo)) throw new Error('Invalid repository')
  const pages = (endpoint, operation, collection) => {
    let raw, result
    try {
      raw = invoke(['api', '--paginate', '--slurp', endpoint])
    } catch (error) {
      // execFileSync failures carry status, including null for spawn/signal failures.
      if (!(error instanceof Error) || !(error.status === null || Number.isInteger(error.status))) throw error
      throw new ReadFailure(operation, 'COMMAND_FAILED', 'Command failed', error)
    }
    try {
      result = JSON.parse(raw)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new ReadFailure(operation, 'INVALID_JSON', 'Invalid JSON response')
    }
    if (!Array.isArray(result) || result.length === 0) {
      throw new ReadFailure(operation, 'INVALID_RESPONSE', `Incomplete response: ${endpoint}`)
    }
    return result.flatMap((page) => {
      const rows = collection ? page?.[collection] : page
      if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row) ||
          (operation !== 'inventory' && !validDetail(row, operation)))) {
        throw new ReadFailure(operation, 'INVALID_RESPONSE', `Incomplete page: ${endpoint}`)
      }
      return rows
    })
  }
  const root = `repos/${repo}`
  const pulls = pages(`${root}/pulls?state=open&per_page=100`, 'inventory')
  // Validate every page and identity before any per-PR detail endpoint is read.
  for (const pr of pulls) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 ||
        typeof pr.title !== 'string' || !(pr.body === null || typeof pr.body === 'string') ||
        typeof pr.html_url !== 'string' ||
        pr.html_url.toLowerCase() !== `https://github.com/${repo.toLowerCase()}/pull/${pr.number}` ||
        !/^[a-f0-9]{40}$/.test(pr.head?.sha) || !/^[a-f0-9]{40}$/.test(pr.base?.sha) ||
        !branchRef(pr.base?.ref) || !branchRef(pr.head?.ref) || typeof pr.draft !== 'boolean' ||
        !repositoryName(pr.base?.repo?.full_name) ||
        pr.base.repo.full_name.toLowerCase() !== repo.toLowerCase() || pr.state !== 'open' ||
        !(pr.head?.repo === null || repositoryName(pr.head?.repo?.full_name))) {
      throw new ReadFailure('inventory', 'INVALID_RESPONSE', 'Invalid or out-of-scope PR')
    }
  }
  if (new Set(pulls.map((pr) => pr.number)).size !== pulls.length) {
    throw new ReadFailure('inventory', 'INVALID_RESPONSE', 'Duplicate PR')
  }
  const prs = pulls.map((pr) => {
    const identity = {
      number: pr.number, base: pr.base.sha, baseRef: pr.base.ref, head: pr.head.sha,
      sourceRepo: pr.head.repo === null ? null : pr.head.repo.full_name, branch: pr.head.ref,
      state: 'open', draft: pr.draft, url: pr.html_url,
    }
    try {
      const reviews = pages(`${root}/pulls/${pr.number}/reviews?per_page=100`, 'reviews')
      const comments = pages(`${root}/pulls/${pr.number}/comments?per_page=100`, 'review_comments')
      const discussion = pages(`${root}/issues/${pr.number}/comments?per_page=100`, 'discussion')
      const checks = pages(`${root}/commits/${pr.head.sha}/check-runs?per_page=100`, 'check_runs', 'check_runs')
      const statuses = pages(`${root}/commits/${pr.head.sha}/statuses?per_page=100`, 'statuses')
      const stable = (rows, names) => rows.map((row) => fields(row, names))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return {
        ...identity,
        reviewKey: digest({
          body: pr.body, title: pr.title,
          reviews: stable(reviews, ['id', 'commit_id', 'state', 'body', 'submitted_at']),
          comments: stable(comments, ['id', 'commit_id', 'path', 'body', 'updated_at']),
          discussion: stable(discussion, ['id', 'body', 'updated_at']),
        }),
        gateKey: digest({
          draft: pr.draft, base: pr.base.sha, baseRef: pr.base.ref,
          checks: stable(checks, ['id', 'head_sha', 'name', 'status', 'conclusion']),
          statuses: stable(statuses, ['id', 'sha', 'context', 'state']),
        }),
      }
    } catch (error) {
      if (!(error instanceof ReadFailure)) throw error
      const readError = 'DETAIL_READ_FAILED', key = digest(readError)
      return { ...identity, readError, readFailure: error.readFailure,
        reviewKey: key, gateKey: digest([readError, pr.base.ref]) }
    }
  })
  // Complete open PR inventory; individual PR evidence may be unreadable.
  return { complete: true, prs }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: executor-snapshot.mjs OWNER/REPO')
    console.log(JSON.stringify(snapshot(process.argv[2]), null, 2))
  } catch (error) {
    const failure = error instanceof ReadFailure ? error.readFailure : null
    console.error(JSON.stringify(failure
      ? { operation: failure.operation, kind: failure.kind, status: failure.exitCode, signal: failure.signal }
      : { operation: 'snapshot', kind: 'INTERNAL', status: null, signal: null,
        errorType: [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError, Error]
          .find((type) => error instanceof type)?.name ?? null }))
    process.exitCode = 1
  }
}
