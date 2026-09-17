import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fields = (value, names) => Object.fromEntries(names.map((name) => [name, value[name] ?? null]))

// Read-only. Authentication stays in gh's credential store, not the arguments.
export function snapshot(repo, invoke = (args) => execFileSync('gh', args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
})) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository')
  const pages = (endpoint, collection) => {
    const result = JSON.parse(invoke(['api', '--paginate', '--slurp', endpoint]))
    if (!Array.isArray(result) || result.length === 0) throw new Error(`Incomplete response: ${endpoint}`)
    return result.flatMap((page) => {
      const rows = collection ? page[collection] : page
      if (!Array.isArray(rows)) throw new Error(`Incomplete page: ${endpoint}`)
      return rows
    })
  }
  const root = `repos/${repo}`
  const pulls = pages(`${root}/pulls?state=open&per_page=100`)
  const prs = pulls.map((pr) => {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 ||
        !/^[a-f0-9]{40}$/.test(pr.head?.sha) || !/^[a-f0-9]{40}$/.test(pr.base?.sha) ||
        pr.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || pr.state !== 'open') {
      throw new Error('Invalid or out-of-scope PR')
    }
    const identity = {
      number: pr.number, base: pr.base.sha, head: pr.head.sha,
      sourceRepo: pr.head.repo?.full_name ?? null, branch: pr.head.ref,
      state: 'open', draft: pr.draft, url: pr.html_url,
    }
    try {
      const reviews = pages(`${root}/pulls/${pr.number}/reviews?per_page=100`)
      const comments = pages(`${root}/pulls/${pr.number}/comments?per_page=100`)
      const discussion = pages(`${root}/issues/${pr.number}/comments?per_page=100`)
      const checks = pages(`${root}/commits/${pr.head.sha}/check-runs?per_page=100`, 'check_runs')
      const statuses = pages(`${root}/commits/${pr.head.sha}/statuses?per_page=100`)
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
          draft: pr.draft, base: pr.base.sha,
          checks: stable(checks, ['id', 'head_sha', 'name', 'status', 'conclusion']),
          statuses: stable(statuses, ['id', 'sha', 'context', 'state']),
        }),
      }
    } catch {
      const readError = 'DETAIL_READ_FAILED', key = digest(readError)
      return { ...identity, readError, reviewKey: key, gateKey: key }
    }
  })
  if (new Set(prs.map((pr) => pr.number)).size !== prs.length) throw new Error('Duplicate PR')
  // Complete open PR inventory; individual PR evidence may be unreadable.
  return { complete: true, prs }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: executor-snapshot.mjs OWNER/REPO')
    console.log(JSON.stringify(snapshot(process.argv[2]), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
