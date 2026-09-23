export type VerifierCacheSuppression = 'python_interpreter' | 'python_environment' | 'node_compile_cache'

export type VerifierCheck =
  | { type: 'artifact'; min_bytes: number }
  | { type: 'file'; path: string; min_bytes: number }
  | { type: 'command'; program: string; args: string[]; timeout_ms: number; cache_suppression?: VerifierCacheSuppression | null }
  | { type: 'test'; program: string; args: string[]; timeout_ms: number; cache_suppression?: VerifierCacheSuppression | null }
  | { type: 'json_schema'; path: string; required_keys: string[] }
  | { type: 'screenshot'; path: string; min_bytes: number }

export type ManualVerificationGate =
  | { type: 'human_approval'; roles: string[] }
  | { type: 'independent_review'; roles: string[]; exclude_requester: boolean }

export type VerificationPolicy = {
  checks: VerifierCheck[]
  manual_gate: ManualVerificationGate | null
}

export function defaultVerifierCheck(type: VerifierCheck['type'] = 'artifact'): VerifierCheck {
  if (type === 'artifact') return { type, min_bytes: 1 }
  if (type === 'file') return { type, path: 'README.md', min_bytes: 1 }
  if (type === 'screenshot') {
    return { type, path: 'evidence/browser.png', min_bytes: 1_000 }
  }
  if (type === 'json_schema') {
    return { type, path: 'evidence/result.json', required_keys: ['status'] }
  }
  return {
    type,
    program: type === 'test' ? 'pnpm' : 'git',
    args: type === 'test' ? ['test'] : ['status', '--short'],
    timeout_ms: 60_000,
  }
}

export function verifierCheckSummary(check: VerifierCheck): string {
  if (check.type === 'artifact') {
    return `Provider artifact · at least ${check.min_bytes.toLocaleString()} ${check.min_bytes === 1 ? 'byte' : 'bytes'}`
  }
  if (check.type === 'file') {
    return `File ${check.path} · at least ${check.min_bytes.toLocaleString()} ${check.min_bytes === 1 ? 'byte' : 'bytes'}`
  }
  if (check.type === 'screenshot') {
    return `Screenshot ${check.path} · at least ${check.min_bytes.toLocaleString()} ${check.min_bytes === 1 ? 'byte' : 'bytes'}`
  }
  if (check.type === 'json_schema') {
    return `JSON ${check.path} · keys: ${JSON.stringify(check.required_keys)}`
  }
  const summary = `${check.type === 'test' ? 'Test' : 'Command'} · ${JSON.stringify([check.program, ...check.args])} · ${Math.round(check.timeout_ms / 1_000)}s`
  if (check.cache_suppression == null) return summary
  const labels: Record<VerifierCacheSuppression, string> = {
    python_interpreter: 'Python interpreter (-B)',
    python_environment: 'Python environment',
    node_compile_cache: 'Node compile cache',
  }
  return `${summary} · Requested cache control: ${labels[check.cache_suppression]} (requires a compatible runner)`
}

export function verificationPolicyErrors(policy: VerificationPolicy): string[] {
  const errors: string[] = []
  if (!policy.checks.length) errors.push('Add at least one verifier check.')
  if (policy.checks.length > 16) errors.push('Verifier policies support at most 16 checks.')
  policy.checks.forEach((check, index) => {
    const label = `Check ${index + 1}`
    if ('min_bytes' in check && (!Number.isFinite(check.min_bytes) || check.min_bytes < 1)) {
      errors.push(`${label} needs a positive byte floor.`)
    }
    if ('path' in check && !check.path.trim()) errors.push(`${label} needs a repository path.`)
    if ((check.type === 'command' || check.type === 'test') && !check.program.trim()) {
      errors.push(`${label} needs an executable program.`)
    }
    if (
      (check.type === 'command' || check.type === 'test') &&
      (!Number.isFinite(check.timeout_ms) || check.timeout_ms < 100 || check.timeout_ms > 60_000)
    ) {
      errors.push(`${label} timeout must be between 100 and 60,000 ms.`)
    }
    if (check.type === 'json_schema' && !check.required_keys.length) {
      errors.push(`${label} needs at least one required JSON key.`)
    }
  })
  if (policy.manual_gate && !policy.manual_gate.roles.length) {
    errors.push('The manual gate needs at least one eligible role.')
  } else if (
    policy.manual_gate?.roles.some(
      (role) => !['owner', 'admin', 'manager', 'member'].includes(role),
    )
  ) {
    errors.push('Manual-gate roles must be owner, admin, manager, or member.')
  }
  return errors
}


// Editing only produces a new draft. The caller retains persistence/authorization,
// and the server and runner remain authoritative for the full verifier contract.
export function appendVerifierCheck(policy: VerificationPolicy): VerificationPolicy {
  return { ...policy, checks: [...policy.checks, defaultVerifierCheck('file')] }
}

export function replaceVerifierCheck(
  policy: VerificationPolicy,
  index: number,
  check: VerifierCheck,
): VerificationPolicy {
  const checks = policy.checks.slice()
  checks[index] = check
  return { ...policy, checks }
}

export function removeVerifierCheck(policy: VerificationPolicy, index: number): VerificationPolicy {
  return { ...policy, checks: policy.checks.filter((_, candidate) => candidate !== index) }
}

export function setManualVerificationGate(
  policy: VerificationPolicy,
  type: 'none' | ManualVerificationGate['type'],
): VerificationPolicy {
  const manual_gate: ManualVerificationGate | null = type === 'none' ? null
    : type === 'human_approval' ? { type, roles: ['owner', 'admin'] }
    : { type, roles: ['member', 'manager', 'admin', 'owner'], exclude_requester: true }
  return { ...policy, manual_gate }
}

export function verificationTypeLabel(type: VerifierCheck['type'] | ManualVerificationGate['type']): string {
  return type.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
