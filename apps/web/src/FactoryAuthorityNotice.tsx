import { authorityBinding, authorityEndpoint, validAuthorityId } from './factoryAuthority'
import type { ClaimAuthorityCorp } from './factoryAuthority'
import './FactoryAuthorityNotice.css'

export function FactoryAuthorityNotice({ corp, endpoint, mode, pin, namespace, hasWorkItem }: {
  corp: ClaimAuthorityCorp
  endpoint: string
  mode: string
  pin: unknown
  namespace: string
  hasWorkItem: boolean
}) {
  const binding = authorityBinding(corp, pin, hasWorkItem)
  return <details className="factory-authority" data-testid="factory-authority">
    <summary>Execution authority{binding.startsWith('Authority mismatch') ? ' - mismatch: do not dispatch' : ''}</summary>
    <dl>
      <div><dt>Control plane</dt><dd>{authorityEndpoint(endpoint)}</dd></div>
      <div><dt>Mode</dt><dd>{mode === 'production' ? 'Production authentication' : 'Development or unverified — not a shared production endpoint'}</dd></div>
      <div><dt>Corp</dt><dd>{corp.id}</dd></div>
      <div><dt>Claim authority</dt><dd>{validAuthorityId(corp.claim_authority_id) ? corp.claim_authority_id : 'Unavailable'}</dd></div>
      <div><dt>Project namespace</dt><dd>{namespace}</dd></div>
    </dl>
    <p>{binding}</p>
    <p>Shared contributors must use the same authenticated control plane, Corp and Project namespace.
      GitHub status and matching IDs on copied databases are not distributed locks.</p>
    <p>Inspect with <code>crony --server &lt;endpoint&gt; factory-authority &lt;corp-id&gt; &lt;actor-id&gt;</code> and confirm the approved authority before
      setting <code>--claim-authority-id</code>. This display does not authorize execution.</p>
  </details>
}
