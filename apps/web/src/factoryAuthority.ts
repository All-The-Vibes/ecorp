export type ClaimAuthorityCorp = { id: string; claim_authority_id?: string | null }

export async function fetchServerMode(endpoint: string, signal = AbortSignal.timeout(30_000)): Promise<'development' | 'production'> {
  const response = await fetch(`${endpoint}/health`, { signal })
  if (!response.ok) throw new Error(`Health request failed (${response.status}).`)
  const health: unknown = await response.json()
  if (typeof health !== 'object' || health === null
    || !('status' in health) || health.status !== 'ok'
    || !('mode' in health) || (health.mode !== 'development' && health.mode !== 'production')) {
    throw new Error('Server authentication mode could not be verified.')
  }
  return health.mode
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function validAuthorityId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value)
    && value !== '00000000-0000-0000-0000-000000000000'
}

export function authorityEndpoint(value: string): string {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : 'Unavailable'
  } catch { return 'Unavailable' }
}

export function authorityBinding(corp: ClaimAuthorityCorp, pin: unknown, hasWorkItem = true): string {
  if (!validAuthorityId(corp.claim_authority_id)) return 'Authority unavailable - update or verify the server'
  if (!hasWorkItem) return 'No work item selected - verify the controller pin before intake'
  if (pin === undefined) return 'Unpinned legacy policy — not evidence of shared coordination'
  if (!validAuthorityId(pin) || pin.toLowerCase() !== corp.claim_authority_id.toLowerCase()) {
    return 'Authority mismatch — do not dispatch or rebind this work'
  }
  return 'Work item pinned to this Corp ledger'
}
