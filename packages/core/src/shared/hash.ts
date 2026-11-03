import { createHash } from 'node:crypto'

/** Lowercase, collapse whitespace, drop trailing punctuation. Used before hashing. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.;,]+$/, '')
    .trim()
}

/** Deterministic short id from normalized parts, e.g. `b_3f9a1c02de`. */
export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha1')
    .update(parts.map(normalizeText).join('\u0000'))
    .digest('hex')
    .slice(0, 10)
  return `${prefix}_${digest}`
}

/** Version token for a set of file contents. Changes when any content changes. */
export function contentVersion(contents: string[]): string {
  const hash = createHash('sha1')
  for (const c of contents) hash.update(c.replace(/\r\n/g, '\n')).update('\u0000')
  return hash.digest('hex').slice(0, 12)
}
