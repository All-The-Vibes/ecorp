import { useState } from 'react'
import { nonEmptyLines, commaOrLines } from './formText'
import {
  appendVerifierCheck, defaultVerifierCheck, removeVerifierCheck,
  replaceVerifierCheck, setManualVerificationGate, verificationPolicyErrors,
  verificationTypeLabel, verifierCheckSummary,
} from './verificationPolicy'
import type { ManualVerificationGate, VerificationPolicy, VerifierCheck } from './verificationPolicy'

export function VerificationPolicyPreview({
  policy,
  heading = 'Completion gates',
}: {
  policy: VerificationPolicy
  heading?: string
}) {
  return (
    <div className="verification-policy-preview" data-testid="verification-policy-preview">
      <strong>{heading}</strong>
      <ol>
        {policy.checks.map((check, index) => (
          <li key={`${check.type}-${index}`}>
            <span>{index + 1}</span>
            <p>{verifierCheckSummary(check)}</p>
          </li>
        ))}
      </ol>
      <div className="verification-gate-summary">
        <span>Manual gate</span>
        <strong>
          {policy.manual_gate
            ? `${verificationTypeLabel(policy.manual_gate.type)} · ${policy.manual_gate.roles.join(', ')}`
            : 'None'}
        </strong>
        {policy.manual_gate?.type === 'independent_review' ? (
          <small>
            {policy.manual_gate.exclude_requester
              ? 'Mission requester is excluded from the decision.'
              : 'Mission requester may decide if their role is eligible.'}
          </small>
        ) : null}
      </div>
    </div>
  )
}

