import { VerificationPolicyEditor } from './VerificationPolicyEditor'
import { contractListLabels, revisionChanges } from './contractRevision'
import type { ContractRevisionDraft, RevisionContract, RevisionPolicy } from './contractRevision'

type DraftPatch = Partial<Pick<ContractRevisionDraft, 'contractJson' | 'policyJson'>>
const displayValue = (value: unknown) => value === undefined ? 'Not supplied'
  : typeof value === 'string' ? value || '(empty)' : JSON.stringify(value, null, 2)
const authorityFields = ['source_repository', 'source_base_ref', 'source_base_commit', 'workspace_connection_id',
  'budget_tokens', 'budget_cost_microusd', 'deadline_at', 'secret_refs', 'model',
  'reasoning_effort', 'deliverable'] as const

// This leaf edits a draft only. App owns scope, persistence, authority and mutations.
export function ContractRevisionEditor({
  draft, contract, policy, errors, disabled, idPrefix, onChange,
}: {
  draft: ContractRevisionDraft
  contract: RevisionContract | null
  policy: RevisionPolicy | null
  errors: Record<string, string>
  disabled: boolean
  idPrefix: string
  onChange: (patch: DraftPatch) => void
}) {
  const changeContract = (patch: Partial<RevisionContract>) => {
    if (!disabled && contract) onChange({ contractJson: JSON.stringify({ ...contract, ...patch }, null, 2) })
  }
  const changes = revisionChanges(draft.before, draft.description, contract, policy)
  const authorityErrors = authorityFields.filter(key => errors[key])
  const exactContractErrors = [...(errors.contract ? ['contract'] : []), ...authorityErrors]
  const fieldError = (key: string) => errors[key]
    ? <small className="contract-error" id={idPrefix + '-' + key + '-error'}>{errors[key]}</small> : null
  return (
    <div className="contract-revision-editor">
      <fieldset disabled={disabled}>
        <legend>Task contract</legend>
        {contract ? <>
          {([
            ['objective', 'Task objective', 6],
            ['expected_output', 'Expected output', 3],
            ['escalation', 'When to escalate', 2],
          ] as const).map(([key, label, rows]) => (
            <label key={key}>{label}
              <textarea rows={rows} value={contract[key]}
                aria-invalid={Boolean(errors[key])}
                aria-describedby={errors[key] ? idPrefix + '-' + key + '-error' : undefined}
                onChange={event => changeContract({ [key]: event.target.value })} />
              {fieldError(key)}
            </label>
          ))}
          {(Object.keys(contractListLabels) as (keyof typeof contractListLabels)[]).map(key => (
            <fieldset className="contract-revision-list" key={key}>
              <legend>{contractListLabels[key]}</legend>
              {contract[key].map((value, index) => (
                <div className="contract-revision-entry" key={index}>
                  <label>{contractListLabels[key]} {index + 1}
                    <textarea rows={2} value={value}
                      aria-invalid={Boolean(errors[key])}
                      aria-describedby={errors[key] ? idPrefix + '-' + key + '-error' : undefined}
                      onChange={event => changeContract({
                        [key]: contract[key].map((entry, i) => i === index ? event.target.value : entry),
                      })} />
                  </label>
                  <button className="button button-quiet" type="button"
                    aria-label={'Remove ' + contractListLabels[key].toLowerCase() + ' ' + (index + 1)}
                    onClick={event => {
                      const group = event.currentTarget.closest('fieldset')
                      changeContract({ [key]: contract[key].filter((_, i) => i !== index) })
                      window.requestAnimationFrame(() => {
                        const fields = group?.querySelectorAll('textarea')
                        const target = fields?.[Math.min(index, fields.length - 1)] ?? group?.querySelector<HTMLButtonElement>('[data-add-entry]')
                        target?.focus()
                      })
                    }}>Remove</button>
                </div>
              ))}
              {fieldError(key)}
              <button type="button" className="button button-secondary" data-add-entry
                disabled={contract[key].length >= 64}
                onClick={event => {
                  const group = event.currentTarget.closest('fieldset')
                  changeContract({ [key]: [...contract[key], ''] })
                  window.requestAnimationFrame(() => {
                    const fields = group?.querySelectorAll('textarea')
                    fields?.[fields.length - 1]?.focus()
                  })
                }}>Add {contractListLabels[key].toLowerCase()} entry</button>
            </fieldset>
          ))}
          {authorityErrors.length ? <p className="contract-error" role="status">
            Correct these fields in advanced JSON: {authorityErrors.map(key => key.replaceAll('_', ' ')).join(', ')}.
          </p> : null}
          <details className="contract-authority-details" open={authorityErrors.length > 0 || undefined}>
            <summary>Source, budget and execution authority</summary>
            <p>These values remain unchanged when you edit the guided fields. Resume preserves source,
              connection, budget, secrets, model, reasoning and deliverable authority.
              Mission budget recovery uses the existing budget controls.</p>
            <dl>
              {authorityFields.map(key => (
                <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd><pre>{displayValue(contract[key])}</pre>{fieldError(key)}</dd></div>
              ))}
            </dl>
          </details>
        </> : <p className="contract-error">Correct the task contract in the advanced JSON editor to restore the guided fields.</p>}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Completion evidence</legend>
        <p>Review each verifier change below. Saving never accepts evidence or weakens a gate automatically.</p>
        {policy ? <VerificationPolicyEditor
          idPrefix={idPrefix}
          policy={{ ...policy, manual_gate: policy.manual_gate ?? null }}
          onChange={changed => {
            if (disabled) return
            // Preserve an omitted optional gate until the operator actually changes it.
            const value: RevisionPolicy = { ...changed }
            if (!Object.hasOwn(policy, 'manual_gate') && value.manual_gate === null) delete value.manual_gate
            onChange({ policyJson: JSON.stringify(value, null, 2) })
          }}
        /> : <p className="contract-error">Correct the policy in the advanced JSON editor to restore the verifier fields.</p>}
        {fieldError('policy')}
      </fieldset>
      <details className="contract-exact-editor" open={!contract || !policy || Boolean(errors.contract) || undefined}>
        <summary>Advanced: exact JSON</summary>
        <p>Every supported field is retained. These editors use the same draft as the guided fields.
          Secret references contain IDs and scope only; never enter secret values.</p>
        <fieldset disabled={disabled}>
          <legend>Exact revision values</legend>
          <label>Typed task contract · JSON
            <textarea className="contract-json-editor" rows={16} value={draft.contractJson} spellCheck={false}
              aria-invalid={exactContractErrors.length > 0}
              aria-describedby={exactContractErrors.map(key => idPrefix + '-' + key + '-error').join(' ') || undefined}
              onChange={event => onChange({ contractJson: event.target.value })} />
            {fieldError('contract')}
          </label>
          <label>Typed verifier policy · JSON
            <textarea className="contract-json-editor" rows={12} value={draft.policyJson} spellCheck={false}
              aria-invalid={Boolean(errors.policy)}
              aria-describedby={errors.policy ? idPrefix + '-policy-error' : undefined}
              onChange={event => onChange({ policyJson: event.target.value })} />
          </label>
        </fieldset>
      </details>
      <section className="contract-change-summary" aria-labelledby={idPrefix + '-changes'}>
        <h4 id={idPrefix + '-changes'}>Before and after</h4>
        <p>Compared with task contract v{draft.target.version} and mission specification v{draft.target.missionVersion}.
          The server normalizes the mission description and composes it with the task objective when saving.</p>
        {!contract || !policy ? <p className="contract-error">The summary is incomplete until the exact JSON is valid.</p> : null}
        {changes.length ? <dl>{changes.map(change => (
          <div key={change.field}>
            <dt>{change.field}</dt>
            <dd className="contract-change-pair">
              <div><strong>Before</strong><pre>{displayValue(change.before)}</pre></div>
              <div><strong>After</strong><pre>{displayValue(change.after)}</pre></div>
            </dd>
          </div>
        ))}</dl> : <p>No contract, policy or description changes yet.</p>}
      </section>
    </div>
  )
}
