import { createHash } from 'node:crypto'

// Keep capability equality observable without publishing authority-bearing values.
export function redactEvidenceCapabilities(value) {
  if (Array.isArray(value)) return value.map(redactEvidenceCapabilities)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /capabilit(?:y|ies)|(?:^|_)(?:token|secret|password|credential)(?:$|_)/iu.test(key) && entry !== null
      ? { redacted: 'sha256', digest: createHash('sha256').update(JSON.stringify(entry)).digest('hex') }
      : redactEvidenceCapabilities(entry),
  ]))
}