function VerifierCheckFields({ check, onChange }: {
  check: VerifierCheck
  onChange: (check: VerifierCheck) => void
}) {
  return (
    <>
      {check.type === 'artifact' ? (
        <label>
          Minimum artifact bytes
          <input
            type="number"
            min={1}
            value={check.min_bytes}
            onChange={(event) =>
              onChange({
                ...check,
                min_bytes: Number(event.target.value),
              })
            }
          />
        </label>
      ) : null}
      {check.type === 'file' || check.type === 'screenshot' ? (
        <div className="verification-check-grid">
          <label>
            Worktree-relative path
            <input
              value={check.path}
              onChange={(event) =>
                onChange({
                  ...check,
                  path: event.target.value,
                })
              }
              placeholder={
                check.type === 'screenshot'
                  ? 'evidence/browser.png'
                  : 'path/to/result.txt'
              }
            />
          </label>
          <label>
            Minimum bytes
            <input
              type="number"
              min={1}
              value={check.min_bytes}
              onChange={(event) =>
                onChange({
                  ...check,
                  min_bytes: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
      ) : null}
      {check.type === 'command' || check.type === 'test' ? (
        <>
          <div className="verification-check-grid">
            <label>
              Program
              <input
                value={check.program}
                onChange={(event) =>
                  onChange({
                    ...check,
                    program: event.target.value,
                  })
                }
                placeholder="pnpm"
              />
            </label>
            <label>
              Timeout in milliseconds
              <input
                type="number"
                min={100}
                max={60_000}
                value={check.timeout_ms}
                onChange={(event) =>
                  onChange({
                    ...check,
                    timeout_ms: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <label>
            Arguments, one per line
            <textarea
              rows={3}
              value={check.args.join('\n')}
              onChange={(event) =>
                onChange({
                  ...check,
                  args: nonEmptyLines(event.target.value),
                })
              }
              placeholder={'--dir\napps/web\ntest'}
            />
          </label>
        </>
      ) : null}
      {check.type === 'json_schema' ? (
        <>
          <label>
            JSON file
            <input
              value={check.path}
              onChange={(event) =>
                onChange({
                  ...check,
                  path: event.target.value,
                })
              }
              placeholder="evidence/result.json"
            />
          </label>
          <label>
            Required top-level keys
            <textarea
              rows={3}
              value={check.required_keys.join('\n')}
              onChange={(event) =>
                onChange({
                  ...check,
                  required_keys: nonEmptyLines(event.target.value),
                })
              }
            />
          </label>
        </>
      ) : null}
    </>
  )
}

function VerifierCheckEditor({ check, index, onChange, onRemove }: {
  check: VerifierCheck
  index: number
  onChange: (check: VerifierCheck) => void
  onRemove: () => void
}) {
  return (
    <fieldset className="verification-check-editor">
      <legend>Check {index + 1}</legend>
      <div className="verification-check-toolbar">
        <label>
          Type
          <select
            aria-label={`Verifier check ${index + 1} type`}
            value={check.type}
            onChange={(event) => onChange(defaultVerifierCheck(event.target.value as VerifierCheck['type']))}
          >
            <option value="artifact">Provider artifact</option>
            <option value="file">File</option>
            <option value="command">Command</option>
            <option value="test">Test</option>
            <option value="json_schema">JSON schema</option>
            <option value="screenshot">Screenshot</option>
          </select>
        </label>
        <button className="button button-quiet" type="button" onClick={onRemove}>
          Remove
        </button>
      </div>
      <VerifierCheckFields check={check} onChange={onChange} />
    </fieldset>
  )
}

function ManualGateEditor({ policy, onChange }: {
  policy: VerificationPolicy
  onChange: (policy: VerificationPolicy) => void
}) {
  return (
    <div className="manual-gate-editor">
      <label>
        Final reviewer gate
        <select
          value={policy.manual_gate?.type ?? 'none'}
          onChange={(event) =>
            onChange(setManualVerificationGate(policy, event.target.value as 'none' | ManualVerificationGate['type']))
          }
        >
          <option value="none">No manual gate</option>
          <option value="human_approval">Human approval</option>
          <option value="independent_review">Independent review</option>
        </select>
      </label>
      {policy.manual_gate ? (
        <label>
          Eligible roles
          <textarea
            rows={2}
            value={policy.manual_gate.roles.join(', ')}
            onChange={(event) =>
              onChange({
                ...policy,
                manual_gate: policy.manual_gate
                  ? {
                      ...policy.manual_gate,
                      roles: commaOrLines(event.target.value),
                    }
                  : null,
              })
            }
          />
        </label>
      ) : null}
      {policy.manual_gate?.type === 'independent_review' ? (
        <label className="mission-run-toggle">
          <input
            type="checkbox"
            checked={policy.manual_gate.exclude_requester}
            onChange={(event) =>
              onChange({
                ...policy,
                manual_gate:
                  policy.manual_gate?.type === 'independent_review'
                    ? {
                        ...policy.manual_gate,
                        exclude_requester: event.target.checked,
                      }
                    : policy.manual_gate,
              })
            }
          />
          <span>
            <strong>Exclude the mission requester</strong>
            <small>Require another operator to accept the evidence.</small>
          </span>
        </label>
      ) : null}
    </div>
  )
}

export function VerificationPolicyEditor({
  policy,
  onChange,
  idPrefix,
}: {
  policy: VerificationPolicy
  onChange: (policy: VerificationPolicy) => void
  idPrefix: string
}) {
  const [selectedCheckIndex, setSelectedCheckIndex] = useState(0)
  const selectedIndex = Math.min(
    selectedCheckIndex,
    Math.max(0, policy.checks.length - 1),
  )
  const selectedCheck = policy.checks[selectedIndex]
  const replaceCheck = (index: number, check: VerifierCheck) => {
    onChange(replaceVerifierCheck(policy, index, check))
  }
  const removeCheck = (index: number) => {
    setSelectedCheckIndex(Math.max(0, Math.min(index - 1, policy.checks.length - 2)))
    onChange(removeVerifierCheck(policy, index))
  }
  const errors = verificationPolicyErrors(policy)

  return (
    <div className="verification-policy-editor" data-testid={`${idPrefix}-verification-editor`}>
      <div className="contract-section-heading">
        <div>
          <strong>Verification checks</strong>
          <span>Each check executes on the runner inside the assigned worktree.</span>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={policy.checks.length >= 16}
          onClick={() => {
            setSelectedCheckIndex(policy.checks.length)
            onChange(appendVerifierCheck(policy))
          }}
        >
          Add check
        </button>
      </div>
      {policy.checks.length ? (
        <>
          <nav className="verification-check-tabs" aria-label="Verifier checks">
            {policy.checks.map((check, index) => (
              <button
                key={`${check.type}-${index}`}
                type="button"
                className={selectedIndex === index ? 'check-tab-active' : ''}
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedCheckIndex(index)}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{verificationTypeLabel(check.type)}</strong>
              </button>
            ))}
          </nav>
          {selectedCheck ? (
            <VerifierCheckEditor
              check={selectedCheck}
              index={selectedIndex}
              onChange={(check) => replaceCheck(selectedIndex, check)}
              onRemove={() => removeCheck(selectedIndex)}
            />
          ) : null}
        </>
      ) : (
        <div className="default-gate-callout">
          <span>NO CHECKS</span>
          <strong>Add a victory gate</strong>
        </div>
      )}
      <ManualGateEditor policy={policy} onChange={onChange} />
      {errors.length ? <p className="contract-error">{errors[0]}</p> : null}
      <details className="verification-plan-disclosure">
        <summary>Preview exact completion plan</summary>
        <VerificationPolicyPreview policy={policy} heading="Exact completion plan" />
      </details>
    </div>
  )
}
